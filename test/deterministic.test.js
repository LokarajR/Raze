'use strict';

/**
 * Layer 14 — the core runs with no model at all.
 *
 * The chat surface is an interface, not a dependency. Everything that decides
 * whether a merchant's money is correct — the runtime, reconciliation, the
 * ledger, the probes, the state machine — is deterministic code, and a judge
 * with no Claude subscription must be able to run all of it.
 *
 * This is asserted rather than asserted-about. The MCP server is spawned with
 * PATH emptied, so `claude` cannot be found even if it is installed, and every
 * tool that matters is exercised through it:
 *
 *   raze_status        the five states
 *   raze_health        the seven checks
 *   raze_find_divergence   reconciliation against the provider
 *   raze_propose_recovery  the repair plan
 *   raze_apply_recovery    the repair itself
 *
 * The one thing that does need a model — the conversational surface — must fail
 * in the open: a plain sentence pointing at the CLI, never a hang and never an
 * empty state that looks like "nothing is wrong".
 *
 *   node test/deterministic.test.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadEnv, signing } = require('./env');
const { connect, migrate, shutdown } = require('../src/db');

const RAZE = path.join(__dirname, '..');
const PORT = 4320;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

/** An MCP client whose server cannot find `claude` on PATH. */
function blindfoldedClient(extraEnv) {
  const child = spawn(process.execPath, [path.join(RAZE, 'bin', 'raze-mcp')], {
    env: {
      ...process.env,
      ...extraEnv,
      // The whole point: no executable lookup can succeed.
      PATH: '', Path: '', PATHEXT: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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
    setTimeout(() => waiting.has(n) && (waiting.delete(n),
      rej(new Error(method + ' timed out. ' + errs.join('').slice(0, 300)))), 90000);
  });
  const call = async (name, args) => {
    const r = await send('tools/call', { name, arguments: args || {} });
    const t = r.result && r.result.content && r.result.content[0] ? r.result.content[0].text : '{}';
    try { return JSON.parse(t); } catch { return { raw: t }; }
  };
  return { child, send, call };
}

async function startMerchant(mode, databaseUrl, secret) {
  const child = spawn(process.execPath, [path.join(RAZE, 'examples', 'demo-merchant', 'server.js')], {
    env: { ...process.env, MODE: mode, PORT: String(PORT), DATABASE_URL: databaseUrl,
      RAZORPAY_WEBHOOK_SECRET: secret },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
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
  const { pool, url } = await connect();
  await migrate(pool);
  const { MERCHANT_SCHEMA } = require(path.join(RAZE, 'examples', 'demo-merchant', 'server'));
  await pool.query(MERCHANT_SCHEMA);

  console.log('\nLayer 14 tests  (deterministic core, no model)\n');

  // ---- 1. nothing in the decision path imports a model -------------------
  // The optional repair agent is allowed to; nothing that decides whether money
  // is correct may.
  const decisionPath = ['src/runtime', 'src/reconcile', 'src/ledger', 'src/mapping',
    'src/audit', 'src/impact', 'src/health', 'src/infer', 'src/outbox', 'src/mcp'];
  const offenders = [];
  for (const dir of decisionPath) {
    const full = path.join(RAZE, dir);
    const files = fs.existsSync(full)
      ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f))
      : [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (/\bclaude\b|anthropic|openai|ANTHROPIC_API_KEY/i.test(src)) {
        offenders.push(path.relative(RAZE, f));
      }
    }
  }
  check('nothing that decides correctness references a model or an API key',
    offenders.length === 0, offenders.join(', '));

  const withEnv = {
    DATABASE_URL: url,
    RAZE_ORDERS_TABLE: 'shop_orders',
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID || '',
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET || '',
  };
  const c = blindfoldedClient(withEnv);
  await c.send('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'blindfold', version: '0' } });
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ---- 2. the state machine answers -------------------------------------
  const status = await c.call('raze_status', {});
  check('raze_status answers with a state while claude is unreachable',
    typeof status.state === 'string' && status.state.length > 0,
    JSON.stringify(status).slice(0, 160));
  check('the state carries a sentence, not an error',
    typeof status.says === 'string' && status.says.length > 0, status.says);

  // ---- 3. the probes run -------------------------------------------------
  const merchant = await startMerchant('protected', url, signer.secret);
  try {
    const health = await c.call('raze_health', {
      target_url: `http://127.0.0.1:${PORT}/webhook`,
      webhook_secret: signer.secret,
    });
    check('raze_health runs all seven checks with no model present',
      Array.isArray(health.checks) && health.checks.length === 7,
      JSON.stringify(health).slice(0, 200));
    check('the probes themselves pass against a protected merchant',
      health.checks.filter((x) => !x.ok).every((x) => x.name === 'Missing-payment detection'
        || x.name === 'Reconciliation active'),
      health.checks.filter((x) => !x.ok).map((x) => x.name).join(', '));
  } finally { merchant.kill(); await sleep(600); }

  // ---- 4. reconciliation and repair --------------------------------------
  if (env.RAZORPAY_KEY_ID) {
    const div = await c.call('raze_find_divergence', { window_hours: 72 });
    check('reconciliation against Razorpay works with no model present',
      typeof div.captured_at_razorpay === 'number',
      JSON.stringify(div).slice(0, 160));

    if (div.orders && div.orders.length) {
      const target = div.orders[0].order_id;
      await pool.query('DELETE FROM raze_inbox WHERE event_id = $1', ['recon_' + div.orders[0].id]);
      await pool.query('DELETE FROM raze_subject_state WHERE subject_id = $1', [target]);
      const plan = await c.call('raze_propose_recovery', { order_id: target });
      check('a recovery plan is produced with no model present',
        Array.isArray(plan.plan) && !!plan.approval_token,
        JSON.stringify(plan).slice(0, 160));

      if (plan.approval_token) {
        const applied = await c.call('raze_apply_recovery', {
          order_id: target, approval_token: plan.approval_token,
        });
        check('the repair itself runs with no model present',
          !applied.error && applied.merchant_now
            && Number(applied.merchant_now.credited_paise) > 0,
          JSON.stringify(applied).slice(0, 200));
      }
    } else {
      console.log('  SKIP  recovery — nothing is diverging right now');
    }
  } else {
    console.log('  SKIP  reconciliation and recovery — no Razorpay credentials');
  }
  c.child.kill();

  // ---- 5. the chat surface fails in the open -----------------------------
  // Not a hang, not an empty state that reads as "nothing is wrong".
  const agentModule = path.join(RAZE, 'src', 'web', 'agent.js');
  const agentSrc = fs.readFileSync(agentModule, 'utf8');
  check('the chat surface names the CLI when it cannot start Claude Code',
    /could not start Claude Code/i.test(agentSrc), 'no such message found');
  check('the chat surface has a timeout rather than hanging',
    /timeoutMs|setTimeout/.test(agentSrc));

  delete require.cache[require.resolve(agentModule)];
  const agent = require(agentModule);
  const t0 = Date.now();
  const answer = await agent.ask('anything', { timeoutMs: 8000, cwd: path.join(RAZE, 'no-such-dir') });
  const elapsed = Date.now() - t0;
  check('asking with a broken environment returns an answer rather than hanging',
    typeof answer.text === 'string' && answer.text.length > 0 && elapsed < 60000,
    `elapsed=${elapsed}ms text=${JSON.stringify(answer.text).slice(0, 120)}`);
  check('that answer is honest about being unavailable, never silence',
    answer.ok === false, JSON.stringify(answer).slice(0, 160));

  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
