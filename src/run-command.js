'use strict';

/**
 * `raze run` — Raze operating on its own.
 *
 * Long-lived and headless. No console, no chat, no model: reconciliation every
 * 60 seconds, the expectation sweeper every 30, and the policy engine deciding
 * whether each divergence is repaired or left for the merchant.
 *
 * This is the process a merchant actually leaves running. The console is
 * somewhere to look at what it did.
 */

const path = require('path');

module.exports = async function cmdRun({ env, flag, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const { createLoops } = require(path.join(RAZE, 'src', 'loops'));
  const actions = require(path.join(RAZE, 'src', 'actions'));
  const fs = require('fs');

  const table = flag('orders-table', env.RAZE_ORDERS_TABLE || 'shop_orders');
  const columns = {
    key: flag('key-column', env.RAZE_ORDER_KEY_COLUMN || 'order_id'),
    status: flag('status-column', env.RAZE_STATUS_COLUMN || 'status'),
    amount: flag('amount-column', env.RAZE_AMOUNT_COLUMN || 'credited_paise'),
    // No default. A column that does not exist would make every amount check
    // throw; a column that is absent makes every repair escalate, which is the
    // safe direction.
    expected: flag('expected-column', env.RAZE_EXPECTED_COLUMN || null),
  };

  const merchant = {
    mappingConfirmed: env.RAZE_MAPPING_CONFIRMED !== 'false',
    // Enforced, not advised: without a column to check the amount against there
    // is nothing to verify, so nothing may be applied unattended.
    escalateOnly: env.RAZE_ESCALATE_ONLY === 'true' || flag('escalate-only', false) === true
      || !flag('expected-column', env.RAZE_EXPECTED_COLUMN || null),
    autoRepair: env.RAZE_AUTO_REPAIR !== 'false' && flag('no-auto', false) !== true,
  };

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    console.error('\n  Raze cannot run without Razorpay credentials — asking the provider what');
    console.error('  it recorded is the whole job. Put them in .env.\n');
    process.exit(1);
  }

  const { pool, embedded } = await connect();
  await migrate(pool);
  await actions.ensure(pool);

  const LOG = [
    path.join(RAZE, 'measurement', 'deliveries.jsonl'),
    path.join(RAZE, '..', 'deliveries.jsonl'),
  ].find((p) => fs.existsSync(p));

  // Stated on the command line, the same way the console states it. Without
  // this the daemon re-infers and declines on any schema inference cannot read.
  const mappingSpec = columns.expected || flag('status-column', null) ? {
    table,
    key: { column: columns.key, from: 'payload.payment.entity.order_id' },
    set: { [columns.status]: { literal: 'paid' } },
    add: { [columns.amount]: 'payload.payment.entity.amount' },
    guard: { column: columns.status, notIn: ['refunded'] },
    insertIfMissing: false,
  } : null;

  const loops = createLoops({
    pool,
    mappingSpec,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    merchant, columns, ordersTable: table, logFile: LOG,
    onEvent: (e) => {
      const t = new Date().toISOString().slice(11, 19);
      if (e.type === 'recovered') {
        console.log(`  ${t}  recovered  ${e.orderId}  Rs ${(e.amount / 100).toFixed(2)}`);
      } else if (e.type === 'escalated') {
        console.log(`  ${t}  waiting    ${e.orderId}  ${e.why || ''}`);
      } else if (e.type === 'reconcile-failed') {
        console.log(`  ${t}  could not reach Razorpay — ${e.error}`);
      } else if (e.type === 'error') {
        console.log(`  ${t}  error in ${e.where}: ${e.error}`);
      }
    },
  });

  console.log('');
  console.log(`  Raze is running`);
  console.log(`  postgres        ${embedded ? 'embedded' : 'DATABASE_URL'}`);
  console.log(`  orders          "${table}"  (${columns.key} · ${columns.status} · ${columns.amount}`
    + `${columns.expected ? ' · ' + columns.expected : ', no expected-amount column'})`);
  console.log(`  reconcile       every ${loops.config.reconcileMs / 1000}s`);
  console.log(`  sweep           every ${loops.config.sweepMs / 1000}s`);
  console.log(`  auto-repair     ${merchant.autoRepair && !merchant.escalateOnly
    ? 'on, under policy' : 'off — everything waits for you'}`);
  if (!columns.expected) {
    console.log('');
    console.log('  No expected-amount column is configured, so Raze cannot check that a');
    console.log('  payment matches the order it is for. It will still tell you when');
    console.log('  Razorpay and your database disagree; it will not repair anything on');
    console.log('  its own. Pass --expected-column=<name> to enable unattended repair.');
  }
  console.log('');
  console.log('  ctrl-c to stop');
  console.log('');

  await loops.start();

  const stop = async () => {
    loops.stop();
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
};
