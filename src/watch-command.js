'use strict';

/**
 * `raze watch` — arm expectations without the merchant writing any code.
 *
 * The Expectation Ledger answers a question reconciliation structurally cannot:
 * was something supposed to happen that never did. Reconciliation asks Razorpay
 * what exists; if the customer never paid there is nothing to enumerate, and
 * only a deadline notices.
 *
 * That needs an expectation to exist when an order is created. The library way
 * is for the merchant to call rz.expect() inside their own transaction, which is
 * stronger — an order then cannot exist without its expectation. But it requires
 * them to have code, and the whole point of this path is a merchant who has
 * none.
 *
 * So this watches their orders table and arms an expectation for any row that
 * does not have one.
 *
 * THE HONEST TRADE-OFF
 *
 * Polling is weaker than calling expect() in the merchant's own transaction. A
 * row created and paid entirely within one polling interval is seen only after
 * the fact, and a row deleted before the first poll is never seen at all.
 * Nothing is lost when that happens — the payment still reconciles — but the
 * absence case for that specific order goes unwatched. Printed at startup rather
 * than buried here, because a merchant choosing this should know it.
 */

const path = require('path');

const IDENT = /^[a-z_][a-z0-9_]*$/i;

function assertIdent(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

module.exports = async function cmdWatch({ flag, has, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;

  const table = flag('table', null);
  const keyColumn = flag('key', null);
  const within = String(flag('within', '15m'));
  const intervalMs = Number(flag('interval', 15)) * 1000;
  const once = has('once');

  if (!table || !keyColumn) {
    console.error('\n  raze watch needs the table your orders live in and the column');
    console.error('  holding the Razorpay order id:');
    console.error('');
    console.error('    raze watch --table orders --key razorpay_order_id [--within 15m]');
    console.error('');
    console.error('  Add --once to arm expectations for existing rows and exit.');
    console.error('  Use `raze insights` to see what deadline your own traffic justifies.\n');
    process.exit(1);
  }

  assertIdent(table, 'table name');
  assertIdent(keyColumn, 'key column');

  const { pool } = await connect();
  await migrate(pool);

  // Validate against the live catalogue rather than trusting the arguments.
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  if (cols.length === 0) throw new Error(`no such table "${table}"`);
  if (!cols.some((c) => c.column_name === keyColumn)) {
    throw new Error(`table "${table}" has no column "${keyColumn}"`);
  }

  const parse = (s) => {
    const m = String(s).match(/^(\d+)\s*(ms|s|m|h|d)$/);
    if (!m) throw new Error(`unparseable duration: ${s}`);
    return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  };
  const withinMs = parse(within);

  console.log('');
  console.log(`  watching "${table}"."${keyColumn}"`);
  console.log(`  arming an expectation of payment.captured within ${within}`);
  console.log('');
  console.log('  Note: polling sees a row after it is committed, so an order created and');
  console.log('  paid inside one interval is armed late. Calling rz.expect() in your own');
  console.log('  transaction is stronger — an order then cannot exist unwatched. Use this');
  console.log('  when you would otherwise have no expectations at all.');
  console.log('');

  /**
   * Arm anything not already watched.
   *
   * The insert is a single statement so a row cannot be armed twice by two
   * pollers, and the partial unique index on open expectations enforces it.
   */
  async function sweep() {
    const { rowCount } = await pool.query(
      `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
       SELECT 'order', t."${keyColumn}", 'payment.captured',
              now() + ($1 || ' milliseconds')::interval
         FROM "${table}" t
        WHERE t."${keyColumn}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM raze_expectations e
             WHERE e.subject_id = t."${keyColumn}"
               AND e.expected_event = 'payment.captured'
          )
       ON CONFLICT DO NOTHING`,
      [String(withinMs)]
    );
    return rowCount;
  }

  const armed = await sweep();
  console.log(`  armed ${armed} expectation(s) for existing rows`);

  if (once) {
    console.log('');
    await shutdown(pool);
    return;
  }

  console.log(`  polling every ${intervalMs / 1000}s — ctrl-c to stop`);
  console.log('');

  const timer = setInterval(async () => {
    try {
      const n = await sweep();
      if (n > 0) console.log(`  armed ${n} new expectation(s)`);
    } catch (err) {
      console.error(`  watch error: ${err.message}`);
    }
  }, intervalMs);

  const stop = async () => {
    clearInterval(timer);
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
};
