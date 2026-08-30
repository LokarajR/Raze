'use strict';

/**
 * Layer 12 — the five states.
 *
 * Most monitoring tools have two: fine, and broken. That is the lie that gets
 * merchants hurt, because it files "I could not check" under "fine". These
 * assertions exist to stop that lie appearing here:
 *
 *   PROTECTED  armed, checked recently, no divergence
 *   DIVERGED   money Razorpay has that the merchant's system does not
 *   STALE      armed, but nothing has checked recently
 *   UNARMED    nothing is being watched at all
 *   BLIND      Razorpay unreachable — not the same as nothing being wrong
 *
 * STALE and BLIND are the point. A tool that reports either as green is worse
 * than no tool, because the merchant stops looking.
 *
 *   node test/states.test.js
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

function client(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'raze-mcp')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = ''; const waiting = new Map(); let id = 1; const errs = [];
  child.stderr.on('data', (d) => errs.push(String(d)));
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const n = id++; waiting.set(n, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    setTimeout(() => waiting.has(n) && (waiting.delete(n), rej(new Error('timeout ' + errs.join('').slice(0, 200)))), 60000);
  });
  return { child, send };
}

const payload = (r) => {
  const t = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : '{}';
  try { return JSON.parse(t); } catch { return {}; }
};

async function statusWith(env) {
  const c = client(env);
  await c.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const out = payload(await c.send('tools/call', { name: 'raze_status', arguments: {} }));
  c.child.kill();
  return out;
}

async function main() {
  const env = loadEnv();
  const { pool, url } = await connect();
  await migrate(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS state_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL, credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);

  console.log('\nLayer 12 tests  (the five states)\n');

  const base = { DATABASE_URL: url, RAZE_ORDERS_TABLE: 'state_orders' };
  const withKeys = {
    ...base,
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID || '',
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET || '',
  };

  // ---- BLIND: no credentials means unreachable, not clean ----------------
  const blind = await statusWith({ ...base, RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
  check('no Razorpay access reports BLIND, not PROTECTED',
    blind.state === 'BLIND', `got ${blind.state}`);
  check('BLIND says it does not know, rather than that nothing is wrong',
    /do not know|not the same as everything being fine/i.test(blind.says || ''), blind.says);

  // ---- BLIND: bad credentials are also unreachable ------------------------
  const badKeys = await statusWith({
    ...base, RAZORPAY_KEY_ID: 'rzp_test_invalid', RAZORPAY_KEY_SECRET: 'invalid',
  });
  check('credentials Razorpay rejects report BLIND, not PROTECTED',
    badKeys.state === 'BLIND', `got ${badKeys.state}`);

  if (!env.RAZORPAY_KEY_ID) {
    console.log('  SKIP  armed states — no Razorpay credentials');
  } else {
    // ---- UNARMED: reachable, but nothing is being watched ----------------
    await pool.query('TRUNCATE raze_expectations');
    const unarmed = await statusWith(withKeys);
    check('reachable but watching nothing reports UNARMED',
      unarmed.state === 'UNARMED', `got ${unarmed.state}`);

    // ---- arm something so the remaining states are reachable -------------
    await pool.query(
      `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
       VALUES ('order','order_state_test','payment.captured', now() + interval '1 hour')`);

    // ---- STALE: armed, never successfully checked -------------------------
    await pool.query('TRUNCATE raze_reconcile_runs');
    const stale = await statusWith(withKeys);
    check('armed but never checked reports STALE or DIVERGED, never PROTECTED',
      stale.state === 'STALE' || stale.state === 'DIVERGED', `got ${stale.state}`);

    // ---- the last SUCCESSFUL check is what counts -------------------------
    // A run that failed every minute for an hour must not read as coverage.
    await pool.query('TRUNCATE raze_reconcile_runs');
    await pool.query(
      `INSERT INTO raze_reconcile_runs (window_from, window_to, razorpay_count, local_count,
         drift_found, drift_repaired, ok, error, ran_at)
       VALUES (now() - interval '1 hour', now(), 0, 0, 0, 0, false, 'unreachable', now())`);
    const failedRuns = await statusWith(withKeys);
    check('recent FAILED runs do not count as a check',
      failedRuns.state !== 'PROTECTED', `got ${failedRuns.state}`);
    check('the reported timestamp is the last success, not the last attempt',
      failedRuns.last_successful_check === null && !!failedRuns.last_attempted_check,
      JSON.stringify({ ok: failedRuns.last_successful_check, any: failedRuns.last_attempted_check }));

    // ---- an old success is stale, not protected ---------------------------
    await pool.query('TRUNCATE raze_reconcile_runs');
    await pool.query(
      `INSERT INTO raze_reconcile_runs (window_from, window_to, razorpay_count, local_count,
         drift_found, drift_repaired, ok, ran_at)
       VALUES (now() - interval '3 hours', now() - interval '2 hours', 0, 0, 0, 0, true,
               now() - interval '2 hours')`);
    const old = await statusWith(withKeys);
    check('a successful check two hours ago is STALE, not PROTECTED',
      old.state !== 'PROTECTED', `got ${old.state}`);

    // ---- every state carries a sentence a merchant can read ---------------
    check('every state answers in money or plain language, never mechanism',
      typeof old.says === 'string' && old.says.length > 0
        && !/idempoten|HMAC|SKIP LOCKED|inbox/i.test(old.says),
      old.says);

    // ---- DIVERGED must name the money -------------------------------------
    const now = await statusWith(withKeys);
    if (now.state === 'DIVERGED') {
      check('DIVERGED states the rupee total and the count',
        /Rs [\d.]+ at risk across \d+/.test(now.says), now.says);
    } else {
      console.log(`  SKIP  DIVERGED wording — nothing is diverging (state ${now.state})`);
    }
  }

  // ---- each failing dependency names its own system ----------------------
  // Collapsing these is what sends a merchant to check the wrong thing. A
  // renamed column must never read as "Razorpay is down".
  const disconnected = await statusWith({
    ...withKeys, DATABASE_URL: 'postgres://raze:raze@127.0.0.1:1/postgres',
  });
  check('an unreachable database reports DISCONNECTED, not BLIND',
    disconnected.state === 'DISCONNECTED', `got ${disconnected.state}`);
  check('DISCONNECTED sends them to the database, not to Razorpay',
    /database/i.test(disconnected.says || '') && !/reach Razorpay/i.test(disconnected.says || ''),
    disconnected.says);

  if (env.RAZORPAY_KEY_ID) {
    const mismatched = await statusWith({
      ...withKeys, RAZE_ORDERS_TABLE: 'state_orders',
      RAZE_ORDER_KEY_COLUMN: 'a_column_that_does_not_exist',
    });
    check('a mapping that does not fit the schema reports MISMATCHED, not BLIND',
      mismatched.state === 'MISMATCHED', `got ${mismatched.state}`);
    check('MISMATCHED says both systems are fine and names the schema',
      /schema|does not match/i.test(mismatched.says || ''), mismatched.says);
  } else {
    console.log('  SKIP  MISMATCHED — no Razorpay credentials');
  }

  await pool.query('DROP TABLE IF EXISTS state_orders');
  await pool.query('TRUNCATE raze_expectations');
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
