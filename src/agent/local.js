'use strict';

/**
 * Running the repair agent on a local model, with no external service.
 *
 * The first attempt at this failed, and the failure is worth recording because
 * it shaped the design: a 3B model asked to "return the complete corrected file"
 * returned the source almost unchanged, three rounds running. It was not that
 * the model could not see the bug — it could not reliably reproduce 120 lines of
 * surrounding code without drifting.
 *
 * So it is not asked to. A small model is asked for one targeted edit at a time:
 *
 *   whole-file rewrite      ~3000 tokens of output, every line a chance to drift
 *   search/replace edit     ~80 tokens, and the unchanged code is never retyped
 *
 * The replacement is applied deterministically here, not by the model: the
 * SEARCH text must appear in the file exactly once, or the edit is refused. That
 * turns "did the model reproduce the file correctly" into a question with a
 * yes/no answer rather than a judgement.
 *
 * MODEL SELECTION IS A HARDWARE QUESTION
 *
 * A 7B needs roughly 5GB of resident memory. Choosing one on a machine with 4GB
 * free does not produce a worse patch, it produces a crashed runner, which looks
 * like a Raze bug and is not. So the model is chosen from free memory measured
 * at run time, and the reasoning is printed.
 */

const os = require('os');
const { spawnSync } = require('child_process');

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/**
 * Candidates, largest first. Each needs roughly its weights resident plus room
 * for the context window, so the requirement is above the download size.
 */
const CANDIDATES = [
  { name: 'qwen2.5-coder:14b', needsMb: 10500, note: 'best local option for this task' },
  { name: 'qwen2.5-coder:7b', needsMb: 6000, note: 'usually capable of a targeted edit' },
  { name: 'qwen2.5-coder:3b', needsMb: 3000, note: 'small; expect several rounds' },
  { name: 'qwen2.5-coder:1.5b', needsMb: 1800, note: 'very small; may not manage it' },
];

/** Free VRAM, if an NVIDIA GPU is present. Zero when there is none. */
function freeVramMb() {
  try {
    const r = spawnSync('nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0 || !r.stdout) return 0;
    return r.stdout.split('\n').map((l) => parseInt(l.trim(), 10))
      .filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
  } catch {
    return 0;
  }
}

/**
 * What a model actually has to work with.
 *
 * Counting system RAM alone was wrong and produced a wrong conclusion: a 7B was
 * refused on a machine with 3GB free that runs it in 8 seconds, because ollama
 * offloads layers to the GPU. VRAM and RAM are both usable, and a model split
 * across them runs — slower than fully resident, but it runs.
 */
function freeMemoryMb() {
  const ram = Math.round(os.freemem() / (1024 * 1024));
  const vram = freeVramMb();
  return ram + vram;
}

async function installedModels() {
  try {
    const res = await fetch(`${HOST}/api/tags`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

function ollamaAvailable() {
  try {
    spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { stdio: 'ignore' });
    const r = spawnSync('ollama', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Choose a model: the largest candidate that both fits and is already present.
 * If none is present, return the largest that fits so it can be pulled.
 */
async function loadedModels() {
  try {
    const res = await fetch(`${HOST}/api/ps`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function chooseModel({ freeMb = freeMemoryMb(), allowPull = true } = {}) {
  const have = await installedModels();

  // A model ollama already has resident is usable whatever free memory reports —
  // the memory it needs is the memory it is currently occupying. Measuring free
  // space while the candidate is loaded otherwise argues against the very model
  // that is demonstrably running.
  const loaded = await loadedModels();
  const residentCandidate = CANDIDATES.find((c) => loaded.includes(c.name));
  if (residentCandidate) {
    return { ...residentCandidate, action: 'use', freeMb, installed: have, resident: true };
  }

  const fits = CANDIDATES.filter((c) => c.needsMb <= freeMb);

  const present = fits.find((c) => have.includes(c.name));
  if (present) return { ...present, action: 'use', freeMb, installed: have };

  // A model that is installed but larger than free memory is still worth
  // reporting, because freeing memory is a real option for the operator.
  const tooBig = CANDIDATES.find((c) => have.includes(c.name) && c.needsMb > freeMb);

  if (fits.length === 0) {
    return {
      action: 'none', freeMb, installed: have, tooBig,
      reason: `no candidate fits in ${freeMb}MB of free memory`,
    };
  }
  if (!allowPull) {
    return { action: 'none', freeMb, installed: have, tooBig, reason: 'no suitable model installed and pulling was not allowed' };
  }
  return { ...fits[0], action: 'pull', freeMb, installed: have, tooBig };
}

/** Download a model, streaming progress to stderr so a long pull is visible. */
function pull(model, log = console.error) {
  log(`  pulling ${model} — this happens once and then works offline`);
  const r = spawnSync('ollama', ['pull', model], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
    timeout: 3600000,
  });
  if (r.status !== 0) throw new Error(`ollama pull ${model} failed`);
}

async function generate(prompt, { model, numCtx = 8192, numPredict = 1024, timeoutMs = 900000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0, num_ctx: numCtx, num_predict: numPredict },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.done_reason === 'length') {
      throw new Error('the model hit its output limit before finishing the edit');
    }
    return (body.response || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const REPLACE = '>>>>>>> REPLACE';

/**
 * Ask for one edit addressing one finding.
 *
 * Deliberately narrow. The model is given the finding, the measured facts that
 * bear on it, and the file — and asked for the smallest edit that fixes that one
 * thing. Nothing about "return the complete file", which is what a small model
 * cannot do.
 */
function editPrompt({ source, filename, finding }) {
  return `A test harness replayed real Razorpay webhook deliveries at this code and read
the resulting database state. One probe failed:

  PROBE:     ${finding.title}
  ASSERTS:   ${finding.assertion}
  OBSERVED:  ${finding.observed}
  WHY:       ${finding.why}

Measured facts about real Razorpay behaviour:
  - a retry carries a BYTE-IDENTICAL body and an UNCHANGED x-razorpay-event-id
  - the first retry arrives 0.23s later; one event can arrive 16 times
  - refund.created carries both a refund entity and a payment entity, and the
    order id is on the PAYMENT entity
  - event ordering is not guaranteed

File: ${filename}
--- BEGIN FILE ---
${source}
--- END FILE ---

Reply with ONE edit and nothing else, in exactly this form:

${SEARCH}
(lines copied exactly from the file, enough to be unique)
${DIVIDER}
(what they become)
${REPLACE}

Rules:
  - the SEARCH text must appear in the file character for character
  - keep it short: a few lines, not the whole file
  - change only what fixes the failure above
  - no explanation, no markdown fences, nothing outside the block`;
}

/**
 * Locate the SEARCH lines in the file, tolerating indentation but nothing else.
 *
 * A small model reliably reproduces the *text* of a line and unreliably
 * reproduces its leading whitespace — the observed failure was a SEARCH block
 * copied correctly except that it had been un-indented out of its template
 * literal. Refusing that is pedantry, not safety.
 *
 * Everything else stays strict: the trimmed lines must match in order, and the
 * run must be unique in the file. Returns the exact original lines so the
 * replacement can be spliced without disturbing anything around it.
 */
function locate(sourceLines, searchLines) {
  const want = searchLines.map((l) => l.trim()).filter((l, i, a) => !(l === '' && i === a.length - 1));
  if (want.length === 0) return { error: 'the SEARCH block was empty' };

  const hits = [];
  for (let i = 0; i + want.length <= sourceLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (sourceLines[i + j].trim() !== want[j]) { ok = false; break; }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return { error: 'the SEARCH text does not appear in the file' };
  if (hits.length > 1) return { error: `the SEARCH text appears ${hits.length} times and is ambiguous` };
  return { start: hits[0], length: want.length };
}

/** Pull the edit out of a reply and apply it. Refuses anything ambiguous. */
function applyEdit(source, reply) {
  const start = reply.indexOf(SEARCH);
  const mid = reply.indexOf(DIVIDER, start + 1);
  const end = reply.indexOf(REPLACE, mid + 1);
  if (start === -1 || mid === -1 || end === -1) {
    return { error: 'reply did not contain a SEARCH/REPLACE block' };
  }

  const search = reply.slice(start + SEARCH.length, mid).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const replace = reply.slice(mid + DIVIDER.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');

  if (!search.trim()) return { error: 'the SEARCH block was empty' };

  // Exact match first — if the model copied the file faithfully, use that.
  const occurrences = source.split(search).length - 1;
  if (occurrences === 1) return { source: source.replace(search, replace), search, replace };
  if (occurrences > 1) return { error: `the SEARCH text appears ${occurrences} times and is ambiguous` };

  // Otherwise allow indentation to differ, but nothing else.
  const sourceLines = source.split('\n');
  const found = locate(sourceLines, search.split('\n'));
  if (found.error) return { error: found.error };

  // Re-indent the replacement to sit where the matched lines sat, so the edit
  // does not visibly disturb the surrounding block.
  const indent = (sourceLines[found.start].match(/^\s*/) || [''])[0];
  const replaced = replace.split('\n').map((l) => (l.trim() ? indent + l.trim() : l));

  const out = [
    ...sourceLines.slice(0, found.start),
    ...replaced,
    ...sourceLines.slice(found.start + found.length),
  ];
  return { source: out.join('\n'), search, replace, reindented: true };
}

module.exports = {
  CANDIDATES, locate, freeVramMb, loadedModels, chooseModel, installedModels, ollamaAvailable, freeMemoryMb,
  pull, generate, editPrompt, applyEdit, HOST,
};
