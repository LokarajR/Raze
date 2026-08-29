'use strict';

/**
 * Layer 2 tests — the Expectation Ledger's three outcomes.
 *
 * Every case uses a real Razorpay Test Mode order:
 *
 *   recovered  an order whose payment really was captured (measurement run 3)
 *   failed     an order whose payment really was declined (measurement run 4)
 *   abandoned  a real order created here via the API and deliberately never paid
 *
 * The abandoned case is created rather than reused because that is the one
 * situation reconciliation is structurally blind to — there is no payment to
 * enumerate — so it has to be real to mean anything.
 *
 *   node raze/test/layer2.test.js
 */

const fs = require('fs');
const path = require('path');
const { connect, migrate, shutdown } = require('../src/db');
const { createLedger } = require('../src/ledger');

const ROOT = path.join(__dirname, '..', '..');

function loadEnv() {
  const out = {};
  const raw = fs.readFileSync(path.join(ROOT, 'probe-server', '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function main() {
  const env = loadEnv();
  const auth = 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');

  const { pool } = await connect();
  await migrate(pool);
  console.log('\nLayer 2 tests  (live Razorpay Test Mode API)\n');
  await pool.query('TRUNCATE raze_expectations');

  // --- find real subjects from the last three days -------------------------
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(
    `https://api.razorpay.com/v1/payments?from=${now - 3 * 24 * 3600}&to=${now}&count=100`,
    { headers: { authorization: auth } }
  );
  const payments = (await res.json()).items || [];
  const settled = payments.find((p) => p.status === 'captured' || p.status === 'refunded');
  const declined = payments.find((p) => p.status === 'failed');

  if (!settled || !declined) {
    console.error('need one settled and one failed payment in the window; found',
      payments.map((p) => p.status).join(', '));
    process.exit(1);
  }

  // --- create a real order nobody will ever pay ----------------------------
  const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 100, currency: 'INR', receipt: `raze-abandon-${Date.now()}` }),
  });
  const abandonedOrder = await orderRes.json();
  if (!abandonedOrder.id) {
    console.error('could not create the abandonment order:', JSON.stringify(abandonedOrder).slice(0, 200));
    process.exit(1);
  }

  console.log(`  recovered subject : ${settled.order_id}  (payment ${settled.id}, ${settled.status})`);
  console.log(`  failed subject    : ${declined.order_id}  (payment ${declined.id}, failed)`);
  console.log(`  abandoned subject : ${abandonedOrder.id}  (created now, never paid)\n`);

  // --- arm three already-overdue expectations ------------------------------
  const arm = (subjectId) => pool.query(
    `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
     VALUES ('order', $1, 'payment.captured', now() - interval '1 minute')`,
    [subjectId]
  );
  await arm(settled.order_id);
  await arm(declined.order_id);
  await arm(abandonedOrder.id);

  const repaired = [];
  const ledger = createLedger({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    repair: async (payment) => { repaired.push(payment.id); },
  });

  const sweep = await ledger.sweepOnce();
  console.log(`  sweep: checked=${sweep.checked} recovered=${sweep.recovered} failed=${sweep.failed} abandoned=${sweep.abandoned} unknown=${sweep.unknown}\n`);

  const resolutionOf = async (subjectId) => {
    const r = await pool.query('SELECT resolution FROM raze_expectations WHERE subject_id=$1', [subjectId]);
    return r.rows[0]?.resolution;
  };

  check('captured payment past deadline -> recovered, not abandoned',
    (await resolutionOf(settled.order_id)) === 'recovered',
    `got ${await resolutionOf(settled.order_id)}`);

  check('declined payment past deadline -> failed, not abandoned',
    (await resolutionOf(declined.order_id)) === 'failed',
    `got ${await resolutionOf(declined.order_id)}`);

  check('order with no payment at all -> abandoned',
    (await resolutionOf(abandonedOrder.id)) === 'abandoned',
    `got ${await resolutionOf(abandonedOrder.id)}`);

  check('a recovered expectation is pushed through the repair path',
    repaired.includes(settled.id),
    `repaired=[${repaired.join(', ')}]`);

  // --- the distinction that matters ---------------------------------------
  const distinct = new Set([
    await resolutionOf(settled.order_id),
    await resolutionOf(declined.order_id),
    await resolutionOf(abandonedOrder.id),
  ]);
  check('three real situations produce three distinct verdicts',
    distinct.size === 3, `got ${[...distinct].join(', ')}`);

  // --- resolved expectations are not swept twice ---------------------------
  const second = await ledger.sweepOnce();
  check('resolved expectations are not re-swept',
    second.checked === 0, `checked=${second.checked}`);

  // --- an unresolvable lookup leaves the expectation open ------------------
  await pool.query('TRUNCATE raze_expectations');
  await arm(settled.order_id);
  const brokenLedger = createLedger({
    db: pool,
    razorpay: { keyId: 'rzp_test_invalid', keySecret: 'invalid' },
  });
  const brokenSweep = await brokenLedger.sweepOnce();
  const stillOpen = await pool.query('SELECT count(*)::int n FROM raze_expectations WHERE resolved_at IS NULL');
  check('unreachable API leaves the expectation open rather than guessing',
    brokenSweep.unknown === 1 && stillOpen.rows[0].n === 1,
    `unknown=${brokenSweep.unknown} open=${stillOpen.rows[0].n}`);

  await pool.query('TRUNCATE raze_expectations');
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
