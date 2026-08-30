'use strict';

/**
 * The conversational surface — Raze's answer to Ray.
 *
 * A merchant types "is everything alright?" and gets an answer in their own
 * words. Two things make this work without an API key, and one of them is a
 * safety property rather than a convenience.
 *
 * WHERE THE INTELLIGENCE COMES FROM
 *
 * Claude Code, run headless against the same MCP server the agent uses. It is
 * spawned per question with `--strict-mcp-config`, so it sees Raze's tools and
 * nothing else, and it runs on the merchant's own Claude subscription: no API
 * key, no hosted endpoint, no key for this project to hold.
 *
 * WHY THE MODEL IS NEVER GIVEN A WRITE TOOL
 *
 * `--allowed-tools` lists only the read tools. Not as a policy the model is
 * asked to respect, but as a boundary of the process it runs in: a model that
 * decided on its own to repair an order could not, because the tool is not
 * there to call. Recovery goes through proposeRecovery/applyRecovery below,
 * which run in this process and only when a human has clicked.
 *
 * That split also solves a real mechanical problem. Approval tokens live in one
 * MCP server's memory, and every headless run spawns its own; a plan proposed in
 * one process could never be applied from another. The console keeps a single
 * long-lived connection so propose and apply share a session.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const RAZE = path.join(__dirname, '..', '..');

/** Read tools only. The absence of the others is the safety property. */
const READ_TOOLS = [
  'raze_status',
  'raze_health',
  'raze_explain_order',
  'raze_event_trail',
  'raze_find_divergence',
  'raze_inspect_integration',
  'raze_simulate_recovery',
  'raze_sweep_expectations',
  'raze_propose_mapping',
].map((t) => 'mcp__raze__' + t).join(',');

/**
 * Where the Claude executable actually is.
 *
 * On Windows the thing on PATH is a .cmd shim, and spawning through a shell to
 * reach it re-parses every argument — which silently destroys a multi-line
 * system prompt and produces a process that exits with no output and no error.
 * Resolving the real binary and spawning it directly avoids the shell entirely.
 */
function claudeBinary() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) {
      candidates.push(path.join(appdata, 'npm', 'node_modules', '@anthropic-ai',
        'claude-code', 'bin', 'claude.exe'));
    }
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude',
      'claude.exe'));
  }
  candidates.push(path.join(process.env.HOME || '', '.local', 'bin', 'claude'));
  candidates.push('/usr/local/bin/claude');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { cmd: c, shell: false }; } catch {}
  }
  // Last resort: the name, through a shell. Works where the shim is a real
  // executable rather than a batch file.
  return { cmd: 'claude', shell: true };
}

function agentInstructions() {
  try {
    const md = fs.readFileSync(path.join(RAZE, '.claude', 'agents', 'raze.md'), 'utf8');
    // Strip the YAML front matter; the tool list there is for Claude Code's own
    // agent loader and would only confuse a system prompt.
    return md.replace(/^---[\s\S]*?\n---\n/, '').trim();
  } catch {
    return 'You keep a merchant\'s Razorpay payments true. Lead with money and order ids.';
  }
}

/**
 * Ask the agent a question.
 *
 * Returns the answer as text. A failure is returned as a message the merchant
 * can act on rather than thrown — "the assistant is unavailable" is a legitimate
 * answer, and pretending otherwise would be the same sin as reporting BLIND as
 * fine.
 */
function ask(question, { cwd = RAZE, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const mcpConfig = path.join(RAZE, '.mcp.json');
    if (!fs.existsSync(mcpConfig)) {
      return resolve({
        ok: false,
        text: 'I am not connected to anything yet. Run `raze agent` to point me at your '
          + 'database and your Razorpay account.',
      });
    }

    const args = [
      '-p', question,
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      '--allowed-tools', READ_TOOLS,
      '--append-system-prompt', agentInstructions(),
      '--output-format', 'json',
    ];

    // ANTHROPIC_API_KEY takes precedence over the subscription login and would
    // bill this to an API account — or fail outright if the key is stale. The
    // whole point of this path is that it runs on the subscription.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;

    const bin = claudeBinary();
    const child = spawn(bin.cmd, args, {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: bin.shell,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: 'That took too long to answer. Try a narrower question.' });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: 'I could not start Claude Code, which is what I think with. Install it and '
          + 'sign in, then ask again. (' + e.message + ')',
      });
    });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed = null;
      try {
        const line = out.trim().split('\n').filter(Boolean).pop();
        parsed = JSON.parse(line);
      } catch { /* fall through */ }

      if (parsed && typeof parsed.result === 'string') {
        return resolve({
          ok: !parsed.is_error,
          text: parsed.result,
          turns: parsed.num_turns,
          ms: parsed.duration_ms,
        });
      }
      resolve({
        ok: false,
        text: 'I did not get an answer back. ' + (err.trim().split('\n')[0] || '').slice(0, 200),
      });
    });
  });
}

/**
 * A persistent connection to the Raze tools, for the two things the model is
 * not allowed to do.
 *
 * One process, kept alive, so an approval token issued by a proposal is still
 * valid when the merchant clicks approve.
 */
function createToolClient() {
  let child = null;
  let buf = '';
  let nextId = 1;
  const waiting = new Map();

  function start() {
    child = spawn(process.execPath, [path.join(RAZE, 'bin', 'raze-mcp')], {
      cwd: RAZE,
      env: { ...process.env, ...readMcpEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      }
    });
    child.on('exit', () => { child = null; });
  }

  function readMcpEnv() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(RAZE, '.mcp.json'), 'utf8'));
      return (cfg.mcpServers && cfg.mcpServers.raze && cfg.mcpServers.raze.env) || {};
    } catch { return {}; }
  }

  const send = (method, params) => new Promise((resolve, reject) => {
    if (!child) start();
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (waiting.has(id)) { waiting.delete(id); reject(new Error(method + ' timed out')); }
    }, 120000);
  });

  let ready = null;
  async function init() {
    if (ready) return ready;
    ready = (async () => {
      if (!child) start();
      await send('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'raze-console', version: '0.1.0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    })();
    return ready;
  }

  async function call(name, args) {
    await init();
    const res = await send('tools/call', { name, arguments: args || {} });
    const text = res.result && res.result.content && res.result.content[0]
      ? res.result.content[0].text : '{}';
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  return {
    call,
    stop() { if (child) { child.kill(); child = null; ready = null; } },
  };
}

module.exports = { ask, createToolClient, READ_TOOLS };
