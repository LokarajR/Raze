'use strict';

/**
 * Raze MCP — the merchant's side of the payment, exposed to an agent.
 *
 * Every published payment MCP is provider access: create an order, fetch a
 * payment, issue a refund, list webhook subscriptions. That answers "what does
 * the provider say". None of them answer the question a merchant actually loses
 * money on:
 *
 *   this event was delivered twice after our process crashed — does exactly one
 *   entitlement, one invoice, one ledger posting exist in OUR database?
 *
 * That question needs an engine, not an API wrapper: a durable inbox, dedupe on
 * provider event identity, a state machine that refuses illegal transitions,
 * an outbox for side effects, and reconciliation against provider truth. Raze
 * has those already and they are tested. This file is the interface to them, not
 * a reimplementation.
 *
 * TWO RULES THAT SHAPE EVERY TOOL HERE
 *
 * Reading is free; writing is not. An agent may inspect anything — the raw
 * bytes, the verification outcome, the dedupe decision, the divergence from
 * Razorpay. Nothing that changes merchant state happens without a plan being
 * produced first and a human approving that exact plan.
 *
 * A proposal is not a promise. State can move between proposing a recovery and
 * approving it, so the plan is re-derived at apply time and refused if it no
 * longer matches what was approved. Applying a stale plan is how an approval
 * flow quietly becomes a rubber stamp.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { z } = require('zod');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const RAZE = path.join(__dirname, '..', '..');
const { connect, migrate } = require(path.join(RAZE, 'src', 'db'));
const { createAuditor } = require(path.join(RAZE, 'src', 'audit'));
const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
const { createLedger } = require(path.join(RAZE, 'src', 'ledger'));
const { scan } = require(path.join(RAZE, 'src', 'patterns'));
const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
const { resolveDemoSecret } = require(path.join(RAZE, 'src', 'secret'));

const LOG = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

let poolPromise = null;
function db() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const { pool } = await connect();
      await migrate(pool);
      return pool;
    })();
  }
  return poolPromise;
}

const env = process.env;
const razorpay = { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
const haveRazorpay = !!(razorpay.keyId && razorpay.keySecret);
const ORDERS_TABLE = env.RAZE_ORDERS_TABLE || 'shop_orders';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (message, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }],
  isError: true,
});

async function razorpayGet(pathname) {
  if (!haveRazorpay) return { available: false, reason: 'no Razorpay credentials configured' };
  const auth = 'Basic ' + Buffer.from(`${razorpay.keyId}:${razorpay.keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${pathname}`, { headers: { authorization: auth } });
  const body = await res.json();
  if (!res.ok) return { available: false, reason: body.error?.description || `HTTP ${res.status}` };
  return { available: true, body };
}

// ---------------------------------------------------------------------------
// the approval gate
// ---------------------------------------------------------------------------

/**
 * Plans awaiting approval.
 *
 * In memory and short-lived on purpose. A token that survives a restart is a
 * standing authorisation to move money, which is not what an approval is.
 */
const PENDING = new Map();
const APPROVAL_TTL_MS = 10 * 60 * 1000;

function issuePlan(kind, subject, steps, fingerprint) {
  const token = crypto.randomBytes(16).toString('hex');
  PENDING.set(token, { kind, subject, steps, fingerprint, at: Date.now() });
  for (const [k, v] of PENDING) if (Date.now() - v.at > APPROVAL_TTL_MS) PENDING.delete(k);
  return token;
}

function takePlan(token) {
  const plan = PENDING.get(token);
  if (!plan) return { error: 'unknown or expired approval token — propose the recovery again' };
  if (Date.now() - plan.at > APPROVAL_TTL_MS) {
    PENDING.delete(token);
    return { error: 'approval expired — propose the recovery again' };
  }
  return { plan };
}

// ---------------------------------------------------------------------------
// the trail
// ---------------------------------------------------------------------------

/**
 * Everything known about one order, from three independent sources.
 *
 * The point is the disagreement between them. Razorpay's record, the raw
 * deliveries Raze holds, and the merchant's own row are gathered separately and
 * compared; a tool that merged them would hide exactly the divergence a merchant
 * needs to see.
 */
async function orderTrail(orderId) {
  const pool = await db();
  const out = { order_id: orderId };

  // 1. what Razorpay says
  if (haveRazorpay) {
    const r = await razorpayGet(`/orders/${encodeURIComponent(orderId)}/payments`);
    out.razorpay = r.available
      ? {
          payments: (r.body.items || []).map((p) => ({
            id: p.id, status: p.status, amount: p.amount, method: p.method,
            created_at: new Date(p.created_at * 1000).toISOString(),
          })),
          settled: (r.body.items || []).some((p) => p.status === 'captured' || p.status === 'refunded'),
        }
      : { unavailable: r.reason };
  } else {
    out.razorpay = { unavailable: 'no Razorpay credentials configured' };
  }

  // 2. what Raze received and what it did with it
  try {
    const inbox = await pool.query(
      `SELECT event_id, event_type, received_at, processed_at, process_attempts,
              octet_length(raw_body) AS bytes, raw_body_sha256, source
         FROM raze_inbox WHERE subject_id = $1 ORDER BY received_at`,
      [orderId]
    );
    out.deliveries = inbox.rows.map((r) => ({
      event_id: r.event_id,
      event_type: r.event_type,
      received_at: r.received_at,
      applied: !!r.processed_at,
      attempts: r.process_attempts,
      bytes: Number(r.bytes),
      sha256: String(r.raw_body_sha256 || '').slice(0, 16),
      source: r.source,
    }));
    const ids = new Set(out.deliveries.map((d) => d.event_id));
    out.dedupe = {
      deliveries_received: out.deliveries.length,
      distinct_event_ids: ids.size,
      applied: out.deliveries.filter((d) => d.applied).length,
      note: out.deliveries.length > ids.size
        ? 'repeat deliveries of the same event id were received and collapsed'
        : 'no repeat deliveries recorded for this order',
    };
  } catch (err) {
    out.deliveries = [];
    out.dedupe = { unavailable: err.message };
  }

  // 3. the state machine's view
  try {
    const st = await pool.query(
      'SELECT subject_id, rank, event_type, updated_at FROM raze_subject_state WHERE subject_id = $1',
      [orderId]
    );
    out.state_machine = st.rows[0] || null;
  } catch { out.state_machine = null; }

  // 4. the merchant's own row
  try {
    const m = await pool.query(
      `SELECT status, credited_paise, credit_count FROM "${ORDERS_TABLE}" WHERE order_id = $1`,
      [orderId]
    );
    out.merchant = m.rows[0]
      ? {
          status: m.rows[0].status,
          credited_paise: Number(m.rows[0].credited_paise),
          credit_count: Number(m.rows[0].credit_count),
        }
      : null;
  } catch (err) { out.merchant = { unavailable: err.message }; }

  // 5. the verdict, stated as a disagreement rather than a diagnosis
  const providerSettled = out.razorpay && out.razorpay.settled;
  const merchantApplied = out.merchant && Number(out.merchant.credited_paise) > 0;
  if (providerSettled && !merchantApplied) {
    out.verdict = {
      divergent: true,
      summary: 'Razorpay recorded a settled payment for this order; the merchant has not '
        + 'applied it. Money moved and the business state does not reflect it.',
      recommended: 'raze_propose_recovery',
    };
  } else if (!providerSettled && merchantApplied) {
    out.verdict = {
      divergent: true,
      summary: 'The merchant applied credit for an order Razorpay has no settled payment for. '
        + 'This is the shape a forged or double-applied delivery leaves behind.',
      recommended: 'inspect the deliveries above before changing anything',
    };
  } else if (out.merchant && out.merchant.credit_count > 1) {
    out.verdict = {
      divergent: true,
      summary: `Applied ${out.merchant.credit_count} times for one payment.`,
      recommended: 'inspect the deliveries above before changing anything',
    };
  } else {
    out.verdict = { divergent: false, summary: 'Provider record and merchant state agree.' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer(
    { name: 'raze', version: '0.1.0' },
    {
      instructions:
        'Raze is the merchant side of a payment, not provider API access. Use it to ask what '
        + 'happened to a merchant\'s own order state after Razorpay events arrived: what was '
        + 'delivered, what was deduplicated, what was applied, and where the merchant\'s '
        + 'database disagrees with Razorpay. Reads are free. Nothing that changes merchant '
        + 'state happens without raze_propose_recovery producing a plan and a human approving '
        + 'that exact plan through raze_apply_recovery.',
    }
  );

  // ---- 1. the trail ------------------------------------------------------
  server.registerTool('raze_explain_order', {
    title: 'Explain an order',
    description:
      'The complete event-to-business-effect trail for one order, from three independent '
      + 'sources: what Razorpay recorded, what Raze received and deduplicated, and what the '
      + 'merchant\'s own table says. Reports the disagreement between them rather than merging '
      + 'them. Read-only.',
    inputSchema: { order_id: z.string().describe('Razorpay order id, e.g. order_abc123') },
  }, async ({ order_id }) => {
    try { return ok(await orderTrail(order_id)); }
    catch (err) { return fail(err.message); }
  });

  // ---- 2. the inbox ------------------------------------------------------
  server.registerTool('raze_event_trail', {
    title: 'Recent deliveries',
    description:
      'Recent webhook deliveries as Raze durably recorded them, before any business processing: '
      + 'event id, type, byte length, hash of the raw body, attempts, and whether the effect was '
      + 'applied. This is the durable record provider MCPs do not hold. Read-only.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(40).describe('how many to return'),
      unapplied_only: z.boolean().default(false).describe('only deliveries whose effect has not been applied'),
    },
  }, async ({ limit, unapplied_only }) => {
    try {
      const pool = await db();
      const r = await pool.query(
        `SELECT event_id, event_type, subject_id, received_at, processed_at, process_attempts,
                octet_length(raw_body) AS bytes, source
           FROM raze_inbox
          ${unapplied_only ? 'WHERE processed_at IS NULL' : ''}
          ORDER BY received_at DESC LIMIT $1`,
        [limit]
      );
      return ok({
        count: r.rowCount,
        deliveries: r.rows.map((x) => ({
          event_id: x.event_id, event_type: x.event_type, subject_id: x.subject_id,
          received_at: x.received_at, applied: !!x.processed_at,
          attempts: x.process_attempts, bytes: Number(x.bytes), source: x.source,
        })),
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 3. read the merchant's code --------------------------------------
  server.registerTool('raze_inspect_integration', {
    title: 'Inspect integration code',
    description:
      'Read a merchant\'s webhook handler and report known defects with the file, the line and '
      + 'the evidence — missing dedupe on the event id, signature verified over re-serialised '
      + 'JSON, and others. Matching nothing means unrecognised, not correct. Nothing is executed '
      + 'and nothing is written.',
    inputSchema: {
      path: z.string().describe('absolute path to a file or directory containing the handler'),
    },
  }, async ({ path: target }) => {
    try {
      if (!fs.existsSync(target)) return fail(`no such path: ${target}`);
      const files = [];
      const stat = fs.statSync(target);
      if (stat.isFile()) files.push(target);
      else {
        const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
        (function walk(dir, depth) {
          if (depth > 6) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!skip.has(e.name)) walk(full, depth + 1); continue; }
            if (/\.(js|ts|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) files.push(full);
          }
        })(target, 0);
      }

      const results = [];
      for (const f of files) {
        let src;
        try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (src.length > 400000) continue;
        const hits = scan(src);
        if (hits.length === 0) continue;
        results.push({
          file: f,
          findings: hits.map((h) => ({
            id: h.pattern.id, title: h.pattern.title, evidence: h.evidence,
            line: h.line || null, would_fail: h.pattern.fixes || [], repairable: !!h.repairable,
          })),
        });
      }
      return ok({
        files_read: files.length,
        files_with_findings: results.length,
        results,
        note: results.length === 0
          ? 'No known pattern matched. That means unrecognised, not correct — raze_audit_endpoint '
            + 'tests behaviour rather than shape.'
          : undefined,
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 4. test the behaviour, not the shape ------------------------------
  server.registerTool('raze_audit_endpoint', {
    title: 'Audit a running endpoint',
    description:
      'Fire five real captured Razorpay deliveries at a running webhook endpoint — a duplicate, '
      + 'a refund ladder, a forged signature, an out-of-order lifecycle and a timeout-induced '
      + 'retry — then read the result out of the merchant\'s own table. Tests behaviour, not '
      + 'code shape. Writes to the merchant\'s database because that is what a delivery does; '
      + 'point it at a test environment.',
    inputSchema: {
      target_url: z.string().describe('the webhook endpoint to probe, e.g. http://127.0.0.1:4100/webhook'),
      webhook_secret: z.string().optional().describe('the secret the target verifies with; a demo secret is used if omitted'),
    },
  }, async ({ target_url, webhook_secret }) => {
    try {
      const pool = await db();
      const secret = webhook_secret || resolveDemoSecret(env).secret;
      const auditor = createAuditor({ targetUrl: target_url, pool, logFile: LOG, webhookSecret: secret });
      const results = await auditor.run();
      const impact = await computeImpact({ pool, razorpay, results, table: ORDERS_TABLE });
      return ok({
        target: target_url,
        passed: results.filter((r) => r.pass).length,
        total: results.length,
        probes: results.map((r) => ({
          name: r.name, title: r.title, pass: r.pass, skipped: !!r.skipped,
          observed: r.observed, why: r.pass ? undefined : r.why, evidence: r.evidence,
        })),
        money: {
          credited_without_payment_paise: impact.measured.phantomCreditPaise,
          orders_corrupted: impact.measured.corruptedOrders,
          source: impact.measured.source,
        },
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 5. provider truth vs merchant truth -------------------------------
  server.registerTool('raze_find_divergence', {
    title: 'Find divergence from Razorpay',
    description:
      'Ask Razorpay what it recorded and compare it against the merchant\'s own table. Returns '
      + 'settled payments the merchant never applied — the ones whose webhooks were answered '
      + 'with 200 and lost anyway. Read-only: it detects, it does not repair.',
    inputSchema: {
      window_hours: z.number().int().min(1).max(720).default(72).describe('how far back to look'),
    },
  }, async ({ window_hours }) => {
    if (!haveRazorpay) return fail('no Razorpay credentials configured (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)');
    try {
      const pool = await db();
      const impact = await computeImpact({ pool, razorpay, results: [], table: ORDERS_TABLE });
      const rz = impact.razorpay;
      if (!rz.available) return fail(rz.reason);
      return ok({
        window_hours,
        captured_at_razorpay: rz.capturedCount,
        not_applied_by_merchant: rz.unrecorded.length,
        at_risk_paise: rz.unrecordedPaise,
        orders: rz.unrecorded,
        expectations: impact.expectations,
        next: rz.unrecorded.length
          ? 'raze_propose_recovery for any order above'
          : 'nothing diverged in this window',
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 6. simulate --------------------------------------------------------
  server.registerTool('raze_simulate_recovery', {
    title: 'Simulate, changing nothing',
    description:
      'Say what recovering an order would do, without doing it: the current merchant state, the '
      + 'state it would move to, and whether that transition is legal for the state machine. '
      + 'Writes nothing and needs no approval.',
    inputSchema: { order_id: z.string().describe('Razorpay order id') },
  }, async ({ order_id }) => {
    try {
      const trail = await orderTrail(order_id);
      const settled = trail.razorpay && trail.razorpay.settled;
      const payment = settled ? trail.razorpay.payments.find((p) => p.status === 'captured' || p.status === 'refunded') : null;
      return ok({
        order_id,
        would_change: !!(settled && (!trail.merchant || trail.merchant.credited_paise === 0)),
        current: trail.merchant,
        would_become: payment
          ? { status: 'paid', credited_paise: payment.amount, credit_count: 1 }
          : null,
        legal_transition: !trail.merchant || trail.merchant.status !== 'refunded',
        basis: payment
          ? `Razorpay payment ${payment.id} is ${payment.status} for ${payment.amount} paise`
          : 'Razorpay has no settled payment for this order — nothing to recover',
        note: 'Nothing was written. raze_propose_recovery produces an approvable plan.',
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 7. propose --------------------------------------------------------
  server.registerTool('raze_propose_recovery', {
    title: 'Propose a recovery',
    description:
      'Produce a recovery plan and an approval token. Writes nothing. The plan is bound to the '
      + 'exact state it was derived from, so it cannot be applied later against different state.',
    inputSchema: { order_id: z.string().describe('Razorpay order id') },
  }, async ({ order_id }) => {
    if (!haveRazorpay) return fail('no Razorpay credentials configured');
    try {
      const trail = await orderTrail(order_id);
      if (!trail.razorpay || !trail.razorpay.settled) {
        return fail('Razorpay has no settled payment for this order — there is nothing to recover',
          { order_id, razorpay: trail.razorpay });
      }
      if (trail.merchant && Number(trail.merchant.credited_paise) > 0) {
        return fail('the merchant has already applied this payment — recovering again would double-apply',
          { order_id, merchant: trail.merchant });
      }
      const payment = trail.razorpay.payments.find((p) => p.status === 'captured' || p.status === 'refunded');
      const steps = [
        `set ${ORDERS_TABLE}.status = 'paid' for order ${order_id}`,
        `set credited_paise = ${payment.amount} (from Razorpay payment ${payment.id})`,
        'set credit_count = 1',
        'record the transition in raze_subject_state so a later delivery cannot re-apply it',
      ];
      // Bound to the state it was derived from. If anything moves, the approval
      // no longer describes reality and must not be honoured.
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        order_id, payment: payment.id, amount: payment.amount,
        merchant: trail.merchant || null,
      })).digest('hex');

      const token = issuePlan('recover-order', order_id, steps, fingerprint);
      return ok({
        order_id,
        plan: steps,
        payment: { id: payment.id, status: payment.status, amount_paise: payment.amount },
        approval_token: token,
        expires_in_seconds: APPROVAL_TTL_MS / 1000,
        warning: 'This changes merchant business state. A human should confirm it before '
          + 'raze_apply_recovery is called with this token.',
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 8. apply, only with approval --------------------------------------
  server.registerTool('raze_apply_recovery', {
    title: 'Apply an approved recovery',
    description:
      'Apply a plan produced by raze_propose_recovery. Requires the approval token for that '
      + 'exact plan. The plan is re-derived first and refused if the state has moved since it '
      + 'was approved. This is the only tool here that changes merchant state.',
    inputSchema: {
      order_id: z.string().describe('Razorpay order id'),
      approval_token: z.string().describe('the token returned by raze_propose_recovery'),
    },
  }, async ({ order_id, approval_token }) => {
    const taken = takePlan(approval_token);
    if (taken.error) return fail(taken.error);
    const { plan } = taken;
    if (plan.subject !== order_id) {
      return fail('this approval token was issued for a different order', { approved_for: plan.subject });
    }

    try {
      const trail = await orderTrail(order_id);
      const payment = trail.razorpay && trail.razorpay.settled
        ? trail.razorpay.payments.find((p) => p.status === 'captured' || p.status === 'refunded')
        : null;
      if (!payment) return fail('Razorpay no longer reports a settled payment for this order');

      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        order_id, payment: payment.id, amount: payment.amount,
        merchant: trail.merchant || null,
      })).digest('hex');

      if (fingerprint !== plan.fingerprint) {
        PENDING.delete(approval_token);
        return fail('state changed after this plan was approved — the approval no longer describes '
          + 'what would happen. Propose the recovery again.',
          { approved_state: plan.steps, current_merchant: trail.merchant });
      }

      const pool = await db();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO "${ORDERS_TABLE}" (order_id, status, credited_paise, credit_count)
           VALUES ($1,'paid',$2,1)
           ON CONFLICT (order_id) DO UPDATE
             SET status='paid',
                 credited_paise = EXCLUDED.credited_paise,
                 credit_count   = 1`,
          [order_id, payment.amount]
        );
        // The same row and the same rank the runtime would have written for a
        // payment.captured delivery, so a later real delivery of that event is
        // recognised as stale instead of applying the credit again.
        await client.query(
          `INSERT INTO raze_subject_state (subject_id, rank, event_type)
           VALUES ($1, 2, 'payment.captured')
           ON CONFLICT (subject_id) DO UPDATE
             SET rank = GREATEST(raze_subject_state.rank, EXCLUDED.rank),
                 event_type = EXCLUDED.event_type,
                 updated_at = now()`,
          [order_id]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }

      PENDING.delete(approval_token);
      const after = await orderTrail(order_id);
      return ok({
        order_id,
        applied: plan.steps,
        merchant_now: after.merchant,
        verdict: after.verdict,
        note: 'Recorded in raze_subject_state, so a later delivery of the same event cannot '
          + 'apply it a second time.',
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 9. the absence case ----------------------------------------------
  server.registerTool('raze_sweep_expectations', {
    title: 'Name what never arrived',
    description:
      'Sweep overdue expectations and separate three outcomes reconciliation cannot tell apart: '
      + 'recovered (the payment exists and was missed), failed (the customer\'s payment was '
      + 'declined) and abandoned (the customer never paid — not a delivery failure and not lost '
      + 'revenue). Reads Razorpay; resolves expectation rows.',
    inputSchema: {},
  }, async () => {
    if (!haveRazorpay) return fail('no Razorpay credentials configured');
    try {
      const pool = await db();
      const ledger = createLedger({ db: pool, razorpay });
      const out = await ledger.sweepOnce();
      return ok({
        checked: out.checked, recovered: out.recovered, failed: out.failed,
        abandoned: out.abandoned, unknown: out.unknown,
        note: 'abandoned is not revenue loss. An unresolvable lookup stays open rather than '
          + 'being guessed at.',
      });
    } catch (err) { return fail(err.message); }
  });

  return server;
}

async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

module.exports = { buildServer, orderTrail, main };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`raze-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
