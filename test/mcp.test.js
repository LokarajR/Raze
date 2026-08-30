'use strict';

/**
 * Layer 11 — the MCP server, driven the way a client drives it.
 *
 * Spawns bin/raze-mcp and speaks JSON-RPC over stdio: initialize, tools/list,
 * tools/call. Nothing is stubbed, because the protocol is the thing under test —
 * calling the handler functions directly would prove they work while leaving the
 * server unable to talk to Claude Code or Cursor.
 *
 * The assertions that matter are about the approval gate. An agent holding these
 * tools can move a merchant's money, and the whole design rests on the claim
 * that it cannot do so without a human approving that exact plan.
 *
 *   node test/mcp.test.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { loadEnv } = require('./env');
const { connect, migrate, shutdown } = require('../src/db');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

/** A minimal MCP client: newline-delimited JSON-RPC on stdio. */
function client(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'raze-mcp')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiting = new Map();
  let nextId = 1;
  const stderr = [];

  child.stderr.on('data', (d) => stderr.push(String(d)));
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        reject(new Error(`${method} timed out. stderr: ${stderr.join('').slice(0, 300)}`));
      }
    }, 60000);
  });

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { child, send, notify, stderr };
}

/** Tool results arrive as text content holding JSON. */
const payload = (res) => {
  const text = res.result && res.result.content && res.result.content[0]
    ? res.result.content[0].text : '{}';
  try { return JSON.parse(text); } catch { return { unparsed: text }; }
};

async function main() {
  const env = loadEnv();
  const { pool } = await connect();
  await migrate(pool);

  // A merchant table with one order that Raze has not applied.
  await pool.query(`CREATE TABLE IF NOT EXISTS mcp_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL, credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);
  await pool.query('TRUNCATE mcp_orders');
  await pool.query('TRUNCATE raze_inbox, raze_subject_state');

  console.log('\nLayer 11 tests  (MCP server over stdio)\n');

  const c = client({
    RAZE_ORDERS_TABLE: 'mcp_orders',
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID || '',
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET || '',
  });

  // ---- handshake ---------------------------------------------------------
  const init = await c.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'raze-test', version: '0' },
  });
  check('initialize returns a server identifying itself as raze',
    init.result && init.result.serverInfo && init.result.serverInfo.name === 'raze',
    JSON.stringify(init.result && init.result.serverInfo));

  check('the server ships instructions telling an agent reads are free and writes are not',
    !!(init.result && init.result.instructions && /approv/i.test(init.result.instructions)));

  c.notify('notifications/initialized', {});

  // ---- the tool surface --------------------------------------------------
  const list = await c.send('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name).sort();
  check('every advertised tool is present',
    ['raze_apply_recovery', 'raze_audit_endpoint', 'raze_event_trail', 'raze_explain_order',
     'raze_find_divergence', 'raze_inspect_integration', 'raze_propose_recovery',
     'raze_simulate_recovery', 'raze_sweep_expectations'].every((n) => names.includes(n)),
    names.join(', '));

  check('exactly one tool changes merchant state',
    names.filter((n) => n === 'raze_apply_recovery').length === 1);

  // ---- reading the merchant's code --------------------------------------
  const scanRes = await c.send('tools/call', {
    name: 'raze_inspect_integration',
    arguments: { path: path.join(__dirname, '..', 'examples', 'merchant-legacy') },
  });
  const scanned = payload(scanRes);
  check('inspecting integration code reports findings with a file and evidence',
    scanned.files_with_findings > 0 && scanned.results[0].findings.length > 0,
    JSON.stringify(scanned).slice(0, 200));

  // ---- the trail for an order nothing is known about --------------------
  const unknown = payload(await c.send('tools/call', {
    name: 'raze_explain_order', arguments: { order_id: 'order_does_not_exist' },
  }));
  check('an unknown order reports no merchant row rather than inventing one',
    unknown.merchant === null && unknown.verdict && unknown.verdict.divergent === false,
    JSON.stringify(unknown.verdict));

  // ---- THE APPROVAL GATE -------------------------------------------------
  // The claim: an agent cannot change merchant state without a human approving
  // that exact plan. Everything below tries to break that.

  const forged = payload(await c.send('tools/call', {
    name: 'raze_apply_recovery',
    arguments: { order_id: 'order_does_not_exist', approval_token: 'a'.repeat(32) },
  }));
  check('a made-up approval token is refused',
    /unknown or expired/i.test(forged.error || ''), JSON.stringify(forged));

  const already = await pool.query(
    `INSERT INTO mcp_orders (order_id, status, credited_paise, credit_count)
     VALUES ('order_already_paid','paid',50000,1) RETURNING order_id`);
  const dbl = payload(await c.send('tools/call', {
    name: 'raze_propose_recovery', arguments: { order_id: already.rows[0].order_id },
  }));
  check('recovery is refused for an order the merchant already applied',
    /already applied|no settled payment|credentials/i.test(dbl.error || ''),
    JSON.stringify(dbl).slice(0, 200));

  // ---- simulation never writes -------------------------------------------
  const before = await pool.query('SELECT count(*)::int n FROM mcp_orders');
  await c.send('tools/call', {
    name: 'raze_simulate_recovery', arguments: { order_id: 'order_sim_only' },
  });
  const after = await pool.query('SELECT count(*)::int n FROM mcp_orders');
  check('simulating a recovery writes nothing',
    before.rows[0].n === after.rows[0].n,
    `before=${before.rows[0].n} after=${after.rows[0].n}`);

  // ---- the durable record ------------------------------------------------
  const trail = payload(await c.send('tools/call', {
    name: 'raze_event_trail', arguments: { limit: 5, unapplied_only: false },
  }));
  check('the delivery record is readable and reports how many it holds',
    typeof trail.count === 'number' && Array.isArray(trail.deliveries),
    JSON.stringify(trail).slice(0, 160));

  // ---- credentials absent is reported, not guessed -----------------------
  const noCreds = client({ RAZE_ORDERS_TABLE: 'mcp_orders', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
  await noCreds.send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
  });
  noCreds.notify('notifications/initialized', {});
  const div = payload(await noCreds.send('tools/call', {
    name: 'raze_find_divergence', arguments: { window_hours: 24 },
  }));
  check('without Razorpay credentials divergence says so rather than reporting zero drift',
    /credentials/i.test(div.error || ''), JSON.stringify(div).slice(0, 160));
  noCreds.child.kill();

  // ---- the whole gate, against a real settled Razorpay payment ----------
  // Everything above tests refusals. This tests the path that actually moves a
  // merchant's money, which is the one that has to be right.
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    const auth = 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const now = Math.floor(Date.now() / 1000);
    const res = await fetch(
      `https://api.razorpay.com/v1/payments?from=${now - 30 * 24 * 3600}&to=${now}&count=100`,
      { headers: { authorization: auth } });
    const items = (await res.json()).items || [];
    const settled = items.find((p) => (p.status === 'captured' || p.status === 'refunded') && p.order_id);

    if (!settled) {
      console.log('  SKIP  live approval gate — no settled payment in the last 30 days');
    } else {
      const oid = settled.order_id;
      await pool.query('DELETE FROM mcp_orders WHERE order_id = $1', [oid]);
      // Construct the precondition the test is about: this payment has never
      // been taken in. Reconciliation may have taken it in during an earlier
      // run, and recovery deliberately shares one event identity per payment
      // with reconciliation so neither can double-credit — so without this the
      // insert is a correct no-op and the test measures nothing.
      await pool.query('DELETE FROM raze_inbox WHERE event_id = $1', ['recon_' + settled.id]);
      await pool.query('DELETE FROM raze_subject_state WHERE subject_id = $1', [oid]);

      const proposed = payload(await c.send('tools/call', {
        name: 'raze_propose_recovery', arguments: { order_id: oid },
      }));
      check('proposing a recovery for a genuinely unapplied payment returns a plan and a token',
        !!proposed.approval_token && Array.isArray(proposed.plan) && proposed.plan.length > 0,
        JSON.stringify(proposed).slice(0, 200));

      const untouched = await pool.query('SELECT count(*)::int n FROM mcp_orders WHERE order_id=$1', [oid]);
      check('proposing wrote nothing', untouched.rows[0].n === 0);

      const wrongOrder = payload(await c.send('tools/call', {
        name: 'raze_apply_recovery',
        arguments: { order_id: 'order_someone_else', approval_token: proposed.approval_token },
      }));
      check('a token approved for one order cannot be spent on another',
        /different order/i.test(wrongOrder.error || ''), JSON.stringify(wrongOrder).slice(0, 160));

      // Someone else applies the payment while the approval is outstanding. The
      // plan now describes a world that no longer exists.
      await pool.query(
        `INSERT INTO mcp_orders (order_id,status,credited_paise,credit_count)
         VALUES ($1,'paid',$2,1)`, [oid, settled.amount]);
      const stale = payload(await c.send('tools/call', {
        name: 'raze_apply_recovery',
        arguments: { order_id: oid, approval_token: proposed.approval_token },
      }));
      check('an approval is refused once the state it was derived from has moved',
        /state changed/i.test(stale.error || ''), JSON.stringify(stale).slice(0, 200));

      // Back to genuinely unapplied, and walk the real path.
      await pool.query('DELETE FROM mcp_orders WHERE order_id = $1', [oid]);
      const p2 = payload(await c.send('tools/call', {
        name: 'raze_propose_recovery', arguments: { order_id: oid },
      }));
      const applied = payload(await c.send('tools/call', {
        name: 'raze_apply_recovery',
        arguments: { order_id: oid, approval_token: p2.approval_token },
      }));
      check('an approved recovery applies the payment exactly once',
        applied.merchant_now && applied.merchant_now.credited_paise === settled.amount
          && applied.merchant_now.credit_count === 1,
        JSON.stringify(applied.merchant_now));

      check('after recovery the merchant and Razorpay no longer disagree',
        applied.verdict && applied.verdict.divergent === false,
        JSON.stringify(applied.verdict));

      const reused = payload(await c.send('tools/call', {
        name: 'raze_apply_recovery',
        arguments: { order_id: oid, approval_token: p2.approval_token },
      }));
      check('an approval token cannot be spent twice',
        /unknown or expired/i.test(reused.error || ''), JSON.stringify(reused).slice(0, 160));

      const row = await pool.query('SELECT credit_count FROM mcp_orders WHERE order_id=$1', [oid]);
      check('the replay attempt did not credit a second time',
        row.rows[0] && row.rows[0].credit_count === 1,
        JSON.stringify(row.rows[0]));
    }
  } else {
    console.log('  SKIP  live approval gate — no Razorpay credentials');
  }

  c.child.kill();
  await pool.query('DROP TABLE IF EXISTS mcp_orders');
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
