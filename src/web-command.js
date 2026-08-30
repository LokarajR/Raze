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
  const { createApp, stopMerchant, S, MERCHANT_SCHEMA } = require(path.join(RAZE, 'src', 'web', 'server'));

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

  const stop = async () => {
    server.close();
    await stopMerchant();
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await new Promise(() => {});
};
