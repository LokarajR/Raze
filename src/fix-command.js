'use strict';

/**
 * `raze fix` — the repair agent command.
 *
 * Lives in its own module rather than in bin/raze so the CLI stays readable.
 *
 * The division of labour is the point: the deterministic probes decide what is
 * broken and whether it got fixed; the model only writes the patch. A patch that
 * does not make the probes pass is a failed patch, and the original file is
 * restored.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function cmdFix({ env, flag, has, LOG, RAZE, deps }) {
  const { connect, migrate, shutdown, createAuditor, MERCHANT_SCHEMA, renderAudit } = deps;

  const { repair, restore, MODEL } = require(path.join(RAZE, 'src', 'agent'));
  const targetFile = String(flag('file', path.join(RAZE, 'examples', 'merchant-legacy', 'server.js')));
  const port = Number(flag('port', 4200));

  if (has('restore')) {
    console.log(restore(targetFile) ? '\n  original restored\n' : '\n  no backup found\n');
    return;
  }

  const { detectProvider } = require(path.join(RAZE, 'src', 'agent'));
  const provider = detectProvider();
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!provider) {
    console.error('');
    console.error('raze fix needs a way to generate a patch. Any one of these:');
    console.error('  - the Claude Code CLI on PATH   (uses your subscription, no API credits)');
    console.error('  - ANTHROPIC_API_KEY with credit');
    console.error('  - ollama installed              (fully local and offline)');
    console.error('');
    console.error('Every other raze command is deterministic and needs none of them.');
    process.exit(1);
  }

  const { pool, url } = await connect();
  await migrate(pool);
  await pool.query(MERCHANT_SCHEMA);

  let child = null;

  const startTarget = async () => {
    child = spawn(process.execPath, [targetFile], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: url,
        RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET || '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
      } catch {}
      await sleep(200);
    }
    throw new Error(`target did not start on :${port}\n${stderr.slice(0, 500)}`);
  };

  const stopTarget = async () => {
    if (child) { child.kill(); child = null; await sleep(700); }
  };

  // One audit round. The target is restarted first so that whatever is on disk
  // right now is what actually runs — a patch is only credited if the running
  // process is the patched code.
  const runAudit = async () => {
    await stopTarget();
    await startTarget();
    const auditor = createAuditor({
      targetUrl: `http://127.0.0.1:${port}/webhook`,
      pool,
      logFile: LOG,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    });
    return auditor.run();
  };

  const label = path.basename(path.dirname(targetFile));

  console.log(`\n  target   ${path.relative(process.cwd(), targetFile)}`);
  console.log(`  patcher  ${provider}` + (provider === 'claude' ? ' CLI (subscription, no API credits)' : ''));
  console.log(`  model    ${MODEL}`);
  console.log(`  probes   deterministic, business state read from Postgres\n`);

  console.log('  BEFORE\n');
  const before = await runAudit();
  renderAudit(label, before);

  let result;
  try {
    result = await repair({ filePath: targetFile, runAudit, apiKey });
  } catch (err) {
    await stopTarget();
    await shutdown(pool);
    console.error(`\n  repair failed: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n  AFTER\n');
  const after = await runAudit();
  renderAudit(label, after);

  await stopTarget();
  await shutdown(pool);

  if (result.ok) {
    console.log(`  Repaired in ${result.rounds} round(s).`);
    console.log('  The patch was written at run time from this file\'s real source and the');
    console.log('  failures the probes actually observed. Nothing was canned, and the same');
    console.log('  probes verified it.\n');
    console.log('  Restore the original with:  raze fix --restore\n');
  } else {
    console.log(`  ${result.message}\n`);
  }

  process.exit(result.ok ? 0 : 1);
};
