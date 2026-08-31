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
  const { createApp, stopMerchant, restoreArmed, S, CONNECT, MERCHANT_SCHEMA } =
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
        // What setup decided, not what the defaults guess.
        //
        // These used to fall straight through to 'order_id' / 'status' /
        // 'credited_paise' / 'shop_orders', which are this repository's own demo
        // names. A restart therefore resumed a real merchant against columns
        // their database does not have, reported "running", and then failed on
        // every tick — the worst combination available, because the console said
        // it was watching while nothing could be repaired.
        columns: {
          key: row.key_column || env.RAZE_ORDER_KEY_COLUMN || 'order_id',
          status: row.status_column || env.RAZE_STATUS_COLUMN || 'status',
          amount: row.credited_column || env.RAZE_AMOUNT_COLUMN || 'credited_paise',
          // The merchant's own answer, never inference. Falling back to the
          // environment only when setup has not recorded one.
          expected: row.expected_column || env.RAZE_EXPECTED_COLUMN || null,
        },
        ordersTable: row.orders_table || env.RAZE_ORDERS_TABLE || 'shop_orders',
        // The same statement setup built, rebuilt from the same recorded
        // columns. A restart that omits it leaves the loops able to find drift
        // and unable to repair any of it.
        mappingSpec: require(path.join(RAZE, 'src', 'agent', 'build')).mappingSpecFor({
          table: row.orders_table,
          key: row.key_column,
          status: row.status_column,
          credited: row.credited_column,
          expected: row.expected_column || null,
        }),
        logFile: require('fs').existsSync(path.join(RAZE, 'measurement', 'deliveries.jsonl'))
          ? path.join(RAZE, 'measurement', 'deliveries.jsonl') : null,
        onEvent: (e) => {
          if (e.type === 'recovered' || e.type === 'escalated') {
            // The rule is the whole point of an escalation. Logging the order id
            // alone says something was refused without saying what refused it.
            console.log(`  ${e.type.padEnd(10)} ${e.orderId}`
              + (e.rule ? `  [${e.rule}]` : ''));
          } else if (e.type === 'error' || e.type === 'reconcile-failed') {
            // Silence here cost an afternoon: a loop was throwing on every pass
            // and the only visible symptom was a repair that never arrived.
            console.log(`  loop-error     ${e.where || ''} ${e.error || ''}`.slice(0, 200));
          } else if (e.type === 'polled') {
            console.log(`  polled         ${e.checked} open order(s), ${e.found} captured`);
          }
        },
      });
      // Everything the live webhook path needs to act on a delivery, put back
      // where it was before the restart. Without this the console comes up able
      // to reconcile but unable to verify a signature, so real deliveries would
      // be recorded and dropped while the minute-by-minute reconciler quietly
      // did all the work.
      S.loops = loops;
      CONNECT.merchantPool = merchantPool;
      CONNECT.databaseUrl = row.merchant_db || null;
      CONNECT.razorpay = { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
      CONNECT.webhookSecret = row.webhook_secret || null;
      CONNECT.chosen = {
        table: row.orders_table, key: row.key_column, status: row.status_column,
        credited: row.credited_column, expected: row.expected_column || null,
      };
      // Without this the console comes back reconciling a merchant while every
      // status it displays is read from its own database instead of theirs.
      const wired = app.locals.writeToolConfig && app.locals.writeToolConfig({
        databaseUrl: row.merchant_db,
        creds: CONNECT.razorpay,
        chosen: CONNECT.chosen,
      });
      console.log(wired
        ? `  tools          reading ${row.orders_table}.${row.credited_column}`
        : '  tools          NOT rewired — status will read the wrong database');

      await loops.start();
      if (app.locals.armWatchdog) app.locals.armWatchdog();
      if (!loops.lastTickAt) {
        console.log('  running        NOT confirmed — no pass completed yet');
      }
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
