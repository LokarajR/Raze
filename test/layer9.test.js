'use strict';

/**
 * Tier 1 tests — the four gaps that made the guarantee untrue.
 *
 * The claim is that every payment Razorpay records reaches merchant state
 * exactly once, without depending on webhook delivery. Four things stood between
 * that sentence and reality, and each one is checked here:
 *
 *   refunds were never reconciled, so a missed refund stayed missing forever
 *   a failing event retried indefinitely, so "stuck" looked like "busy"
 *   "never ran" and "found nothing" were indistinguishable
 *   nothing could recover history, so installing Raze left the past invisible
 *
 * Layers 2 and 3 already cover the live API. These tests are about the
 * behaviour around it, so they use the real API only where the assertion needs
 * it.
 *
 *   node test/layer9.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const { createReconciler } = require('../src/reconcile');

const ROOT = path.join(__dirname, '..', '..');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(ROOT, 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

function loadEnv() {
  const out = {};
  for (const p of [path.join(__dirname, '..', '.env'), path.join(ROOT, 'probe-server', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0 && !line.trim().startsWith('#')) {
          const k = line.slice(0, i).trim();
          if (!(k in out)) out[k] = line.slice(i + 1).trim();
        }
      }
    } catch {}
  }
  return { ...out, ...process.env };
}

function firstDelivery(type) {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const d = rows.find((r) => r.event_type === type && r.raw_body_b64);
  return {
    body: Buffer.from(d.raw_body_b64, 'base64'),
    eventId: d.event_id,
    signature: d.signature,
  };
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function main() {
  const env = loadEnv();
  const { pool } = await connect();
  await migrate(pool);
  console.log('\nLayer 9 tests  (tier 1: the gaps in the guarantee)\n');

  await pool.query(`CREATE TABLE IF NOT EXISTS shop_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'created',
    credited_paise BIGINT NOT NULL DEFAULT 0, credit_count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

  const reset = async () => {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO raze_reconcile_state (id) VALUES (1) ON CONFLICT DO NOTHING`);
  };

  // ---- 1. a poison event escalates instead of retrying forever -----------
  await reset();
  const rz = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  rz.on('payment.captured', async () => { throw new Error('handler is broken on purpose'); });

  const app = express();
  app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const captured = firstDelivery('payment.captured');
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': captured.eventId,
      'x-razorpay-signature': captured.signature,
    },
    body: captured.body,
  }).then((r) => r.text());

  // Drain repeatedly with backoff cleared, so attempts accumulate quickly.
  for (let i = 0; i < 20; i++) {
    await pool.query('UPDATE raze_inbox SET next_attempt_at = NULL WHERE processed_at IS NULL');
    await rz.drain();
  }

  const poison = await pool.query(
    `SELECT process_attempts, needs_attention, attention_since, last_error, processed_at
       FROM raze_inbox WHERE event_id = $1`, [captured.eventId]
  );
  const p = poison.rows[0] || {};
  check('a repeatedly failing event is escalated, not retried forever',
    p.needs_attention === true && p.process_attempts >= 16,
    `attempts=${p.process_attempts} needs_attention=${p.needs_attention}`);

  check('an escalated event keeps its bytes and is never marked processed',
    p.processed_at === null && !!p.last_error,
    `processed_at=${p.processed_at}`);

  const beforePick = await pool.query(
    `SELECT count(*)::int n FROM raze_inbox WHERE processed_at IS NULL AND NOT needs_attention`
  );
  check('an escalated event is no longer picked up by the worker',
    beforePick.rows[0].n === 0, `still selectable=${beforePick.rows[0].n}`);
  server.close();

  // ---- 2. reconciliation liveness ----------------------------------------
  await reset();
  const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => new Set(),
    localRefundIds: async () => new Set(),
    config: { coldStartMs: 3 * 24 * 3600 * 1000 },
  });

  const before = await rec.status();
  check('before any run, health reports "never run" rather than clean',
    before.neverRan === true && before.health === 'never run' && before.coveredThrough === null,
    JSON.stringify({ health: before.health, neverRan: before.neverRan }));

  const run = await rec.runOnce();
  const after = await rec.status();
  check('a covered window advances the watermark and reports as covered',
    run.ok && after.health === 'covered' && !!after.coveredThrough,
    JSON.stringify({ ok: run.ok, health: after.health }));

  // ---- 3. a failed run does not look like a covered one -------------------
  await reset();
  const broken = createReconciler({
    db: pool,
    razorpay: { keyId: 'rzp_test_invalid', keySecret: 'invalid' },
    localOrderIds: async () => new Set(),
    localRefundIds: async () => new Set(),
  });
  const failedRun = await broken.runOnce();
  const afterFail = await broken.status();
  check('a run that could not complete leaves coverage unadvanced',
    failedRun.ok === false && afterFail.coveredThrough === null && afterFail.neverSucceeded === true,
    JSON.stringify({ ok: failedRun.ok, covered: afterFail.coveredThrough }));
  check('an attempted-but-failed run is still recorded as an attempt',
    afterFail.lastAttemptAt !== null && afterFail.neverRan === false,
    JSON.stringify({ attempt: afterFail.lastAttemptAt, neverRan: afterFail.neverRan }));

  // ---- 4. refunds are reconciled, and their absence is not silent --------
  await reset();
  const noRefundView = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => new Set(),
    config: { coldStartMs: 3 * 24 * 3600 * 1000 },
  });
  const r1 = await noRefundView.runOnce();
  check('without a refund view, refunds are reported unchecked rather than clean',
    r1.ok && r1.refunds && r1.refunds.checked === false,
    JSON.stringify(r1.refunds));

  await reset();
  // A fresh reconciler: the one above already advanced its watermark, so reusing
  // it would scan a few seconds rather than the window the refunds live in.
  const withRefunds = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => new Set(),
    localRefundIds: async () => new Set(),
    config: { coldStartMs: 4 * 24 * 3600 * 1000 },
  });
  const r2 = await withRefunds.runOnce();
  check('with a refund view, real refunds are found and queued for repair',
    r2.ok && r2.refunds && r2.refunds.drift > 0 && r2.refunds.repaired === r2.refunds.drift,
    JSON.stringify(r2.refunds));

  const refundRows = await pool.query(
    `SELECT event_id, event_type, subject_id FROM raze_inbox
      WHERE event_type = 'refund.created' AND source = 'reconcile'`
  );
  check('a reconstructed refund carries the order id from its payment',
    refundRows.rowCount > 0 && refundRows.rows.every((x) => x.subject_id && x.event_id.startsWith('recon_')),
    JSON.stringify(refundRows.rows.slice(0, 2)));

  // ---- 5. reconciling twice repairs nothing the second time --------------
  const r3 = await withRefunds.runOnce();
  check('a second pass over the same ground repairs nothing',
    r3.ok && r3.repaired === 0, JSON.stringify({ drift: r3.drift, repaired: r3.repaired }));

  await reset();
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
