#!/usr/bin/env node
'use strict';

/**
 * Evaluate Raze's pattern recognition against real, independently written
 * Razorpay integrations.
 *
 * Nothing here is a fixture. Each repository was written by someone else, for
 * their own purpose, without knowledge of this project. They are cloned into
 * .public-merchants/ at run time and never vendored — most carry no licence, so
 * their code is fetched like a fixture and nothing from it is committed.
 *
 * The evaluation is deliberately narrow, because a wider claim would not be
 * honest. It reports, per repository:
 *
 *   whether a webhook handler could be located at all
 *   which known defect patterns it matches, with the evidence
 *   which of Raze's probes those patterns would fail
 *
 * It does NOT claim these integrations are broken in production. A pattern match
 * is a strong signal about a specific shape of code, not a verdict on a system
 * being run by someone who knows their own constraints. And matching nothing is
 * reported as unrecognised, never as correct: absence of a known pattern is not
 * evidence of correctness, which is what raze audit exists to test.
 *
 *   node test/evaluate-public.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scan } = require('../src/patterns');

const RAZE = path.join(__dirname, '..');
const CACHE = path.join(RAZE, '.public-merchants');

/** Files that look like they receive Razorpay webhooks. */
function findHandlers(root) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

  (function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1);
        continue;
      }
      if (!/\.(js|ts|mjs|cjs)$/.test(e.name)) continue;
      if (/\.(test|spec)\./.test(e.name)) continue;
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (src.length > 400000) continue;

      // A webhook handler reads Razorpay's signature header or its payload shape.
      const isHandler =
        /x-razorpay-signature/i.test(src) ||
        /validateWebhookSignature/.test(src) ||
        (/payload\.(payment|order|refund)\.entity/.test(src) && /req\.body|request\.body|event/.test(src));
      if (isHandler) out.push({ file: full, source: src });
    }
  })(root, 0);

  return out;
}

/**
 * The integrations this evaluation reads.
 *
 * Fetched at run time and never vendored: they carry no licence, so their code is
 * downloaded like a fixture and none of it is committed here.
 */
const REPOS = [
  'neharahman/razorpay-webhook',
  'pavankumaroff/razorpay-webhook',
  'smartcraze/Slotify',
  'Rohit3523/medusa-razorpay-webhook',
  'iamhvsharma/Razorpay-webhook',
  'mehtaparam/firebase-razorpay-webhook',
  'Venkatasaiyadav/razorpay-webhook',
  'dineshchauhan7711/razorpay-payment-nodejs',
  'sayantan56/kitty-webhook',
  'srivardhanrr/RazorpayWebhookapp',
];

/**
 * Clone anything missing.
 *
 * "Clone some integrations first" is not a useful error on a machine that has
 * just cloned this repository. The evaluation knows which ones it wants, so it
 * fetches them. One that cannot be reached is reported and skipped — someone
 * else's repository going away is not a failure of this project.
 */
function ensureRepos() {
  fs.mkdirSync(CACHE, { recursive: true });
  const missing = REPOS.filter((r) => !fs.existsSync(path.join(CACHE, r.replace('/', '-'))));
  if (missing.length === 0) return;
  console.log(`  fetching ${missing.length} repositories (once; not committed here)`);
  const failed = [];
  for (const repo of missing) {
    const dir = path.join(CACHE, repo.replace('/', '-'));
    const res = spawnSync('git', ['clone', '-q', '--depth', '1',
      'https://github.com/' + repo + '.git', dir], { encoding: 'utf8', timeout: 180000 });
    if (res.status !== 0) failed.push(repo);
  }
  if (failed.length) console.log('  could not fetch: ' + failed.join(', ') + ' — skipped');
  console.log('');
}

function main() {
  ensureRepos();

  if (!fs.existsSync(CACHE) || fs.readdirSync(CACHE).length === 0) {
    console.error('');
    console.error('No integrations could be fetched. Check network access to github.com.');
    process.exit(1);
  }

  const repos = fs.readdirSync(CACHE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log('');
  console.log('  Raze against real published Razorpay integrations');
  console.log('  Each repository written independently, cloned at run time, not vendored.');
  console.log('');

  const rows = [];
  let totalPatterns = 0;
  let withHandler = 0;
  let clean = 0;

  for (const repo of repos) {
    const handlers = findHandlers(path.join(CACHE, repo));

    if (handlers.length === 0) {
      rows.push({ repo, handler: null, hits: [] });
      console.log(`  ${repo}`);
      console.log('    no webhook handler found in the repository');
      console.log('');
      continue;
    }

    withHandler++;

    // Evaluate the handler with the most matches; report the file examined.
    let best = null;
    for (const h of handlers) {
      const hits = scan(h.source);
      if (!best || hits.length > best.hits.length) best = { ...h, hits };
    }

    const rel = path.relative(path.join(CACHE, repo), best.file);
    console.log(`  ${repo}`);
    console.log(`    handler: ${rel}`);

    if (best.hits.length === 0) {
      clean++;
      console.log('    no known pattern matched (not the same as correct)');
    } else {
      totalPatterns += best.hits.length;
      for (const h of best.hits) {
        console.log(`    - ${h.pattern.title}`);
        console.log(`      ${h.evidence}`);
        if (h.pattern.fixes.length) {
          console.log(`      would fail: ${h.pattern.fixes.join(', ')}`);
        }
      }
    }
    console.log('');
    rows.push({ repo, handler: rel, hits: best.hits.map((h) => h.pattern.id) });
  }

  // ---- summary ----------------------------------------------------------
  console.log(`  ${'='.repeat(66)}`);
  console.log('  SUMMARY');
  console.log(`  ${'='.repeat(66)}`);
  console.log('');
  console.log(`  repositories examined            ${repos.length}`);
  console.log(`  with a webhook handler           ${withHandler}`);
  console.log(`  no handler found                 ${repos.length - withHandler}`);
  console.log(`  handler matched >=1 pattern      ${withHandler - clean}`);
  console.log(`  handler matched nothing known    ${clean}`);
  console.log(`  total pattern matches            ${totalPatterns}`);
  console.log('');

  const byPattern = new Map();
  for (const r of rows) {
    for (const id of r.hits) byPattern.set(id, (byPattern.get(id) || 0) + 1);
  }
  if (byPattern.size) {
    console.log('  How often each defect appears:');
    for (const [id, n] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(2)} / ${withHandler}   ${id}`);
    }
    console.log('');
  }

  console.log('  A pattern match is a signal about a shape of code, not a verdict on');
  console.log('  someone else\'s running system. Matching nothing means unrecognised,');
  console.log('  not correct.');
  console.log('');

  fs.writeFileSync(
    path.join(RAZE, 'public-evaluation.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), repos: rows }, null, 2)
  );
  console.log('  machine-readable: public-evaluation.json');
  console.log('');
}

main();
