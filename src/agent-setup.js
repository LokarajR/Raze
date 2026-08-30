'use strict';

/**
 * `raze agent` — wire the Raze agent into this machine's Claude.
 *
 * The agent definition ships in the repository; the thing that cannot ship is
 * the connection to a particular merchant — their database and their Razorpay
 * keys. This writes that connection, locally, from values the merchant already
 * has in their .env, and never anywhere else.
 *
 * WHAT IT WRITES
 *
 *   .mcp.json   project-scoped MCP config. Gitignored, because it holds the
 *               merchant's credentials. Claude Code reads it automatically when
 *               opened in this directory.
 *
 * WHAT IT WILL NOT DO
 *
 * Invent credentials, or write a file that claims a connection it has not
 * tested. If the database is unreachable or Razorpay rejects the keys, it says
 * so and writes nothing — a config that looks right and does not work costs
 * more than no config.
 */

const fs = require('fs');
const path = require('path');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(__dirname, '..', '..', 'deliveries.jsonl'),
].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

module.exports = async function cmdAgent({ env, flag, RAZE }) {
  const out = path.join(RAZE, '.mcp.json');
  const dbUrl = flag('database-url', env.DATABASE_URL || process.env.DATABASE_URL || '');
  const table = flag('orders-table', env.RAZE_ORDERS_TABLE || 'orders');
  const keyId = env.RAZORPAY_KEY_ID || '';
  // Filled in from the merchant's own schema below; these are only fallbacks.
  const columns = {
    key: env.RAZE_ORDER_KEY_COLUMN || 'order_id',
    status: env.RAZE_STATUS_COLUMN || 'status',
    amount: env.RAZE_AMOUNT_COLUMN || 'credited_paise',
  };
  const keySecret = env.RAZORPAY_KEY_SECRET || '';

  console.log('');
  const problems = [];

  // ---- the database ------------------------------------------------------
  if (!dbUrl) {
    problems.push(
      'No database. Raze answers questions about the merchant\'s own order state, so it\n'
      + '  needs to read their database. Put DATABASE_URL in .env, or pass\n'
      + '  --database-url=postgres://...');
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1 });
    pool.on('error', () => {});
    try {
      await pool.query('SELECT 1');
      const t = await pool.query(
        'SELECT 1 FROM information_schema.tables WHERE table_name = $1', [table]);
      console.log(`  database    reachable`);
      if (t.rowCount === 0) {
        console.log(`  orders      no table named "${table}" — run \`raze infer\` to find the right one,`);
        console.log(`              or pass --orders-table=<name>`);
      } else {
        console.log(`  orders      "${table}"`);
        // Writing the table name and leaving the columns at their defaults sent
        // the merchant straight to MISMATCHED on their first question: order_id
        // and credited_paise are the demo merchant's names, not theirs. Derive
        // them from the same inference that produces the mapping.
        try {
          const infer = require(path.join(RAZE, 'src', 'infer'));
          const { proposals } = await infer.infer({ pool, corpusPath: LOG });
          const p = proposals.find(
            (x) => x.eventType === 'payment.captured' && x.spec.table === table);
          if (p) {
            const setCols = Object.keys(p.spec.set || {});
            const addCols = Object.keys(p.spec.add || {});
            columns.key = p.spec.key.column;
            columns.status = setCols[0] || columns.status;
            columns.amount = addCols.find((c) => /paise|amount|total/i.test(c)) || columns.amount;
            console.log(`  columns     ${columns.key} · ${columns.status} · ${columns.amount}`);
          } else {
            console.log(`  columns     could not work them out from "${table}" — `
              + 'run `raze infer` and set them by hand');
          }
        } catch (err) {
          console.log(`  columns     could not read the schema: ${err.message}`);
        }
      }
    } catch (err) {
      problems.push(`Database unreachable: ${err.message}`);
    } finally { await pool.end().catch(() => {}); }
  }

  // ---- Razorpay ----------------------------------------------------------
  if (!keyId || !keySecret) {
    problems.push(
      'No Razorpay keys. Without them the agent can read the merchant\'s database but\n'
      + '  cannot ask Razorpay what it recorded — which is the comparison the whole\n'
      + '  product rests on. Put RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  } else if (!/^rzp_test_/.test(keyId)) {
    problems.push(
      `RAZORPAY_KEY_ID is not a Test Mode key. The agent fires real deliveries when asked\n`
      + '  to check protection; point it at Test Mode.');
  } else {
    try {
      const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/payments?count=1', {
        headers: { authorization: auth },
      });
      if (r.ok) console.log('  razorpay    keys accepted (Test Mode)');
      else {
        const b = await r.json().catch(() => ({}));
        problems.push(`Razorpay rejected the keys: ${(b.error && b.error.description) || r.status}`);
      }
    } catch (err) { problems.push(`Could not reach Razorpay: ${err.message}`); }
  }

  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log('');
    console.log('  Nothing written. Fix the above and run `raze agent` again.');
    console.log('');
    return;
  }

  const config = {
    mcpServers: {
      raze: {
        command: 'node',
        args: [path.join(RAZE, 'bin', 'raze-mcp').replace(/\\/g, '/')],
        env: {
          DATABASE_URL: dbUrl,
          RAZORPAY_KEY_ID: keyId,
          RAZORPAY_KEY_SECRET: keySecret,
          RAZE_ORDERS_TABLE: table,
          RAZE_ORDER_KEY_COLUMN: columns.key,
          RAZE_STATUS_COLUMN: columns.status,
          RAZE_AMOUNT_COLUMN: columns.amount,
        },
      },
    },
  };
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + '\n');

  console.log('');
  console.log('  wrote .mcp.json  (gitignored — it holds your keys)');
  console.log('');
  console.log('  Restart Claude Code in this directory, then ask:');
  console.log('');
  console.log('      is everything alright?');
  console.log('');
  console.log('  For Claude Desktop instead, copy the mcpServers block from .mcp.json into');
  console.log('  its config file and restart it.');
  console.log('');
};
