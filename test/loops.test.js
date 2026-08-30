'use strict';

/**
 * Layer 16 — Raze acting on its own.
 *
 * The policy layer decides in isolation; this checks the loop actually carries
 * the verdict out against a real database, and — the part that matters — that a
 * repair is only reported once it has been read back out of the merchant's own
 * table.
 *
 * The two cases the whole design turns on:
 *
 *   clean divergence  repaired unattended, logged with the rule that allowed it,
 *                     and verified by reading the merchant's row afterwards
 *   amount mismatch   escalated and left alone, with the merchant's own money
 *                     untouched
 *
 * Real Postgres, real mapping, real runtime. The Razorpay API is the only thing
 * stubbed, because a test cannot make a stranger's bank capture Rs 500 on demand
 * — and the shape it returns is taken from the captured corpus, not invented.
 *
 *   node test/loops.test.js
 */

const path = require('path');
const { connect, migrate, shutdown } = require('../src/db');
const { createLoops } = require('../src/loops');
const actions = require('../src/actions');

const RAZE = path.join(__dirname, '..');
const LOG = require('fs').existsSync(path.join(RAZE, 'measurement', 'deliveries.jsonl'))
  ? path.join(RAZE, 'measurement', 'deliveries.jsonl')
  : path.join(RAZE, '..', 'deliveries.jsonl');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

const COLUMNS = { key: 'order_id', status: 'status', amount: 'credited_paise',
  expected: 'expected_paise' };
const READY = { mappingConfirmed: true, escalateOnly: false, autoRepair: true };

async function main() {
  const { pool } = await connect();
  await migrate(pool);
  await actions.ensure(pool);

  // A merchant table shaped the way a real one is: it records what the order
  // was supposed to cost, which is what makes the amount check possible.
  await pool.query(`CREATE TABLE IF NOT EXISTS loop_orders (
    order_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    expected_paise BIGINT,
    credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);
  await pool.query('TRUNCATE loop_orders');
  await pool.query('TRUNCATE raze_actions');
  await pool.query('TRUNCATE raze_inbox, raze_subject_state');

  console.log('\nLayer 16 tests  (unattended operation)\n');

  const loops = createLoops({
    pool,
    razorpay: { keyId: 'stub', keySecret: 'stub' },
    merchant: READY,
    columns: COLUMNS,
    ordersTable: 'loop_orders',
    logFile: LOG,
  });

  // ---- 1. a clean divergence, repaired with nobody watching ---------------
  await pool.query(
    `INSERT INTO loop_orders (order_id, status, expected_paise) VALUES ($1,'pending',50000)`,
    ['order_clean']);
  const clean = await loops.handleDrift({
    id: 'pay_clean', status: 'captured', amount: 50000, order_id: 'order_clean',
  });
  check('a clean divergence is repaired unattended',
    clean.action === 'recovered', JSON.stringify(clean));

  const row = await pool.query(
    'SELECT status, credited_paise, credit_count FROM loop_orders WHERE order_id=$1',
    ['order_clean']);
  check('the merchant\'s own table shows the money, not just the inbox',
    row.rows[0] && row.rows[0].status === 'paid'
      && Number(row.rows[0].credited_paise) === 50000
      && row.rows[0].credit_count === 1,
    JSON.stringify(row.rows[0]));

  const logged = await pool.query(
    `SELECT kind, rule, amount_paise, verified_state FROM raze_actions
      WHERE order_id='order_clean'`);
  check('the repair is logged with the rule that allowed it',
    logged.rows[0] && logged.rows[0].kind === 'recovered'
      && logged.rows[0].rule === 'clean-capture',
    JSON.stringify(logged.rows[0]));
  check('the log carries the state read back from the merchant\'s table',
    logged.rows[0] && logged.rows[0].verified_state
      && Number(logged.rows[0].verified_state.appliedAmount) === 50000,
    JSON.stringify(logged.rows[0] && logged.rows[0].verified_state));

  // ---- 2. running it again must not credit twice --------------------------
  await loops.handleDrift({
    id: 'pay_clean', status: 'captured', amount: 50000, order_id: 'order_clean',
  });
  const again = await pool.query(
    'SELECT credited_paise, credit_count FROM loop_orders WHERE order_id=$1', ['order_clean']);
  check('a second pass over the same payment does not credit it again',
    Number(again.rows[0].credited_paise) === 50000 && again.rows[0].credit_count === 1,
    JSON.stringify(again.rows[0]));

  // ---- 3. an amount mismatch waits ----------------------------------------
  await pool.query(
    `INSERT INTO loop_orders (order_id, status, expected_paise) VALUES ($1,'pending',50000)`,
    ['order_mismatch']);
  const mismatch = await loops.handleDrift({
    id: 'pay_mismatch', status: 'captured', amount: 45000, order_id: 'order_mismatch',
  });
  check('a payment that does not match the order escalates instead of settling it',
    mismatch.action === 'escalate' && mismatch.rule === 'amount-mismatch',
    JSON.stringify(mismatch));

  const untouched = await pool.query(
    'SELECT status, credited_paise FROM loop_orders WHERE order_id=$1', ['order_mismatch']);
  check('the mismatched order is left exactly as it was',
    untouched.rows[0].status === 'pending' && Number(untouched.rows[0].credited_paise) === 0,
    JSON.stringify(untouched.rows[0]));

  const esc = await pool.query(
    `SELECT why, amount_paise FROM raze_actions WHERE order_id='order_mismatch'`);
  check('the escalation says both amounts in rupees',
    esc.rows[0] && /Rs 450\.00/.test(esc.rows[0].why) && /Rs 500\.00/.test(esc.rows[0].why),
    esc.rows[0] && esc.rows[0].why);

  // ---- 4. an escalation is not repeated every tick ------------------------
  await loops.handleDrift({
    id: 'pay_mismatch', status: 'captured', amount: 45000, order_id: 'order_mismatch',
  });
  const escCount = await pool.query(
    `SELECT count(*)::int n FROM raze_actions WHERE order_id='order_mismatch'`);
  check('the same escalation is recorded once, not on every pass',
    escCount.rows[0].n === 1, `recorded ${escCount.rows[0].n} times`);

  // ---- 5. an order with no expected amount is never auto-settled ----------
  await pool.query(
    `INSERT INTO loop_orders (order_id, status, expected_paise) VALUES ($1,'pending',NULL)`,
    ['order_noamount']);
  const noAmount = await loops.handleDrift({
    id: 'pay_noamount', status: 'captured', amount: 50000, order_id: 'order_noamount',
  });
  check('an order with no recorded amount escalates rather than being settled blind',
    noAmount.action === 'escalate' && noAmount.rule === 'amount-not-verifiable',
    JSON.stringify(noAmount));

  // ---- 6. a merchant with side effects never auto-applies -----------------
  const cautious = createLoops({
    pool, razorpay: { keyId: 'stub', keySecret: 'stub' },
    merchant: { ...READY, escalateOnly: true },
    columns: COLUMNS, ordersTable: 'loop_orders', logFile: LOG,
  });
  await pool.query(
    `INSERT INTO loop_orders (order_id, status, expected_paise) VALUES ($1,'pending',50000)`,
    ['order_sideeffects']);
  const cautiousOut = await cautious.handleDrift({
    id: 'pay_side', status: 'captured', amount: 50000, order_id: 'order_sideeffects',
  });
  check('a merchant whose writes trigger fulfilment is never auto-repaired',
    cautiousOut.action === 'escalate' && cautiousOut.rule === 'merchant-has-side-effects',
    JSON.stringify(cautiousOut));
  const sideRow = await pool.query(
    'SELECT credited_paise FROM loop_orders WHERE order_id=$1', ['order_sideeffects']);
  check('their order is untouched',
    Number(sideRow.rows[0].credited_paise) === 0, JSON.stringify(sideRow.rows[0]));

  // ---- 7. the console's opening screen ------------------------------------
  const summary = await actions.since(pool, new Date(Date.now() - 3600 * 1000));
  // Four waiting, not three: the second pass over the already-paid order in
  // step 2 correctly escalated as order-already-paid. A second payment against a
  // settled order is a real thing worth telling a merchant about — in normal
  // operation reconciliation only surfaces unapplied payments, so this path is
  // reached by the direct call above rather than by the loop.
  check('the activity summary separates recovered money from decisions needed',
    summary.recovered.count === 1 && summary.recovered.paise === 50000
      && summary.waiting.count === 4,
    JSON.stringify({ recovered: summary.recovered.count, paise: summary.recovered.paise,
      waiting: summary.waiting.count }));

  // ---- 8. acknowledging an escalation clears it ---------------------------
  await actions.acknowledge(pool, 'order_mismatch');
  const after = await actions.since(pool, new Date(Date.now() - 3600 * 1000));
  check('an escalation the merchant has dealt with stops asking',
    after.waiting.count === 3, `${after.waiting.count} still waiting`);

  await pool.query('DROP TABLE IF EXISTS loop_orders');
  await pool.query('TRUNCATE raze_actions');
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
