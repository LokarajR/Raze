'use strict';

/**
 * Layer 3 tests — reconciliation against the real Razorpay API.
 *
 * These hit api.razorpay.com with real Test Mode credentials and enumerate the
 * real payments created during the measurement. Nothing is mocked. The test
 * proves the repair path end to end: a payment Razorpay knows about, which the
 * local store has never heard of, is discovered and driven through the same
 * handler a webhook would have used.
 *
 *   node raze/test/layer3.test.js
 */

const fs = require('fs');
const path = require('path');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const { createReconciler } = require('../src/reconcile');

const ROOT = path.join(__dirname, '..', '..');

const { loadEnv } = require('./env');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function main() {
  const env = loadEnv();
  const { pool } = await connect();
  await migrate(pool);
  console.log('\nLayer 3 tests  (live Razorpay Test Mode API)\n');

  await pool.query(`CREATE TABLE IF NOT EXISTS demo_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL, credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);
  await pool.query('TRUNCATE raze_inbox, raze_subject_state, raze_expectations, raze_reconcile_runs, demo_orders');

  const ps = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  ps.on('payment.captured', async (event, tx) => {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO demo_orders (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = demo_orders.credited_paise + EXCLUDED.credited_paise,
             credit_count = demo_orders.credit_count + 1`,
      [p.order_id, p.amount]
    );
  });

  const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => {
      const r = await pool.query('SELECT order_id FROM demo_orders');
      return new Set(r.rows.map((x) => x.order_id));
    },
    config: { overlapMs: 0, coldStartMs: 3 * 24 * 3600 * 1000 },
  });

  // -- 1. enumeration reaches the real API ---------------------------------
  const now = Math.floor(Date.now() / 1000);
  const payments = await rec.enumeratePayments(now - 3 * 24 * 3600, now);
  check('enumerates real payments from the Razorpay API',
    payments.length > 0 && payments.every((p) => p.id && p.id.startsWith('pay_')),
    `got ${payments.length}`);

  // -- 2. drift detected on an empty local store ---------------------------
  // The local store knows nothing, so every captured payment is drift. This is
  // the "delivery severed" case in its strongest form.
  const run1 = await rec.runOnce();
  check('detects drift when local state knows nothing',
    run1.ok && run1.drift > 0 && run1.repaired === run1.drift,
    `ok=${run1.ok} drift=${run1.drift} repaired=${run1.repaired}`);

  // -- 3. repair flows through the same handler ----------------------------
  const before = await pool.query('SELECT count(*)::int n FROM demo_orders');
  await ps.drain();
  const after = await pool.query('SELECT count(*)::int n FROM demo_orders');
  check('repaired events processed by the ordinary handler',
    before.rows[0].n === 0 && after.rows[0].n > 0,
    `orders before=${before.rows[0].n} after=${after.rows[0].n}`);

  // -- 4. repaired rows are marked, not disguised --------------------------
  const src = await pool.query(
    "SELECT count(*)::int n FROM raze_inbox WHERE source='reconcile' AND event_id LIKE 'recon\\_%'"
  );
  check('repaired rows carry source=reconcile and a synthetic event id',
    src.rows[0].n === run1.repaired,
    `marked=${src.rows[0].n} repaired=${run1.repaired}`);

  // -- 5. second pass is idempotent ----------------------------------------
  const run2 = await rec.runOnce();
  await ps.drain();
  const credits = await pool.query('SELECT max(credit_count)::int m FROM demo_orders');
  check('re-running reconciliation repairs nothing and double-credits nothing',
    run2.repaired === 0 && credits.rows[0].m === 1,
    `repaired=${run2.repaired} max credit_count=${credits.rows[0].m}`);

  // -- 6. overlapping windows are harmless ---------------------------------
  const rec2 = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => {
      const r = await pool.query('SELECT order_id FROM demo_orders');
      return new Set(r.rows.map((x) => x.order_id));
    },
    config: { overlapMs: 5 * 60000, coldStartMs: 3 * 24 * 3600 * 1000 },
  });
  const run3 = await rec2.runOnce();
  await ps.drain();
  const credits2 = await pool.query('SELECT max(credit_count)::int m FROM demo_orders');
  check('overlapping window re-scan does not duplicate business effect',
    credits2.rows[0].m === 1,
    `max credit_count=${credits2.rows[0].m}`);

  // -- 7. unreachable API is recorded as a failed run ----------------------
  const broken = createReconciler({
    db: pool,
    razorpay: { keyId: 'rzp_test_invalid', keySecret: 'invalid' },
    localOrderIds: async () => new Set(),
  });
  const run4 = await broken.runOnce();
  const lastRun = await pool.query('SELECT ok, error FROM raze_reconcile_runs ORDER BY ran_at DESC LIMIT 1');
  check('unreachable API records a failed run rather than a clean one',
    run4.ok === false && lastRun.rows[0].ok === false && !!lastRun.rows[0].error,
    `ok=${run4.ok} recorded_ok=${lastRun.rows[0]?.ok}`);

  await pool.query('TRUNCATE raze_inbox, raze_subject_state, raze_expectations, raze_reconcile_runs, demo_orders');
  await shutdown(pool);

  console.log(`\n${pass}/${pass + fail} passed`);
  console.log(`(reconciled ${run1.drift} real payments from the Razorpay API)\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
