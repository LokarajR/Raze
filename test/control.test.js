'use strict';

/**
 * Layer 13 — the control, as a permanent assertion.
 *
 * The full probe set is fired at an integration known to be correct, and the
 * build fails if it reports anything at all.
 *
 * This is not a demo moment. A detector that fires on correct code is worse than
 * no detector: it trains the person reading it to ignore findings, and the first
 * real one is then ignored too. Every claim Raze makes about somebody else's
 * integration rests on this staying green, so it runs on every build rather than
 * being demonstrated once and asserted about afterwards.
 *
 * Two integrations are checked, because they are correct for different reasons:
 *
 *   correct     a handler that deduplicates, verifies and orders properly by
 *               itself — no Raze in the path at all
 *   protected   a handler with real defects, behind the Raze runtime
 *
 * Both must report zero findings. If the second one ever does not, Raze does not
 * work. If the first one ever does not, the probes are wrong.
 *
 *   node test/control.test.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadEnv, signing } = require('./env');
const { connect, migrate, shutdown } = require('../src/db');
const { createAuditor } = require('../src/audit');

const RAZE = path.join(__dirname, '..');
const PORT = 4310;
const LOG = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function startMerchant(mode, databaseUrl, secret) {
  const child = spawn(process.execPath, [path.join(RAZE, 'examples', 'demo-merchant', 'server.js')], {
    env: { ...process.env, MODE: mode, PORT: String(PORT), DATABASE_URL: databaseUrl,
      RAZORPAY_WEBHOOK_SECRET: secret },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return child; } catch {}
    await sleep(200);
  }
  child.kill();
  throw new Error(`${mode} merchant did not start`);
}

async function main() {
  const env = loadEnv();
  const signer = signing(env);
  env.RAZORPAY_WEBHOOK_SECRET = signer.secret;

  const { pool, url } = await connect();
  await migrate(pool);
  const { MERCHANT_SCHEMA } = require(path.join(RAZE, 'examples', 'demo-merchant', 'server'));
  await pool.query(MERCHANT_SCHEMA);

  console.log('\nLayer 13 tests  (the control: zero findings on correct code)\n');

  for (const mode of ['correct', 'protected']) {
    const child = await startMerchant(mode, url, signer.secret);
    try {
      const auditor = createAuditor({
        targetUrl: `http://127.0.0.1:${PORT}/webhook`,
        pool, logFile: LOG, webhookSecret: signer.secret,
      });
      const results = await auditor.run();
      const findings = results.filter((r) => !r.pass);
      const skipped = results.filter((r) => r.skipped);

      check(`${mode}: every probe ran (none silently skipped)`,
        skipped.length === 0,
        skipped.map((s) => s.name).join(', '));

      check(`${mode}: the full probe set reports ZERO findings`,
        findings.length === 0,
        findings.map((f) => `${f.name}: ${f.observed}`).join(' | '));

      check(`${mode}: all ${results.length} probes accounted for`,
        results.length === 5, `got ${results.length}`);
    } finally {
      child.kill();
      await sleep(600);
    }
  }

  // The probes must be capable of finding something, or "zero findings" above
  // proves nothing. A detector that can never fire is not a detector.
  const broken = await startMerchant('broken', url, signer.secret);
  try {
    const auditor = createAuditor({
      targetUrl: `http://127.0.0.1:${PORT}/webhook`,
      pool, logFile: LOG, webhookSecret: signer.secret,
    });
    const results = await auditor.run();
    const findings = results.filter((r) => !r.pass);
    check('the same probes DO fire on a defective integration',
      findings.length > 0,
      'the probes found nothing on code known to be broken — they are not testing anything');
  } finally {
    broken.kill();
    await sleep(600);
  }

  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
