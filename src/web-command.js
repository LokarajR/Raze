'use strict';

/**
 * `raze web` — start the console.
 *
 * Long-lived: it is the webhook endpoint Razorpay posts to, so it owns the
 * process until stopped.
 *
 * PORT is read from the environment because every host that runs this — Railway,
 * Render, Fly — assigns one. Binding 0.0.0.0 rather than localhost is what makes
 * the difference between a page only you can see and an endpoint Razorpay can
 * actually reach.
 */

const path = require('path');

module.exports = async function cmdWeb({ env, flag, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const { createApp, stopMerchant, restoreArmed, S, MERCHANT_SCHEMA } =
    require(path.join(RAZE, 'src', 'web', 'server'));

  const port = Number(process.env.PORT || flag('port', 7000));
  const { pool, url, embedded } = await connect();
  await migrate(pool);
  await pool.query(MERCHANT_SCHEMA);

  // The CLI reads .env into its own object rather than into process.env, so a
  // value set there was invisible here — Raze reported having no public address
  // while one was configured two lines away.
  S.port = port;
  S.publicUrl = process.env.PUBLIC_URL || env.RAZE_PUBLIC_URL
    || process.env.RAZE_PUBLIC_URL || null;

  const app = createApp({ pool, databaseUrl: url, env });
  const server = app.listen(port, '0.0.0.0', () => {
    const where = S.publicUrl || `http://127.0.0.1:${port}`;
    console.log(`\n  Raze console   ${where}`);
    console.log(`  postgres       ${embedded ? 'embedded' : 'DATABASE_URL'}`);
    console.log(`  webhook        ${where}/webhook`);
    console.log('\n  Register that webhook URL in the Razorpay dashboard to see live');
    console.log('  deliveries. Everything else works without it.\n');
    console.log('  ctrl-c to stop\n');
  });

  // Once setup is done, Raze runs. The console is somewhere to look at what it
  // did, not the thing that makes it happen — so the loops start here and keep
  // going whether or not anyone has the page open.
  try {
    const { createLoops } = require(path.join(RAZE, 'src', 'loops'));
    const actions = require(path.join(RAZE, 'src', 'actions'));
    await actions.ensure(pool);
    const setup = await pool.query(
      `SELECT * FROM raze_setup WHERE id = 1`).catch(() => ({ rows: [] }));
    const row = setup.rows[0];
    const ready = row && row.backfill_at && row.mapping_confirmed
      && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET;
    if (ready) {
      // The merchant's orders live in their database, not in Raze's.
      let merchantPool = pool;
      if (row.merchant_db) {
        const { Pool } = require('pg');
        merchantPool = new Pool({ connectionString: row.merchant_db, max: 4 });
        merchantPool.on('error', () => {});
      }

      const loops = createLoops({
        pool: merchantPool,
        razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
        merchant: {
          mappingConfirmed: true,
          // No expected-amount column means no amount can be verified, so this
          // merchant is escalate-only whatever else they chose.
          escalateOnly: !!row.escalate_only || !row.expected_column,
          autoRepair: true,
        },
        columns: {
          key: env.RAZE_ORDER_KEY_COLUMN || 'order_id',
          status: env.RAZE_STATUS_COLUMN || 'status',
          amount: env.RAZE_AMOUNT_COLUMN || 'credited_paise',
          // The merchant's own answer, never inference. Falling back to the
          // environment only when setup has not recorded one.
          expected: row.expected_column || env.RAZE_EXPECTED_COLUMN || null,
        },
        ordersTable: env.RAZE_ORDERS_TABLE || 'shop_orders',
        logFile: require('fs').existsSync(path.join(RAZE, 'measurement', 'deliveries.jsonl'))
          ? path.join(RAZE, 'measurement', 'deliveries.jsonl') : null,
        onEvent: (e) => {
          if (e.type === 'recovered' || e.type === 'escalated') {
            console.log(`  ${e.type.padEnd(10)} ${e.orderId}`);
          }
        },
      });
      await loops.start();
      console.log(`  running        reconcile ${loops.config.reconcileMs / 1000}s, `
        + `sweep ${loops.config.sweepMs / 1000}s
`);
      process.on('SIGINT', () => loops.stop());
    } else {
      console.log('  setup          not finished — nothing is being watched yet\n');
    }
  } catch (err) {
    console.log(`  loops          could not start: ${err.message}\n`);
  }

  // A deploy or a crash restarts this process; whatever was armed before it
  // should still be armed after. A failure to restore is reported and left
  // disarmed rather than pretended away.
  const restored = await restoreArmed({ pool, databaseUrl: url, env });
  if (restored && restored.error) {
    console.log(`  could not restore the ${restored.mode} merchant: ${restored.error}`);
  } else if (restored) {
    console.log(`  restored       ${restored} merchant re-armed after restart`);
  }

  const stop = async () => {
    server.close();
    // Tell the exit handler this kill was asked for, so it does not treat the
    // merchant dying during shutdown as a crash and restart it.
    S.stopping = true;
    if (S.tunnel && S.tunnel.stop) S.tunnel.stop();
    await stopMerchant();
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
};
