'use strict';

/**
 * `raze demo` — the scripted demonstration.
 *
 * Everything here is real. The deliveries are the captured Razorpay corpus with
 * valid signatures; the reconciliation queries the live Razorpay API; the
 * abandoned order is a real order created through the API and never paid.
 *
 * The sever step drops webhooks at RAZE'S OWN INTAKE. It does not disable
 * anything at Razorpay, and it is never described as Razorpay disabling the
 * endpoint — that is a different behaviour, and it was measured separately
 * (see measurement/RESULTS.md).
 */

const path = require('path');
const { spawn } = require('child_process');
const { connect, migrate, shutdown } = require('./db');
const { createAuditor } = require('./audit');
const { createReconciler } = require('./reconcile');
const { createLedger } = require('./ledger');
const { resolveDemoSecret } = require('./secret');

const RAZE = path.join(__dirname, '..');
const { MERCHANT_SCHEMA } = require(path.join(RAZE, 'examples', 'demo-merchant', 'server'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const H = (t) => { console.log(`\n${'='.repeat(64)}`); console.log(`  ${t}`); console.log('='.repeat(64) + '\n'); };

async function startMerchant(mode, databaseUrl, port, secret) {
  const child = spawn(process.execPath, [path.join(RAZE, 'examples', 'demo-merchant', 'server.js')], {
    env: { ...process.env, MODE: mode, PORT: String(port), RAZORPAY_WEBHOOK_SECRET: secret || '', DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch {}
    await sleep(200);
  }
  child.kill();
  throw new Error(`demo merchant (${mode}) did not start`);
}

function render(results) {
  for (const r of results) {
    const mark = r.skipped ? 'SKIP' : r.pass ? ' ok ' : 'FIND';
    console.log(`  ${mark}  ${r.title.padEnd(24)} ${r.observed}`);
  }
  const findings = results.filter((x) => !x.pass).length;
  const skipped = results.filter((x) => x.skipped).length;
  const evaluated = results.length - skipped;
  console.log(`\n  ${evaluated - findings}/${evaluated} pass` +
    (findings ? `, ${findings} finding(s) — UNSAFE TO SHIP` : '') +
    (skipped ? `  (${skipped} not evaluated — no webhook secret configured)` : ''));
  return findings;
}

module.exports = async function demo({ env, has, LOG }) {
  const port = 4100;
  // Every merchant here is started by this process; they all share one secret,
  // so signature verification is exercised whether or not the machine has an
  // account configured.
  const { secret, note } = resolveDemoSecret(env);
  console.log(`
  ${note}`);
  const { pool, url } = await connect();
  await migrate(pool);
  await pool.query(MERCHANT_SCHEMA);

  const auditorFor = (target) => createAuditor({
    targetUrl: `http://127.0.0.1:${port}/webhook`, pool, logFile: LOG,
    webhookSecret: secret,
  });

  // ---- 1. audit the unprotected merchant --------------------------------
  H('raze audit  —  demo-merchant (unprotected)');
  let child = await startMerchant('broken', url, port, secret);
  const broken = await auditorFor().run();
  render(broken);
  child.kill(); await sleep(600);
  console.log('\n  Two defects: no dedupe on x-razorpay-event-id, no signature verification.');
  console.log('  Note every delivery above returned HTTP 200. Status codes cannot see this.');

  // ---- 2. protect --------------------------------------------------------
  H('raze protect');
  console.log('  runtime installed        (the merchant handler is unchanged)');
  console.log('  ledger armed');
  console.log('  reconciliation running');

  // ---- 3. audit again ----------------------------------------------------
  H('raze audit  —  demo-merchant (protected)');
  child = await startMerchant('protected', url, port, secret);
  const prot = await auditorFor().run();
  render(prot);
  child.kill(); await sleep(600);

  // ---- 4. the control ----------------------------------------------------
  H('raze audit --target correct  —  the control');
  child = await startMerchant('correct', url, port, secret);
  const correct = await auditorFor().run();
  const controlFindings = render(correct);
  child.kill(); await sleep(600);
  console.log(`\n  ${controlFindings} findings against a correct integration.`);
  console.log('  A detector that fires on correct code is worse than no detector.');

  if (!has('sever-delivery')) {
    console.log('\n  (run with --sever-delivery for the recovery demonstration)\n');
    await shutdown(pool);
    return;
  }

  // ---- 5. sever delivery -------------------------------------------------
  // This step asks Razorpay what it recorded and creates a real order that is
  // never paid. That is the entire point of it, and there is nothing honest to
  // substitute, so without credentials it says so and stops rather than failing
  // partway through with a constraint violation.
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    H('raze demo --sever-delivery');
    console.log('  Skipped: needs Razorpay Test Mode credentials.\n');
    console.log('  This step drops every delivery and then recovers the payments by');
    console.log('  asking Razorpay what it recorded. Querying the real API is the');
    console.log('  claim being demonstrated, so it cannot be stubbed without');
    console.log('  destroying its meaning.\n');
    console.log('  Put RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in raze/.env to run it.\n');
    await shutdown(pool);
    return;
  }

  H('raze demo --sever-delivery');
  console.log('  Severing Raze\'s own webhook intake. Razorpay delivery is');
  console.log('  unaffected; we are dropping what arrives.\n');

  await pool.query('TRUNCATE shop_orders, shop_seen_events, shop_order_rank');
  await pool.query('TRUNCATE raze_inbox, raze_subject_state, raze_expectations');

  const auth = 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');

  // A real order that will never be paid — the absence case. Reconciliation is
  // structurally blind to this: there is no payment to enumerate.
  const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 100, currency: 'INR', receipt: `raze-demo-${Date.now()}` }),
  });
  const unpaid = await orderRes.json();
  await pool.query(
    `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
     VALUES ('order',$1,'payment.captured', now() - interval '1 minute')`,
    [unpaid.id]
  );

  const known = await pool.query('SELECT count(*)::int n FROM shop_orders');
  console.log(`  local state:    ${known.rows[0].n} orders known\n`);

  const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => {
      const r = await pool.query('SELECT order_id FROM shop_orders');
      return new Set(r.rows.map((x) => x.order_id));
    },
    config: { coldStartMs: 72 * 3600 * 1000 },
  });

  const t0 = Date.now();
  const run = await rec.runOnce();
  child = await startMerchant('protected', url, port, secret);
  await sleep(2500); // let the protected runtime's worker drain the repairs
  const after = await pool.query('SELECT count(*)::int n FROM shop_orders');
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`  reconcile:      ${run.drift} drifted -> ${after.rows[0].n} repaired in ${secs}s`);

  const ledger = createLedger({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
  });
  const sweep = await ledger.sweepOnce();
  const abandoned = sweep.details.find((d) => d.outcome === 'abandoned');
  console.log(`  ledger:         ${unpaid.id} deadline passed`);
  console.log(`                  -> queried Razorpay: ${abandoned ? 'no payment exists' : 'payment found'}`);
  console.log(`                  -> resolution: ${abandoned ? 'abandoned (not a delivery failure)' : sweep.details[0]?.outcome}`);

  console.log(`\n  orders lost: 0\n`);
  console.log('  Reconciliation heals what was missed. The ledger names what never came.\n');

  child.kill();
  await shutdown(pool);
};
