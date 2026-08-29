'use strict';

/**
 * Raze repair agent.
 *
 * Reads a merchant's real source, gets real findings from the deterministic
 * probes, generates a patch, applies it, and re-runs the probes to prove the
 * patch worked.
 *
 * THE DIVISION OF LABOUR IS THE WHOLE POINT:
 *
 *   the probes decide what is broken   deterministic, reading real Postgres state
 *   the model writes the patch          generated at run time, never canned
 *   the probes decide if it is fixed    the same deterministic probes, re-run
 *
 * The model never discovers a problem, never decides whether something is a
 * finding, and never declares success. If the generated patch does not make the
 * probes pass, the agent reports failure and restores the original file. A patch
 * that "looks right" but does not change the measured outcome is a failed patch.
 *
 * There is no fix database, no template, no canned diff. The patch is written
 * from the merchant's actual source and the actual observed state transitions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { extractCode, parses } = require('./extract');

const MODEL = process.env.RAZE_MODEL || 'claude-sonnet-5';
const MAX_ROUNDS = Number(process.env.RAZE_FIX_ROUNDS || 3);

/**
 * Where the patch comes from.
 *
 * Three providers, tried in this order unless RAZE_PROVIDER pins one. All three
 * are interchangeable as far as the rest of the system is concerned, because the
 * probes — not the model — decide whether the patch worked.
 *
 *   claude  the Claude Code CLI in headless mode. Runs on the user's existing
 *           subscription rather than API credits.
 *   api     the Anthropic API directly. Needs ANTHROPIC_API_KEY with credit.
 *   ollama  a local model. Fully offline, no account, no network.
 */
function detectProvider() {
  const pinned = (process.env.RAZE_PROVIDER || '').toLowerCase();
  if (pinned) return pinned;
  if (hasClaudeCli()) return 'claude';
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (hasOllama()) return 'ollama';
  return null;
}

function hasClaudeCli() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function hasOllama() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'],
      { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Claude Code CLI, headless.
 *
 * ANTHROPIC_API_KEY is deliberately stripped from the child's environment: when
 * it is present the CLI prefers it over the user's logged-in subscription, so a
 * key with no credit makes an otherwise working subscription fail.
 */
function callClaudeCli(prompt, model) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const short = /opus/i.test(model) ? 'opus' : /haiku/i.test(model) ? 'haiku' : 'sonnet';
  const res = spawnSync('claude', ['-p', '--model', short], {
    input: prompt,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
    shell: process.platform === 'win32',
  });
  if (res.error) throw new Error(`claude CLI failed: ${res.error.message}`);
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`claude CLI returned nothing. ${(res.stderr || '').slice(0, 300)}`);
  if (/credit balance is too low/i.test(out)) {
    throw new Error('claude CLI reports no credit — unset ANTHROPIC_API_KEY to use your subscription');
  }
  return { text: out, usage: null };
}

function callOllama(prompt, model) {
  const res = spawnSync('ollama', ['run', model], {
    input: prompt, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 900000, shell: process.platform === 'win32',
  });
  if (res.error) throw new Error(`ollama failed: ${res.error.message}`);
  const out = (res.stdout || '').trim();
  if (!out) throw new Error(`ollama returned nothing. ${(res.stderr || '').slice(0, 300)}`);
  return { text: out, usage: null };
}

async function callApi(prompt, model, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return { text: (body.content || []).map((c) => c.text || '').join('').trim(), usage: body.usage };
}

async function callModel(prompt, { provider, model, apiKey }) {
  if (provider === 'claude') return callClaudeCli(prompt, model);
  if (provider === 'ollama') return callOllama(prompt, process.env.RAZE_OLLAMA_MODEL || 'qwen2.5-coder:7b');
  if (provider === 'api') {
    if (!apiKey) throw new Error('provider "api" needs ANTHROPIC_API_KEY');
    return callApi(prompt, model, apiKey);
  }
  throw new Error('no model provider available — install the Claude Code CLI, set ANTHROPIC_API_KEY, or install ollama');
}

/**
 * Ask the model for a corrected version of one file.
 *
 * The prompt carries the real source and the real findings — what each probe
 * sent, what it asserted, and the business state it actually observed. Nothing
 * about the failure is paraphrased or pre-diagnosed for the model.
 */
async function generatePatch({ source, filename, findings, apiKey, previousAttempt }) {
  const findingText = findings.map((f) => {
    const ev = Object.entries(f.evidence || {})
      .map(([k, v]) => `      ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    return `  PROBE: ${f.title}\n`
         + `    asserts: ${f.assertion}\n`
         + `    observed: ${f.observed}\n`
         + `    why this matters: ${f.why}\n`
         + (ev ? `    evidence:\n${ev}\n` : '');
  }).join('\n');

  const retry = previousAttempt
    ? `\nA previous attempt was applied and re-tested. It did NOT fix everything — `
      + `the findings above are what remain after that attempt. Do not repeat it.\n`
    : '';

  const prompt = `You are repairing a Razorpay webhook handler. A deterministic test
harness replayed real captured Razorpay deliveries at this code and read the
resulting business state directly from PostgreSQL. These probes failed:

${findingText}
${retry}
Measured facts about Razorpay's real behaviour, from a 796-delivery study:
  - a failed delivery is retried with a BYTE-IDENTICAL body and an UNCHANGED
    x-razorpay-event-id header; the first retry arrives 0.23s later
  - one event can be delivered up to 16 times over 22.76 hours
  - refund.created carries BOTH a refund entity and a payment entity; the
    order id is on the PAYMENT entity, never on the refund entity
  - event ordering is not guaranteed

Here is the complete current source of ${filename}:

--- BEGIN SOURCE ---
${source}
--- END SOURCE ---

Return the COMPLETE corrected file and nothing else. No markdown fences, no
commentary, no explanation. The first character of your reply must be the first
character of the file.

Constraints:
  - preserve every export, function signature and route this file already has
  - the file must remain valid CommonJS for Node 22
  - do not weaken or remove any existing correct behaviour
  - do not add dependencies that are not already required by this file
  - the tables available are those the file already uses`;

  const provider = detectProvider();
  const { text: raw, usage } = await callModel(prompt, { provider, model: MODEL, apiKey });
  let text = raw;

  return { source: extractCode(text), usage, provider: detectProvider() };
}


/** Reject a patch that is obviously not a whole file before running it. */
function sanityCheck(original, patched) {
  if (!patched || patched.length < original.length * 0.4) {
    return 'patch is far shorter than the original — likely truncated';
  }
  if (/^\s*(Here|I |The |This )/.test(patched)) {
    return 'patch begins with prose rather than code';
  }
  const exports0 = (original.match(/module\.exports/g) || []).length;
  const exports1 = (patched.match(/module\.exports/g) || []).length;
  if (exports0 > 0 && exports1 === 0) return 'patch dropped module.exports';
  const syntax = parses(patched);
  if (syntax) return 'patch does not parse - ' + syntax;
  return null;
}

/**
 * Repair loop.
 *
 * audit -> if clean, stop -> generate patch -> apply -> re-audit
 * The loop only exits successfully when the deterministic probes pass.
 */
async function repair({ filePath, runAudit, apiKey, log = console.log, rounds = MAX_ROUNDS }) {
  const original = fs.readFileSync(filePath, 'utf8');
  const backup = `${filePath}.raze-backup`;
  fs.writeFileSync(backup, original);

  const history = [];
  let current = original;

  try {
    let results = await runAudit();
    let findings = results.filter((r) => !r.pass && !r.skipped);

    if (findings.length === 0) {
      return { ok: true, rounds: 0, message: 'no findings — nothing to repair', history };
    }

    log(`\n  ${findings.length} finding(s) to repair. Diagnosis is deterministic; the patch is generated.\n`);

    for (let round = 1; round <= rounds; round++) {
      log(`  round ${round}: generating a patch from the real source and the real findings...`);

      const { source: patched, usage } = await generatePatch({
        source: current,
        filename: path.basename(filePath),
        findings,
        apiKey,
        previousAttempt: round > 1,
      });

      const bad = sanityCheck(current, patched);
      if (bad) {
        log(`  round ${round}: patch rejected before running — ${bad}`);
        history.push({ round, applied: false, reason: bad });
        continue;
      }

      fs.writeFileSync(filePath, patched);
      current = patched;
      log(`  round ${round}: patch applied (${patched.length} bytes, ${usage?.output_tokens ?? '?'} output tokens). Re-running the probes.`);

      results = await runAudit();
      const before = findings.length;
      findings = results.filter((r) => !r.pass && !r.skipped);
      log(`  round ${round}: ${before} finding(s) -> ${findings.length}`);
      history.push({ round, applied: true, findingsBefore: before, findingsAfter: findings.length });

      if (findings.length === 0) {
        return { ok: true, rounds: round, results, history,
                 message: 'probes pass against the generated patch' };
      }
    }

    // Never leave a merchant running code that did not fix anything.
    fs.writeFileSync(filePath, original);
    return {
      ok: false, rounds, history, results,
      message: `still ${findings.length} finding(s) after ${rounds} round(s) — original file restored`,
    };
  } catch (err) {
    fs.writeFileSync(filePath, original);
    throw err;
  }
}

function restore(filePath) {
  const backup = `${filePath}.raze-backup`;
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, filePath);
    fs.unlinkSync(backup);
    return true;
  }
  return false;
}

module.exports = { repair, restore, generatePatch, sanityCheck, extractCode, parses, MODEL, detectProvider };
