#!/usr/bin/env node
'use strict';

/**
 * Raze — §1 reconciliation gate.
 *
 * Everything downstream depends on this result. Layer 3 (reconciliation) works by
 * enumerating payments from Razorpay over a time window and diffing them against
 * local orders. That only works if two things hold:
 *
 *   1. Razorpay returns a usable local mapping key on every payment (order_id).
 *   2. Window enumeration is complete — no payment dropped or duplicated across
 *      pages.
 *
 * If (1) fails, reconciliation must key on payment_id persisted at order creation
 * (FALLBACK). If (2) fails, reconciliation cannot be trusted at all (STOP).
 *
 * Nothing here is simulated. Every payment enumerated is a real Razorpay Test Mode
 * payment created through the Payment Links flow — the same flow the demo uses.
 *
 *   node raze/gate/reconcile-gate.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'RECONCILE_GATE_RESULTS.md');

// ---------------------------------------------------------------------------
// Credentials. Read from probe-server/.env; never printed.
// ---------------------------------------------------------------------------
function loadEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'probe-server', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {}
  return out;
}

const env = { ...loadEnv(), ...process.env };
const KEY_ID = env.RAZORPAY_KEY_ID;
const KEY_SECRET = env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not found (probe-server/.env or environment).');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

async function rzp(pathAndQuery) {
  const res = await fetch(`https://api.razorpay.com/v1${pathAndQuery}`, {
    headers: { authorization: AUTH },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

const iso = (unix) => new Date(unix * 1000).toISOString();

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Enumerate a window fully, following `skip` until a short page comes back. */
async function enumerateWindow(from, to, count) {
  const seen = [];
  const pageSizes = [];
  let skip = 0;
  for (;;) {
    const { status, body } = await rzp(`/payments?from=${from}&to=${to}&count=${count}&skip=${skip}`);
    if (status !== 200) throw new Error(`enumeration failed at skip=${skip}: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
    const items = body.items || [];
    pageSizes.push(items.length);
    seen.push(...items);
    if (items.length < count) break;
    skip += count;
    if (skip > 10000) throw new Error('pagination did not terminate');
  }
  return { payments: seen, pageSizes, pages: pageSizes.length };
}

/** Find the largest `count` the API actually accepts. */
async function probeMaxCount(from, to) {
  const candidates = [100, 50, 25];
  for (const c of candidates) {
    const { status } = await rzp(`/payments?from=${from}&to=${to}&count=${c}&skip=0`);
    if (status === 200) return c;
  }
  return null;
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 3 * 24 * 60 * 60; // the full measurement period
  const to = now;

  console.log('\nRaze — reconciliation gate\n');
  console.log(`window : ${iso(from)}  ->  ${iso(to)}`);

  // -- max count -----------------------------------------------------------
  const maxCount = await probeMaxCount(from, to);
  if (!maxCount) {
    console.error('could not establish an accepted count value — STOP');
    process.exit(2);
  }
  console.log(`count  : ${maxCount} accepted\n`);

  // -- full enumeration ----------------------------------------------------
  const full = await enumerateWindow(from, to, maxCount);
  console.log(`enumerated ${full.payments.length} payment(s) in ${full.pages} page(s)`);

  if (full.payments.length === 0) {
    console.error('\nno payments in window — cannot evaluate the gate. STOP.');
    process.exit(2);
  }

  // -- field assertions ----------------------------------------------------
  const REQUIRED = ['id', 'order_id', 'status', 'amount', 'created_at'];
  const fieldMisses = {};
  for (const f of REQUIRED) fieldMisses[f] = [];

  for (const p of full.payments) {
    for (const f of REQUIRED) {
      const v = p[f];
      if (v === undefined || v === null) fieldMisses[f].push(p.id || '(no id)');
    }
    if (p.created_at !== undefined && (p.created_at < from || p.created_at > to)) {
      fieldMisses.created_at.push(`${p.id} out of window`);
    }
  }

  console.log('\nfield presence across all enumerated payments:');
  for (const f of REQUIRED) {
    const miss = fieldMisses[f].length;
    console.log(`  ${miss === 0 ? 'OK  ' : 'MISS'}  ${f.padEnd(12)} ${miss === 0 ? 'present on all' : `absent/invalid on ${miss}`}`);
  }

  // -- pagination integrity ------------------------------------------------
  // Re-enumerate the same window with a deliberately small page size so skip>0
  // is exercised, then compare the id sets.
  const smallCount = Math.max(2, Math.min(3, full.payments.length - 1));
  const paged = await enumerateWindow(from, to, smallCount);

  const setA = new Set(full.payments.map((p) => p.id));
  const setB = paged.payments.map((p) => p.id);
  const setBUnique = new Set(setB);

  const dropped = [...setA].filter((id) => !setBUnique.has(id));
  const extra = [...setBUnique].filter((id) => !setA.has(id));
  const duplicated = setB.length !== setBUnique.size;

  console.log(`\npagination: count=${smallCount} produced ${paged.pages} page(s), sizes [${paged.pageSizes.join(', ')}]`);
  console.log(`  dropped across pages    : ${dropped.length}`);
  console.log(`  duplicated across pages : ${duplicated ? 'YES' : 'no'}`);
  console.log(`  unexpected extra ids    : ${extra.length}`);

  // -- known payments ------------------------------------------------------
  // Payments created earlier through the Payment Links flow during the
  // measurement. Their presence proves the enumeration finds real, known
  // payments rather than merely returning something.
  const KNOWN = ['pay_TVRhBUzohX46of'];
  const knownFound = KNOWN.filter((id) => setA.has(id));
  console.log(`\nknown payments found: ${knownFound.length}/${KNOWN.length}`);

  // -- verdict -------------------------------------------------------------
  const orderIdMissing = fieldMisses.order_id.length;
  const enumerationLossy = dropped.length > 0 || duplicated || extra.length > 0;

  let verdict;
  if (enumerationLossy) verdict = 'STOP';
  else if (orderIdMissing > 0) verdict = 'FALLBACK';
  else verdict = 'PASS';

  console.log(`\n${'='.repeat(58)}`);
  console.log(`  GATE: ${verdict}`);
  console.log(`${'='.repeat(58)}\n`);

  const byStatus = {};
  for (const p of full.payments) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  const md = `# Raze — reconciliation gate results

Run ${new Date().toISOString()} against Razorpay Test Mode.
Produced by \`raze/gate/reconcile-gate.js\`. This file is evidence, not scaffolding.

## Verdict

> **${verdict}**${verdict === 'PASS'
  ? ' — reconcile on `order_id`. Build Layer 3 as specified.'
  : verdict === 'FALLBACK'
  ? ' — `order_id` is not universally present. Persist `payment_id` at order creation and reconcile on that instead. Weaker mapping, still functional.'
  : ' — enumeration is lossy. Reconciliation cannot be trusted. Investigate before building Layer 3.'}

## Window

\`\`\`
from  ${iso(from)}
to    ${iso(to)}
\`\`\`

Covers the whole measurement period, so every payment created through the Payment
Links flow during runs 1-4 falls inside it.

## Enumeration

| | |
|---|---|
| Maximum accepted \`count\` | **${maxCount}** |
| Payments enumerated | **${full.payments.length}** |
| Pages at \`count=${maxCount}\` | ${full.pages} |
| Pages at \`count=${smallCount}\` | ${paged.pages} (sizes ${paged.pageSizes.join(', ')}) |

Payment status distribution: ${Object.entries(byStatus).map(([k, v]) => `\`${k}\` ${v}`).join(', ')}.

## Field presence

Asserted on every enumerated payment.

| Field | Result |
|---|---|
${REQUIRED.map((f) => `| \`${f}\` | ${fieldMisses[f].length === 0 ? 'present on all' : `**absent or invalid on ${fieldMisses[f].length}**`} |`).join('\n')}

${orderIdMissing > 0
  ? `\`order_id\` was absent on ${orderIdMissing} payment(s): ${fieldMisses.order_id.slice(0, 8).join(', ')}. This is what forces FALLBACK.\n`
  : '`order_id` is present and non-null on every payment, which is the mapping key Layer 3 needs.\n'}

## Pagination integrity

The same window was enumerated twice — once at \`count=${maxCount}\` (a single page)
and once at \`count=${smallCount}\` to force \`skip>0\` — and the resulting id sets compared.

| Check | Result |
|---|---|
| Payments dropped across pages | ${dropped.length === 0 ? '0' : `**${dropped.length}** — ${dropped.slice(0, 5).join(', ')}`} |
| Payments duplicated across pages | ${duplicated ? '**YES**' : 'no'} |
| Unexpected ids in paged result | ${extra.length === 0 ? '0' : `**${extra.length}**`} |

${enumerationLossy
  ? 'Enumeration is lossy. Overlapping windows cannot compensate for this; STOP.'
  : 'Enumeration is complete and stable across page sizes. Combined with the overlapping windows Layer 3 uses, a payment captured at a window boundary cannot be missed.'}

## Known-payment check

Payments created earlier through the Payment Links flow during the measurement,
looked up in the enumerated set. This proves the enumeration surfaces real, known
payments rather than merely returning a non-empty list.

${KNOWN.map((id) => `- \`${id}\` — ${setA.has(id) ? 'found' : '**not found**'}`).join('\n')}

## What this means for the build

${verdict === 'PASS'
  ? `Layer 3 reconciliation is buildable as specified. The diff is keyed on \`order_id\`,
pagination follows \`skip\` in steps of ${maxCount}, and the reconcile loop can trust
that a full window enumeration returns every payment exactly once.`
  : verdict === 'FALLBACK'
  ? `Layer 3 is still buildable, but the merchant must persist \`payment_id\` at order
creation time and the diff keys on that. Record this limitation in the README.`
  : `Do not build Layer 3 until enumeration is understood. A reconciliation loop built on
lossy enumeration would silently under-report drift, which is worse than no
reconciliation at all.`}
`;

  fs.writeFileSync(OUT, md);
  console.log(`written: ${path.relative(ROOT, OUT)}\n`);

  process.exit(verdict === 'STOP' ? 3 : 0);
}

main().catch((err) => {
  console.error(`\ngate failed to run: ${err.message}\n`);
  process.exit(1);
});
