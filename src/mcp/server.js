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

      // The repair goes in as a delivery, not as an UPDATE.
      //
      // Writing the merchant's row directly here would be a second code path
      // for the same outcome, and a repair that does not run the logic a real
      // delivery runs is a repair nobody should trust. Reconciliation already
      // does it correctly — synthesize the event Razorpay would have sent and
      // put it in the inbox, so it is deduplicated, ordered and applied by
      // exactly the same worker, inside the same transaction, as live traffic.
      //
      // The synthetic event id is derived from the payment id, so approving the
      // same recovery twice inserts nothing the second time.
      const pool = await db();
      const event = {
        event: 'payment.captured',
        _raze_synthetic: true,
        _raze_note: 'reconstructed from the Razorpay API after an approved recovery',
        // orderTrail returns a trimmed view of the payment for reading; the
        // entity a mapping resolves against needs the fields a real delivery
        // carries. order_id above all: without it the key path resolves to
        // nothing, the mapping writes nothing, and the inbox row is still
        // marked applied — a repair that reports success and does nothing.
        payload: { payment: { entity: { ...payment, order_id } } },
      };
      const raw = Buffer.from(JSON.stringify(event), 'utf8');
      const sha = crypto.createHash('sha256').update(raw).digest('hex');
      const eventId = 'recon_' + payment.id;

      const ins = await pool.query(
        `INSERT INTO raze_inbox
           (event_id, event_type, raw_body, raw_body_sha256, signature, headers, subject_id, source)
         VALUES ($1,'payment.captured',$2,$3,NULL,'{}'::jsonb,$4,'recovery')
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, raw, sha, order_id]
      );

      // Drain it through the runtime the merchant already runs, so the mapping,
      // the state machine and the guards all apply.
      const raze = require(path.join(RAZE, 'src', 'runtime'));
      const rz = raze.create({ db: pool, webhookSecret: resolveDemoSecret(env).secret });
      const mapping = require(path.join(RAZE, 'src', 'mapping'));
      const m = mapping.attach(rz, pool);
      await m.map('payment.captured', {
        table: ORDERS_TABLE,
        key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
        set: { status: { literal: 'paid' } },
        add: { credited_paise: 'payload.payment.entity.amount', credit_count: { literal: 1 } },
        guard: { column: 'status', notIn: ['refunded'] },
      });
      await rz.drain();

      PENDING.delete(approval_token);
      const after = await orderTrail(order_id);

      // Report what actually happened, not what was attempted.
      //
      // The synthetic event id is shared with reconciliation on purpose: one
      // identity per payment is what stops the two paths crediting the same
      // money twice. The consequence is that a payment reconciliation already
      // applied makes this insert a no-op — which is right, and must be said
      // rather than reported as a fresh repair.
      const landed = !!(after.merchant && Number(after.merchant.credited_paise) > 0);
      const wasNew = ins.rowCount > 0;

      if (!landed) {
        return fail(
          wasNew
            ? 'The repair was queued and processed but the order still does not reflect the '
              + 'payment. The mapping may not match this table.'
            : 'Nothing was applied: this payment was already taken in by an earlier '
              + 'reconciliation, so there was no new work to do — but the order still does '
              + 'not reflect it, which means the earlier attempt did not land either.',
          { order_id, merchant: after.merchant, already_taken_in: !wasNew }
        );
      }

      return ok({
        order_id,
        applied: plan.steps,
        merchant_now: after.merchant,
        verdict: after.verdict,
        route: wasNew
          ? 'Queued as a delivery and applied by the same worker that handles live webhooks.'
          : 'Already taken in by an earlier reconciliation; state confirmed, nothing re-applied.',
        note: 'One event identity per payment, shared with reconciliation, so neither path '
          + 'can credit this money twice.',
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

  // ---- 10. is this merchant protected, right now ------------------------
  server.registerTool('raze_health', {
    title: 'Payment protection health',
    description:
      'Seven checks answering whether this merchant is actually protected: signature '
      + 'verification, duplicate safety, retry safety, state transitions, refunds, '
      + 'reconciliation, and whether anything would notice a payment that never arrives. '
      + 'Each is the outcome of a real delivery or a real query, never a configuration '
      + 'check. Fires real deliveries at the endpoint, so point it at a test environment.',
    inputSchema: {
      target_url: z.string().describe('the merchant webhook endpoint to test'),
      webhook_secret: z.string().optional().describe('the secret the endpoint verifies with'),
    },
  }, async ({ target_url, webhook_secret }) => {
    try {
      const pool = await db();
      const { computeHealth } = require(path.join(RAZE, 'src', 'health'));
      const out = await computeHealth({
        pool, razorpay,
        targetUrl: target_url,
        webhookSecret: webhook_secret || resolveDemoSecret(env).secret,
        logFile: LOG,
        ordersTable: ORDERS_TABLE,
      });
      return ok(out);
    } catch (err) { return fail(err.message); }
  });

  // ---- 11. read the merchant's schema, propose the mapping ---------------
  server.registerTool('raze_propose_mapping', {
    title: 'Work out this merchant\'s payment model',
    description:
      'Read the merchant\'s own schema and propose how Razorpay events map onto it — which '
      + 'table holds orders, which column carries the Razorpay order id, what each event '
      + 'should set. Compares information_schema against the field paths present in 796 real '
      + 'captured deliveries: name and type matching, deterministic, no model, the same '
      + 'answer every time. Writes nothing. Anything it cannot decide is returned as a '
      + 'question rather than a guess.',
    inputSchema: {
      database_url: z.string().optional()
        .describe('the merchant database; defaults to the one this server is connected to'),
    },
  }, async ({ database_url }) => {
    let ownPool = null;
    try {
      const infer = require(path.join(RAZE, 'src', 'infer'));
      let target;
      if (database_url) {
        const { Pool } = require('pg');
        ownPool = new Pool({ connectionString: database_url, max: 4 });
        ownPool.on('error', () => {});
        await ownPool.query('SELECT 1');
        target = ownPool;
      } else {
        target = await db();
      }

      const out = await infer.infer({ pool: target, corpusPath: LOG });

      // Several order-shaped tables produce a proposal each, which is correct
      // and unusable. Score them so the strongest is named — but return them
      // all, because silently picking the wrong table is the failure that costs
      // money.
      const score = (p) => Object.keys(p.spec.set || {}).length
        + Object.keys(p.spec.add || {}).length * 2
        + (p.spec.guard ? 2 : 0)
        + (/razorpay/i.test(p.spec.key.column) ? 3 : 0);
      const byTable = new Map();
      for (const p of out.proposals) byTable.set(p.spec.table, (byTable.get(p.spec.table) || 0) + score(p));
      const ranked = [...byTable.entries()].sort((a, b) => b[1] - a[1]);
      const best = ranked.length ? ranked[0][0] : null;

      return ok({
        tables: out.schema.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })),
        best_table: best,
        ranking: ranked.map(([table, sc]) => ({ table, score: sc })),
        proposals: out.proposals.map((p) => ({
          id: p.eventType + '|' + p.spec.table,
          recommended: p.spec.table === best,
          eventType: p.eventType,
          spec: p.spec,
          evidence: p.evidence,
          questions: p.questions,
        })),
        next: out.proposals.length
          ? 'Show the recommended mappings to the merchant. raze_apply_mapping arms the ones '
            + 'they approve.'
          : 'No table matched a Razorpay event shape. Do not invent one — ask which table '
            + 'holds their orders.',
      });
    } catch (err) { return fail(err.message); }
    finally { if (ownPool) await ownPool.end().catch(() => {}); }
  });

  // ---- 12. arm the mapping the merchant approved ------------------------
  server.registerTool('raze_apply_mapping', {
    title: 'Arm an approved mapping',
    description:
      'Validate the chosen mappings against the live schema and write them to a mapping file '
      + 'the merchant can read, edit and commit. Call only after a human has seen the '
      + 'proposals and said which to accept — this decides what every future delivery does '
      + 'to their database.',
    inputSchema: {
      accept: z.array(z.string()).describe('proposal ids from raze_propose_mapping, e.g. "payment.captured|orders"'),
      database_url: z.string().optional().describe('the merchant database'),
      write_to: z.string().optional().describe('path to write the mapping file to'),
    },
  }, async ({ accept, database_url, write_to }) => {
    if (!accept || !accept.length) return fail('nothing was accepted');
    let ownPool = null;
    try {
      const infer = require(path.join(RAZE, 'src', 'infer'));
      const mapping = require(path.join(RAZE, 'src', 'mapping'));
      let target;
      if (database_url) {
        const { Pool } = require('pg');
        ownPool = new Pool({ connectionString: database_url, max: 4 });
        ownPool.on('error', () => {});
        target = ownPool;
      } else {
        target = await db();
      }

      const out = await infer.infer({ pool: target, corpusPath: LOG });
      const wanted = new Set(accept);
      const chosen = out.proposals.filter((p) => wanted.has(p.eventType + '|' + p.spec.table));
      if (!chosen.length) return fail('none of those ids match a current proposal', { accept });

      // A mapping naming a column that does not exist has to fail here, loudly,
      // rather than silently writing nothing on every future delivery.
      const armed = [];
      for (const p of chosen) {
        const spec = mapping.normalise(p.eventType, p.spec);
        await mapping.validateAgainstSchema(target, spec);
        armed.push({ eventType: p.eventType, table: spec.table });
      }

      let written = null;
      if (write_to) {
        const src = infer.render(chosen, { corpusPath: LOG });
        fs.writeFileSync(write_to, src);
        written = write_to;
      }
      return ok({
        armed,
        written,
        note: 'Validated against the live schema. ' + (written
          ? 'The mapping file is the merchant\'s to read and commit.'
          : 'Pass write_to to also emit the mapping file.'),
      });
    } catch (err) { return fail(err.message); }
    finally { if (ownPool) await ownPool.end().catch(() => {}); }
  });

  // ---- 13. notice payments that never arrive ----------------------------
  server.registerTool('raze_watch_orders', {
    title: 'Watch orders for absence',
    description:
      'Arm an expectation for orders that do not have one, so a payment that never arrives '
      + 'is noticed instead of sitting pending forever. Reconciliation is structurally blind '
      + 'to this: there is no payment to enumerate, and only a deadline notices. Writes '
      + 'expectation rows; it does not touch merchant order state.',
    inputSchema: {
      deadline_minutes: z.number().int().min(1).max(10080).default(60)
        .describe('how long an order may stay unpaid before it is considered overdue'),
      limit: z.number().int().min(1).max(500).default(100).describe('how many orders to arm at most'),
    },
  }, async ({ deadline_minutes, limit }) => {
    try {
      const pool = await db();
      const r = await pool.query(
        `SELECT o.order_id FROM "${ORDERS_TABLE}" o
           LEFT JOIN raze_expectations e ON e.subject_id = o.order_id
          WHERE e.subject_id IS NULL
          LIMIT $1`,
        [limit]
      );
      let armed = 0;
      for (const row of r.rows) {
        await pool.query(
          `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
           VALUES ('order', $1, 'payment.captured', now() + ($2 || ' minutes')::interval)`,
          [row.order_id, String(deadline_minutes)]
        );
        armed++;
      }
      return ok({
        armed,
        deadline_minutes,
        note: armed === 0
          ? 'Every order already has an expectation, or the orders table is empty.'
          : 'raze_sweep_expectations resolves overdue ones into recovered, failed or abandoned.',
      });
    } catch (err) { return fail(err.message); }
  });

  // ---- 14. everything, in one answer ------------------------------------
  server.registerTool('raze_status', {
    title: 'Where this merchant stands',
    description:
      'One read-only summary: how many deliveries are held, how many are unapplied, what the '
      + 'expectation ledger has resolved, and whether Razorpay currently reports settled '
      + 'payments the merchant has not applied. The first call to make when asked "is '
      + 'everything alright".',
    inputSchema: {},
  }, async () => {
    try {
      const pool = await db();
      const out = {};

      try {
        const r = await pool.query(
          `SELECT count(*)::int total,
                  count(*) FILTER (WHERE processed_at IS NULL)::int unapplied
             FROM raze_inbox`);
        out.deliveries = r.rows[0];
      } catch { out.deliveries = { unavailable: 'raze_inbox unreadable' }; }

      try {
        const r = await pool.query(
          `SELECT coalesce(resolution, 'open') AS resolution, count(*)::int n
             FROM raze_expectations GROUP BY 1`);
        out.expectations = Object.fromEntries(r.rows.map((x) => [x.resolution, x.n]));
      } catch { out.expectations = {}; }

      try {
        const r = await pool.query(
          `SELECT count(*)::int n, coalesce(sum(credited_paise),0)::bigint paise
             FROM "${ORDERS_TABLE}"`);
        out.merchant = { orders: r.rows[0].n, credited_paise: Number(r.rows[0].paise) };
      } catch (err) { out.merchant = { unavailable: err.message }; }

      if (haveRazorpay) {
        const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
        const impact = await computeImpact({ pool, razorpay, results: [], table: ORDERS_TABLE });
        out.razorpay = impact.razorpay.available
          ? {
              captured: impact.razorpay.capturedCount,
              not_applied: impact.razorpay.unrecorded.length,
              at_risk_paise: impact.razorpay.unrecordedPaise,
              orders: impact.razorpay.unrecorded.slice(0, 20),
            }
          : { unavailable: impact.razorpay.reason, kind: impact.razorpay.kind };
      } else {
        out.razorpay = { unavailable: 'no Razorpay credentials configured' };
      }

      // ---- which of the five states -------------------------------------
      //
      // Two states exist because "fine" and "broken" is a lie that gets
      // merchants hurt. STALE means the runtime is armed but nobody has
      // checked recently; BLIND means Razorpay could not be reached at all.
      // Every competing tool reports both as green. "I do not know" is a
      // different answer from "nothing is wrong", and conflating them is the
      // one thing this tool must never do.
      //
      // The timestamp that matters is the last SUCCESSFUL run, not the last
      // attempt. A run that failed every minute for an hour would otherwise
      // look like continuous coverage.
      let lastSuccess = null;
      let lastAttempt = null;
      try {
        const r = await pool.query(
          `SELECT max(ran_at) FILTER (WHERE ok) AS ok_at, max(ran_at) AS any_at
             FROM raze_reconcile_runs`);
        lastSuccess = r.rows[0].ok_at;
        lastAttempt = r.rows[0].any_at;
      } catch { /* table absent: treated as never run */ }

      const armed = (() => {
        try { return out.expectations && Object.keys(out.expectations).length > 0; }
        catch { return false; }
      })();

      const STALE_AFTER_MS = 15 * 60 * 1000;
      const ageMs = lastSuccess ? Date.now() - new Date(lastSuccess).getTime() : null;
      const reachable = !!(out.razorpay && out.razorpay.unavailable === undefined);
      // "Cannot read your orders table" is not "cannot reach Razorpay". Sending
      // a merchant to check their Razorpay account over a column-name mismatch
      // wastes their time and teaches them to distrust the answer.
      const localProblem = out.razorpay && out.razorpay.kind === 'local'
        ? out.razorpay.unavailable : null;

      let state;
      let says;
      if (localProblem) {
        state = 'UNARMED';
        says = 'I can reach Razorpay, but I cannot read your orders table — ' + localProblem
          + '. Point me at the right table, or let me read your schema and propose the '
          + 'mapping.';
      } else if (!reachable) {
        state = 'BLIND';
        says = 'I cannot reach Razorpay right now, so I do not know whether anything has '
          + 'drifted. This is not the same as everything being fine.';
      } else if (!armed) {
        state = 'UNARMED';
        says = 'I am not watching anything yet. Confirm how your orders map to payments '
          + 'and I will start checking.';
      } else if (out.razorpay.not_applied > 0) {
        state = 'DIVERGED';
        says = 'Rs ' + (out.razorpay.at_risk_paise / 100).toFixed(2) + ' at risk across '
          + out.razorpay.not_applied + ' payment(s) Razorpay captured that your database '
          + 'never applied.';
      } else if (lastSuccess === null || ageMs > STALE_AFTER_MS) {
        state = 'STALE';
        says = lastSuccess
          ? 'I cannot vouch for the last ' + Math.round(ageMs / 60000) + ' minutes — my last '
            + 'successful check was ' + new Date(lastSuccess).toISOString() + '.'
          : 'Nothing has been checked yet, so I cannot vouch for anything.';
      } else {
        state = 'PROTECTED';
        says = 'Everything is accounted for. Last checked ' + Math.round(ageMs / 1000)
          + ' seconds ago.';
      }

      out.state = state;
      out.says = says;
      out.last_successful_check = lastSuccess;
      out.last_attempted_check = lastAttempt;
      out.next = state === 'DIVERGED'
        ? 'raze_explain_order on any order above, then raze_propose_recovery'
        : state === 'UNARMED'
          ? 'raze_propose_mapping, then raze_watch_orders once the merchant approves'
          : state === 'STALE' || state === 'BLIND'
            ? 'run reconciliation before telling the merchant anything is fine'
            : 'nothing to do';
      return ok(out);
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
