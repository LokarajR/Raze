'use strict';

/**
 * Raze — Layer 4, audit.
 *
 * Replays real captured Razorpay deliveries at a target integration and reads the
 * resulting business state directly from Postgres.
 *
 * Two rules make the findings trustworthy:
 *
 *   Probes read state from the database, not from a /test-state endpoint. An
 *   endpoint added for the test would be instrumentation, and instrumentation is
 *   a form of simulation.
 *
 *   The control case is mandatory. Auditing a correct integration must produce
 *   zero findings, every time. A detector that fires on correct code is worse
 *   than no detector, so `auditControl` asserts exactly that.
 *
 * Fixtures are the 796-delivery corpus from measurement/RESULTS.md — real bodies,
 * real headers, real signatures. The only bytes ever altered are in the tampered-
 * signature probe, which alters the signature header and says so.
 */

const fs = require('fs');
const crypto = require('crypto');

/** Measured first-retry delays. Used so the duplicate probe reproduces real timing. */
const MEASURED_FIRST_RETRY_MS = {
  'payment.authorized': 230,
  'payment.captured': 230,
  'order.paid': 240,
  'refund.created': 6400,
  'payment.failed': 7400,
};

function loadLadders(logFile) {
  const rows = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64) continue;
    const k = `${r.event_id}|${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const v of byKey.values()) v.sort((a, b) => a.received_at_ms - b.received_at_ms);
  return byKey;
}

const toFixture = (d) => ({
  body: Buffer.from(d.raw_body_b64, 'base64'),
  eventId: d.event_id,
  signature: d.signature,
  eventType: d.event_type,
});

function longestLadder(byKey, eventType) {
  let best = null;
  for (const v of byKey.values()) {
    if (v[0].event_type !== eventType || v.length < 2) continue;
    if (!best || v.length > best.length) best = v;
  }
  if (!best) throw new Error(`no captured retry ladder for ${eventType}`);
  return best.map(toFixture);
}

function lifecycle(byKey) {
  const first = new Map();
  for (const v of byKey.values()) if (!first.has(v[0].event_type)) first.set(v[0].event_type, v[0]);
  return ['payment.authorized', 'payment.captured', 'order.paid']
    .filter((t) => first.has(t)).map((t) => toFixture(first.get(t)));
}

function createAuditor({ targetUrl, pool, logFile, webhookSecret }) {
  // The paise figure a probe's finding is worth. Read from the delivery itself
  // rather than assumed, so the impact figures downstream are the merchant's
  // own money and not a constant.
  const amountOf = (f) => {
    try { return JSON.parse(f.body.toString()).payload.payment.entity.amount; }
    catch { return 0; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function send(f, overrides = {}) {
    const headers = { 'content-type': 'application/json' };
    const eid = overrides.eventId !== undefined ? overrides.eventId : f.eventId;
    const body = overrides.body || f.body;
    // Sign each probe with the secret the target is configured with, rather than
    // replaying the signature captured with the corpus. For the secret the
    // corpus was recorded under these are the same bytes — a Razorpay signature
    // is HMAC-SHA256 of the raw body under the webhook secret — but a merchant
    // audited with its own secret would reject every replayed signature with a
    // 401, and the audit would report a broken integration that is fine.
    const signed = webhookSecret
      ? crypto.createHmac('sha256', webhookSecret).update(body).digest('hex')
      : f.signature;
    const sig = overrides.signature !== undefined ? overrides.signature : signed;
    if (eid) headers['x-razorpay-event-id'] = eid;
    if (sig) headers['x-razorpay-signature'] = sig;
    try {
      const res = await fetch(targetUrl, { method: 'POST', headers, body });
      await res.text();
      return { status: res.status };
    } catch (err) {
      return { status: 0, error: err.message };
    }
  }

  /**
   * Read the target's business state straight from its own tables.
   *
   * credited_paise is BIGINT, which node-pg returns as a STRING to avoid losing
   * precision above 2^53. Coerced here so probe assertions can compare numbers —
   * without this, `'0' === 0` is false and every refund probe reports a finding
   * against a merchant that behaved correctly.
   */
  async function state(orderId) {
    const r = await pool.query(
      'SELECT status, credited_paise, credit_count FROM shop_orders WHERE order_id = $1',
      [orderId]
    );
    const row = r.rows[0];
    if (!row) return { status: null, credited_paise: 0, credit_count: 0 };
    return {
      status: row.status,
      credited_paise: Number(row.credited_paise),
      credit_count: Number(row.credit_count),
    };
  }

  /**
   * Clear every table in the schema before each probe.
   *
   * Not just the tables this harness knows about. A repaired handler may create
   * its own — a dedupe table is the obvious one — and if that table survives
   * between rounds, the next round sees every delivery as an already-processed
   * repeat, writes nothing, and the probes report failures against code that is
   * actually correct.
   *
   * That is exactly what happened once: a generated patch added a webhook_events
   * table, passed its verification round, then failed the next audit with
   * status=null because its own dedupe table still held the previous round's
   * event ids. The patch was right; the reset was incomplete.
   *
   * Verification has to be repeatable to mean anything, so the reset discovers
   * the tables rather than assuming them.
   */
  async function reset() {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    if (rows.length === 0) return;
    const names = rows.map((r) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }

  /** Wait until the target stops changing state, so async workers can settle. */
  async function settle(orderId, { timeoutMs = 4000 } = {}) {
    let last = JSON.stringify(await state(orderId));
    const deadline = Date.now() + timeoutMs;
    let stableFor = 0;
    while (Date.now() < deadline) {
      await sleep(150);
      const now = JSON.stringify(await state(orderId));
      if (now === last) {
        stableFor += 150;
        if (stableFor >= 600) return;
      } else {
        stableFor = 0;
        last = now;
      }
    }
  }

  const byKey = loadLadders(logFile);
  const ladder = longestLadder(byKey, 'payment.captured');
  const orderId = JSON.parse(ladder[0].body.toString()).payload.payment.entity.order_id;
  const life = lifecycle(byKey);
  const lifeOrder = JSON.parse(life[0].body.toString()).payload.payment.entity.order_id;

  // Refund fixtures: the captured payment that was later refunded, plus the real
  // refund.created ladder for that same payment.
  const refundLadder = longestLadder(byKey, 'refund.created');
  const refundPaymentId = JSON.parse(refundLadder[0].body.toString()).payload.refund.entity.payment_id;
  let refundSetup = null;
  for (const v of byKey.values()) {
    if (v[0].event_type !== 'payment.captured') continue;
    const ent = JSON.parse(Buffer.from(v[0].raw_body_b64, 'base64').toString()).payload.payment.entity;
    if (ent.id === refundPaymentId) { refundSetup = toFixture(v[0]); break; }
  }
  if (!refundSetup) throw new Error('no captured delivery matching the refunded payment');
  const refundOrder = JSON.parse(refundSetup.body.toString()).payload.payment.entity.order_id;

  const probes = {
    'duplicate-delivery': {
      title: 'Duplicate delivery',
      assertion: 'One event produces exactly one business-state transition',
      why: 'Razorpay retries a failed delivery with a byte-identical body and an unchanged '
         + 'event id, measured at 0.23s for payment events. A handler that does not dedupe '
         + 'applies the same effect twice.',
      async run() {
        await reset();
        await send(ladder[0]);
        await sleep(MEASURED_FIRST_RETRY_MS[ladder[0].eventType] || 230);
        await send(ladder[1]);
        await settle(orderId);
        const s = await state(orderId);
        return {
          pass: s.credit_count === 1,
          observed: `credit_count=${s.credit_count}, credited=${s.credited_paise} paise`,
          evidence: { event_id: ladder[0].eventId, deliveries_sent: 2,
            bodies_byte_identical: ladder[0].body.equals(ladder[1].body),
            credit_count: s.credit_count, credited_paise: s.credited_paise,
            amount_paise: amountOf(ladder[0]) },
        };
      },
    },

    'refund-event': {
      title: 'Refund event',
      assertion: 'A refund produces the correct state mutation, exactly once',
      why: 'Refunds skip the instant retry entirely — measured at ~6-9s for the first '
         + 'attempt against 0.23s for payment events. A demo or handler tuned to payment '
         + 'timing mishandles them.',
      async run() {
        await reset();
        // Establish the paid order first, then refund it. Both are real captured
        // deliveries for the same payment.
        await send(refundSetup);
        await settle(refundOrder);
        const paid = await state(refundOrder);
        for (const d of refundLadder) await send(d);
        await settle(refundOrder);
        const after = await state(refundOrder);
        return {
          pass: after.status === 'refunded' && after.credited_paise === 0,
          observed: `status=${after.status}, credited=${after.credited_paise} paise (was ${paid.credited_paise})`,
          evidence: { refund_event_id: refundLadder[0].eventId, deliveries_sent: refundLadder.length,
            credited_paise_before: paid.credited_paise, credited_paise_after: after.credited_paise },
        };
      },
    },

    'tampered-signature': {
      title: 'Tampered signature',
      assertion: 'Rejected with a non-2xx and zero business-state change',
      why: 'A handler that does not verify the HMAC over the raw body accepts any payload '
         + 'from anyone who knows the URL. The body here is genuine; only the signature '
         + 'header is replaced.',
      async run() {
        // Without a webhook secret there is nothing to verify against, so this
        // probe cannot be evaluated. Report that honestly instead of inventing a
        // finding: a correct integration with no secret configured is
        // unconfigured, not broken, and a detector that cannot tell the
        // difference is worse than no detector.
        if (!webhookSecret) {
          return {
            skipped: true,
            pass: true,
            observed: 'not evaluated — no RAZORPAY_WEBHOOK_SECRET configured',
            evidence: { reason: 'signature verification cannot be exercised without the secret '
                              + 'the captured deliveries were signed with' },
          };
        }
        await reset();
        const res = await send(ladder[0], { signature: '0'.repeat(64), eventId: `forged-${Date.now()}` });
        await sleep(400);
        const s = await state(orderId);
        return {
          pass: res.status >= 300 && s.credit_count === 0,
          observed: s.credit_count === 0
            ? `rejected with HTTP ${res.status}`
            : `ACCEPTED — credited ${s.credited_paise} paise on a forged signature`,
          evidence: { http_status: res.status, signature_sent: 'sixty-four zeroes',
            credited_paise: s.credited_paise, credit_count: s.credit_count },
        };
      },
    },

    'out-of-order': {
      title: 'Out-of-order delivery',
      assertion: 'Final state is valid and never regresses',
      why: 'Razorpay does not guarantee ordering. authorized, captured and order.paid fire '
         + 'within milliseconds and retries interleave them further.',
      async run() {
        await reset();
        for (const d of [...life].reverse()) await send(d);
        await settle(lifeOrder);
        const s = await state(lifeOrder);
        return {
          pass: s.status === 'paid',
          observed: `final status=${s.status}`,
          evidence: { sent_order: [...life].reverse().map((d) => d.eventType),
            natural_order: life.map((d) => d.eventType) },
        };
      },
    },

    'timeout-retry': {
      title: 'Timeout-induced retry',
      assertion: 'Same final state as a single delivery',
      why: 'A handler slower than Razorpay\'s timeout is sent a duplicate it did not cause. '
         + 'The measurement showed the first retry arrives 0.23s after the original, so a '
         + 'synchronous handler taking seconds is guaranteed to receive one.',
      async run() {
        await reset();
        await send(ladder[0]);
        const single = await (async () => { await settle(orderId); return state(orderId); })();
        await reset();
        for (const d of ladder.slice(0, 3)) await send(d);
        await settle(orderId);
        const retried = await state(orderId);
        return {
          pass: retried.credited_paise === single.credited_paise && retried.credit_count === single.credit_count,
          observed: `single delivery credited ${single.credited_paise}, with retries credited ${retried.credited_paise}`,
          evidence: { single_credit_count: single.credit_count, retried_credit_count: retried.credit_count,
            single_credited_paise: single.credited_paise, retried_credited_paise: retried.credited_paise },
        };
      },
    },
  };

  async function run(names) {
    const chosen = names && names.length ? names : Object.keys(probes);
    const results = [];
    for (const name of chosen) {
      const probe = probes[name];
      if (!probe) throw new Error(`unknown probe: ${name}`);
      let r;
      try { r = await probe.run(); }
      catch (err) { r = { pass: false, observed: `probe threw: ${err.message}`, evidence: {} }; }
      results.push({ name, title: probe.title, assertion: probe.assertion, why: probe.why, ...r });
    }
    await reset();
    return results;
  }

  return { run, probes: Object.keys(probes), state, reset };
}

module.exports = { createAuditor, MEASURED_FIRST_RETRY_MS };
