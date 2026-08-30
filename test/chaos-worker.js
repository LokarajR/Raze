'use strict';

/**
 * A worker that exists to be killed.
 *
 * Spawned by the chaos test, told to drain the inbox against a real database,
 * and then SIGKILLed at an arbitrary moment — very likely in the middle of a
 * transaction, which is the only interesting moment.
 *
 * SIGKILL is deliberate. A graceful shutdown proves nothing: the interesting
 * failure is the one where nothing gets to clean up, the socket dies mid-
 * statement, and Postgres rolls back a transaction the process still believed
 * was in progress. Simulating that in-process by throwing an exception tests the
 * error path, not the crash path.
 *
 *   node test/chaos-worker.js <databaseUrl> <table>
 */

const raze = require('../src/runtime');
const { Pool } = require('pg');

const databaseUrl = process.argv[2];
const table = process.argv[3] || 'chaos_orders';

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  pool.on('error', () => {});

  const rz = raze.create({ db: pool, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET });

  rz.on('payment.captured', async (event, tx) => {
    const p = event.payload.payment.entity;

    // A deliberately slow write, so a kill lands inside the transaction rather
    // than between them. Without this the window is microseconds and the test
    // would almost never hit the case it exists to check.
    await tx.query('SELECT pg_sleep(0.12)');

    await tx.query(
      `INSERT INTO "${table}" (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = "${table}".credited_paise + EXCLUDED.credited_paise,
             credit_count   = "${table}".credit_count + 1`,
      [p.order_id, p.amount]
    );
  });

  // Announce readiness so the parent kills a worker that is actually working.
  process.stdout.write('ready\n');

  for (;;) {
    const n = await rz.drain(50);
    if (n === 0) {
      process.stdout.write('drained\n');
      break;
    }
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`worker failed: ${err.message}\n`);
  process.exit(1);
});
