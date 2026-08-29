'use strict';

/**
 * `raze scan` — recognise known defect patterns in a handler, without running it.
 *
 * The probes need a running service and a database. This needs neither: it reads
 * the source and reports which known shapes it matches, with line numbers and the
 * reason each one matters. Deterministic, instant, and it explains itself.
 *
 * It only knows what it knows. Code matching nothing is reported as unrecognised
 * rather than declared clean — absence of a known pattern is not evidence of
 * correctness, and `raze audit` is what actually tests behaviour.
 */

const fs = require('fs');
const path = require('path');

module.exports = async function cmdScan({ flag, RAZE }) {
  const { scan } = require(path.join(RAZE, 'src', 'patterns'));
  const target = flag('file', null);

  if (!target) {
    console.error('');
    console.error('  raze scan --file path/to/handler.js');
    console.error('');
    console.error('  Reads the source and reports known defect patterns. To test actual');
    console.error('  behaviour against real captured deliveries, use raze audit.');
    console.error('');
    process.exit(1);
  }

  let source;
  try {
    source = fs.readFileSync(target, 'utf8');
  } catch (err) {
    console.error(`\n  cannot read ${target}: ${err.message}\n`);
    process.exit(1);
  }

  const hits = scan(source);

  console.log('');
  console.log(`  ${path.relative(process.cwd(), target)}`);
  console.log('');

  if (hits.length === 0) {
    console.log('  No known pattern matched.');
    console.log('');
    console.log('  That is not the same as correct. These patterns are the defects seen in');
    console.log('  real published integrations; this file simply matches none of them.');
    console.log('  Run raze audit to test what the code actually does.');
    console.log('');
    return;
  }

  for (const h of hits) {
    console.log(`  ${h.pattern.title}`);
    console.log(`    ${h.evidence}`);
    console.log(`    why: ${h.pattern.why}`);
    if (h.pattern.fixes && h.pattern.fixes.length) {
      console.log(`    probes this would fail: ${h.pattern.fixes.join(', ')}`);
    }
    const repair = h.pattern.repair(source);
    if (repair && repair.source) {
      console.log('    repairable automatically: raze fix');
    } else if (repair && repair.error) {
      console.log(`    not automatable: ${repair.error}`);
    }
    console.log('');
  }

  console.log(`  ${hits.length} known pattern(s) matched. Nothing has been changed.`);
  console.log('');
};
