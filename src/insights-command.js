'use strict';

/**
 * `raze insights` — what Raze has learned from this merchant's own traffic.
 *
 * Kept in its own module so the CLI stays readable. Everything here is derived
 * from recorded observations; every figure carries the sample count that
 * produced it, and nothing is applied.
 */

const path = require('path');

module.exports = async function cmdInsights({ RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const learn = require(path.join(RAZE, 'src', 'learn'));

  const { pool } = await connect();
  await migrate(pool);
  const i = await learn.insights(pool);

  const ms = (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);

  console.log('');
  console.log('  Learned from observed behaviour');
  console.log(`  (a figure needs ${i.minSamples} observations before it counts as a finding)`);
  console.log('');

  console.log('  Razorpay retry behaviour on this account');
  if (i.retries.length === 0) console.log('    nothing observed yet');
  for (const r of i.retries) {
    const base = r.baselineMs ? `measured baseline ${ms(r.baselineMs)}` : 'no baseline';
    const note = r.enough ? base : 'insufficient data';
    console.log(`    ${r.eventType.padEnd(20)} first retry p50 ${String(ms(r.firstRetry.p50)).padEnd(9)} n=${String(r.firstRetry.n).padEnd(6)} ${note}`);
    if (r.divergence) console.log(`      DIVERGES: ${r.divergence}`);
  }

  console.log('');
  console.log('  Merchant handler behaviour');
  if (i.handlers.length === 0) console.log('    nothing observed yet');
  for (const h of i.handlers) {
    const note = h.enough ? '' : '  (insufficient data)';
    console.log(`    ${h.eventType.padEnd(20)} p50 ${String(ms(h.duration.p50)).padEnd(9)} p95 ${String(ms(h.duration.p95)).padEnd(9)} ${h.failures}/${h.total} failed${note}`);
    if (h.topError) console.log(`      most common failure: ${h.topError.message} (${h.topError.count}x)`);
  }

  console.log('');
  console.log('  Time from order to payment');
  if (!i.fulfilment.enough) {
    console.log(`    ${i.fulfilment.duration.n} fulfilment(s) recorded — too few to set a deadline from`);
  } else {
    console.log(`    p50 ${ms(i.fulfilment.duration.p50)}   p99 ${ms(i.fulfilment.duration.p99)}   n=${i.fulfilment.duration.n}`);
  }
  const parts = Object.entries(i.fulfilment.resolutions || {}).map(([k, v]) => `${k} ${v}`);
  if (parts.length) console.log(`    resolutions: ${parts.join(', ')}`);

  console.log('');
  console.log('  Delivery reliability');
  console.log(`    ${i.reliability.runs} reconciliation run(s), ${i.reliability.drift} payment(s) found that delivery missed`);
  if (i.reliability.runs > i.reliability.okRuns) {
    console.log(`    ${i.reliability.runs - i.reliability.okRuns} run(s) did not complete — an uncovered window is not the same as no drift`);
  }

  console.log('');
  console.log('  Recommendations');
  if (i.recommendations.length === 0) {
    console.log('    none — either behaviour is within expectations, or there is not yet');
    console.log('    enough data to say anything worth acting on.');
  }
  for (const r of i.recommendations) {
    console.log(`    ${r.setting}: ${r.value}`);
    console.log(`      because ${r.because}`);
  }
  console.log('');
  console.log('  Nothing here has been applied.');
  console.log('');

  await shutdown(pool);
};
