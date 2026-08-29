'use strict';

/**
 * Layer 4 tests — the audit, run against all three integrations.
 *
 * The important assertion is the control: auditing a correct integration must
 * produce zero findings. A detector that fires on correct code is worse than no
 * detector, so that case is a hard failure of the test suite, not a warning.
 *
 *   node raze/test/layer4.test.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { connect, migrate, shutdown } = require('../src/db');
const { createAuditor } = require('../src/audit');

const ROOT = path.join(__dirname, '..', '..');
const RAZE = path.join(__dirname, '..');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(ROOT, 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));
const PORT = Number(process.env.AUDIT_TEST_PORT || 4177);

function loadEnv() {
  const out = {};
  const raw = fs.readFileSync(path.join(ROOT, 'probe-server', '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The merchant runs in its own process, but must connect to the Postgres this
 * test already started — two processes cannot both boot the embedded server on
 * one data directory. DATABASE_URL makes the child join rather than start.
 */
async function startMerchant(mode, env, databaseUrl) {
  const child = spawn(process.execPath, [path.join(RAZE, 'examples', 'demo-merchant', 'server.js')], {
    env: {
      ...process.env,
      MODE: mode,
      PORT: String(PORT),
      RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return child;
    } catch {}
    await sleep(200);
  }
  child.kill();
  throw new Error(`merchant (${mode}) did not start`);
}

async function stopMerchant(child) {
  if (!child) return;
  child.kill();
  await sleep(600);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function auditMode(mode, env, pool, databaseUrl) {
  const child = await startMerchant(mode, env, databaseUrl);
  const auditor = createAuditor({
    targetUrl: `http://127.0.0.1:${PORT}/webhook`,
    pool, logFile: LOG, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });
  const results = await auditor.run();
  await stopMerchant(child);
  return results;
}

const show = (mode, results) => {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${mode}: ${results.length - failed.length}/${results.length} pass, ${failed.length} finding(s)`);
  for (const r of results) {
    console.log(`    ${r.pass ? 'ok  ' : 'FIND'}  ${r.title.padEnd(24)} ${r.observed}`);
  }
  console.log('');
};

async function main() {
  const env = loadEnv();
  const { pool, url } = await connect();
  await migrate(pool);
  await pool.query(require('../examples/demo-merchant/server').MERCHANT_SCHEMA);
  console.log('\nLayer 4 tests  (real captured deliveries, state read from Postgres)\n');

  // -- broken ---------------------------------------------------------------
  const broken = await auditMode('broken', env, pool, url);
  show('broken', broken);
  const brokenFindings = broken.filter((r) => !r.pass).map((r) => r.name).sort();
  check('broken integration is caught on duplicate delivery',
    brokenFindings.includes('duplicate-delivery'));
  check('broken integration is caught on timeout-induced retry',
    brokenFindings.includes('timeout-retry'));
  check('broken integration is NOT flagged on ordering it handles correctly',
    !brokenFindings.includes('out-of-order'),
    `findings: ${brokenFindings.join(', ')}`);
  // The refund finding on the broken merchant is real, not noise: replaying the
  // genuine 15-delivery refund ladder against a handler with no dedupe subtracts
  // the refund fifteen times and drives the balance negative. Missing dedupe
  // corrupts refunds exactly as it corrupts payments.
  check('broken integration is caught corrupting state on the refund ladder',
    brokenFindings.includes('refund-event'),
    `findings: ${brokenFindings.join(', ')}`);

  // Two defects, four findings. The spec's "exactly 2" counts defects; the probes
  // count symptoms, and one missing dedupe surfaces in three of them.
  check('every broken finding traces to one of the two documented defects',
    brokenFindings.every((f) =>
      ['duplicate-delivery', 'timeout-retry', 'refund-event', 'tampered-signature'].includes(f)),
    `findings: ${brokenFindings.join(', ')}`);
  check('broken integration is caught accepting a tampered signature',
    brokenFindings.includes('tampered-signature'));

  // -- correct (the control) ------------------------------------------------
  const correct = await auditMode('correct', env, pool, url);
  show('correct', correct);
  check('CONTROL: correct integration produces zero findings',
    correct.every((r) => r.pass),
    `findings: ${correct.filter((r) => !r.pass).map((r) => `${r.name} (${r.observed})`).join('; ')}`);

  // -- protected ------------------------------------------------------------
  const protectedResults = await auditMode('protected', env, pool, url);
  show('protected', protectedResults);
  check('the same broken handler behind Raze passes every probe',
    protectedResults.every((r) => r.pass),
    `findings: ${protectedResults.filter((r) => !r.pass).map((r) => `${r.name} (${r.observed})`).join('; ')}`);

  // -- the control is repeatable -------------------------------------------
  const correctAgain = await auditMode('correct', env, pool, url);
  check('CONTROL is stable across runs (zero findings again)',
    correctAgain.every((r) => r.pass),
    `findings: ${correctAgain.filter((r) => !r.pass).map((r) => r.name).join(', ')}`);

  await shutdown(pool);
  console.log(`${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
