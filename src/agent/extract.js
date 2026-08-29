'use strict';

/**
 * Getting a runnable file out of a model reply, and refusing one that is not.
 *
 * Kept separate from the agent so both concerns are testable on their own.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

/**
 * Pull the file out of a reply that may be wrapped in prose or fences.
 *
 * The model is told to return bare code and mostly does — but "mostly" is not a
 * property you can build on. One run prefixed a paragraph of analysis and the
 * patched file was not valid JavaScript. Rather than trusting the instruction,
 * find where the code actually starts.
 */
function extractCode(text) {
  if (!text) return '';

  // A fenced block is unambiguous — take its contents.
  const fence = text.match(/```(?:[a-zA-Z]*)\r?\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();

  // Otherwise drop leading prose: the file begins at the first line that looks
  // like the top of a CommonJS module.
  const lines = text.split('\n');
  const startsCode = /^\s*(?:'use strict'|"use strict"|const |let |var |function |class |\/\*|\/\/|require\(|module\.exports|import |async )/;
  const i = lines.findIndex((l) => startsCode.test(l));
  return (i > 0 ? lines.slice(i) : lines).join('\n').trim();
}

/**
 * Does this patch actually parse?
 *
 * The decisive guard. A patch that does not parse cannot run, so there is no
 * point restarting the target to discover that. `node --check` is the same
 * parser that will load the file.
 *
 * Returns null when the source parses, or the error text when it does not.
 */
function parses(source) {
  const tmp = path.join(os.tmpdir(), `raze-check-${process.pid}-${Date.now()}.js`);
  try {
    fs.writeFileSync(tmp, source);
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (res.status === 0) return null;
    return (res.stderr || 'syntax error').split('\n').slice(0, 3).join(' ').trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { extractCode, parses };
