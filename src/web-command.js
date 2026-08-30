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

  S.publicUrl = process.env.PUBLIC_URL || null;

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
    await stopMerchant();
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
};
