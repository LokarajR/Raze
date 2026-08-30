'use strict';

/**
 * Layer 1 tests. Real captured Razorpay deliveries, real Postgres, real HMAC.
 *
 * Fixtures come from measurement/deliveries.jsonl — 796 deliveries recorded over
 * the network from Razorpay during the retry study. Signature verification is on
 * for every test, so a fabricated payload could not pass.
 *
 *   node raze/test/layer1.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { connect, migrate, shutdown, withTransaction } = require('../src/db');
const raze = require('../src/runtime');

const ROOT = path.join(__dirname, '..', '..');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(ROOT, 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const { loadEnv, signing } = require('./env');

// Assigned in main(), before any fixture is built.
let signer;

function fixtures() {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64) continue;
    const k = `${r.event_id}|${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const v of byKey.values()) v.sort((a, b) => a.received_at_ms - b.received_at_ms);
  return byKey;
}

function pickLadder(byKey, eventType) {
  let best = null;
  for (const v of byKey.values()) {
    if (v[0].event_type !== eventType || v.length < 2) continue;
    if (!best || v.length > best.length) best = v;
  }
  return best.map((d) => ({
    body: Buffer.from(d.raw_body_b64, 'base64'),
    eventId: d.event_id,
    signature: signer.forBytes(Buffer.from(d.raw_body_b64, 'base64'), d.signature),
    eventType: d.event_type,
  }));
}

function pickLifecycle(byKey) {
  const first = new Map();
  for (const v of byKey.values()) {
    const d = v[0];
    if (!first.has(d.event_type)) first.set(d.event_type, d);
  }
  return ['payment.authorized', 'payment.captured', 'order.paid']
    .filter((t) => first.has(t))
    .map((t) => {
      const d = first.get(t);
      return {
        body: Buffer.from(d.raw_body_b64, 'base64'),
        eventId: d.event_id,
        signature: signer.forBytes(Buffer.from(d.raw_body_b64, 'base64'), d.signature),
        eventType: d.event_type,
      };
    });
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

async function main() {
  const env = loadEnv();
  signer = signing(env);
  // Downstream code reads the secret off env; keep the two in step.
  env.RAZORPAY_WEBHOOK_SECRET = signer.secret;
  const { pool, embedded } = await connect();
  await migrate(pool);
  console.log(`\nLayer 1 tests  (postgres: ${embedded ? 'embedded' : 'DATABASE_URL'})`);
  console.log(signer.banner() + '\n');

  // Merchant's own table. Raze never writes to it — the handler does.
  await pool.query(`CREATE TABLE IF NOT EXISTS demo_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL, credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);

  const reset = async () => {
    await pool.query('TRUNCATE raze_inbox, raze_subject_state, raze_expectations, raze_outbox, demo_orders');
  };

  const ps = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });

  ps.on('payment.captured', async (event, tx) => {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO demo_orders (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET status='paid',
             credited_paise = demo_orders.credited_paise + EXCLUDED.credited_paise,
             credit_count   = demo_orders.credit_count + 1`,
      [p.order_id, p.amount]
    );
  });
  ps.on('payment.authorized', async (event, tx) => {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO demo_orders (order_id, status) VALUES ($1,'authorized')
       ON CONFLICT (order_id) DO UPDATE SET status='authorized'`,
      [p.order_id]
    );
  });
  ps.on('order.paid', async (event, tx) => {
    const o = event.payload.order.entity;
    await tx.query(
      `INSERT INTO demo_orders (order_id, status) VALUES ($1,'paid')
       ON CONFLICT (order_id) DO UPDATE SET status='paid'`,
      [o.id]
    );
  });

  const app = express();
  app.use('/webhooks/razorpay', express.raw({ type: () => true }), ps.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/webhooks/razorpay`;

  const send = async (f, overrides = {}) => {
    const headers = { 'content-type': 'application/json' };
    const eid = overrides.eventId !== undefined ? overrides.eventId : f.eventId;
    const sig = overrides.signature !== undefined ? overrides.signature : f.signature;
    if (eid) headers['x-razorpay-event-id'] = eid;
    if (sig) headers['x-razorpay-signature'] = sig;
    const res = await fetch(url, { method: 'POST', headers, body: overrides.body || f.body });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const byKey = fixtures();
  const ladder = pickLadder(byKey, 'payment.captured');
  const orderId = JSON.parse(ladder[0].body.toString()).payload.payment.entity.order_id;

  // -- 1. duplicate delivery ------------------------------------------------
  await reset();
  await send(ladder[0]);
  await send(ladder[1]);
  await ps.drain();
  let r = await pool.query('SELECT credit_count, credited_paise FROM demo_orders WHERE order_id=$1', [orderId]);
  check('duplicate delivery -> exactly one business-state transition',
    r.rows[0]?.credit_count === 1,
    `credit_count=${r.rows[0]?.credit_count}`);

  // -- 2. full retry ladder -------------------------------------------------
  await reset();
  for (const d of ladder) await send(d);
  await ps.drain();
  r = await pool.query('SELECT credit_count FROM demo_orders WHERE order_id=$1', [orderId]);
  check(`full ${ladder.length}-delivery retry ladder -> one transition`,
    r.rows[0]?.credit_count === 1,
    `credit_count=${r.rows[0]?.credit_count}`);

  // -- 3. tampered signature ------------------------------------------------
  await reset();
  const forged = await send(ladder[0], { signature: '0'.repeat(64), eventId: 'forged-1' });
  await ps.drain();
  r = await pool.query('SELECT count(*)::int n FROM demo_orders');
  check('tampered signature -> rejected, zero state change',
    forged.status === 401 && r.rows[0].n === 0,
    `http=${forged.status} orders=${r.rows[0].n}`);

  // -- 4. out-of-order ------------------------------------------------------
  await reset();
  const lifecycle = pickLifecycle(byKey);
  for (const d of [...lifecycle].reverse()) await send(d);
  await ps.drain();
  const stale = await pool.query("SELECT count(*)::int n FROM raze_inbox WHERE resolution='ignored_stale'");
  const lifecycleOrder = JSON.parse(lifecycle[0].body.toString()).payload.payment.entity.order_id;
  r = await pool.query('SELECT status FROM demo_orders WHERE order_id=$1', [lifecycleOrder]);
  check('out-of-order delivery -> no state regression',
    r.rows[0]?.status === 'paid' && stale.rows[0].n > 0,
    `status=${r.rows[0]?.status} ignored_stale=${stale.rows[0].n}`);

  // -- 5. missing event id --------------------------------------------------
  await reset();
  const noId = await send(ladder[0], { eventId: null });
  check('missing x-razorpay-event-id -> 400', noId.status === 400, `http=${noId.status}`);

  // -- 6. malformed body ----------------------------------------------------
  // Signed over the truncated bytes, so the request passes signature verification
  // and actually reaches the parse step. Sending it unsigned would be rejected at
  // 401 by the signature check and would test nothing about parsing.
  await reset();
  const half = ladder[0].body.subarray(0, Math.floor(ladder[0].body.length / 2));
  const halfSig = require('crypto')
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(half).digest('hex');
  const mal = await send(ladder[0], { body: half, signature: halfSig, eventId: 'malformed-1' });
  r = await pool.query('SELECT count(*)::int n FROM demo_orders');
  check('malformed body -> rejected at parse, no crash, no state change',
    mal.status === 400 && r.rows[0].n === 0,
    `http=${mal.status} orders=${r.rows[0].n}`);

  // -- 7. transactional rollback -------------------------------------------
  // A handler that throws must leave the inbox row unprocessed AND write nothing.
  await reset();
  const boom = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  boom.on('payment.captured', async (event, tx) => {
    await tx.query(
      `INSERT INTO demo_orders (order_id, status, credit_count) VALUES ($1,'paid',1)`,
      [event.payload.payment.entity.order_id]
    );
    throw new Error('handler exploded after writing');
  });
  await send(ladder[0]);
  await boom.drain();
  const unprocessed = await pool.query('SELECT process_attempts FROM raze_inbox WHERE processed_at IS NULL');
  r = await pool.query('SELECT count(*)::int n FROM demo_orders');
  check('handler throws -> handler write rolled back with the inbox row',
    r.rows[0].n === 0 && unprocessed.rowCount === 1 && unprocessed.rows[0].process_attempts === 1,
    `orders=${r.rows[0].n} unprocessed=${unprocessed.rowCount} attempts=${unprocessed.rows[0]?.process_attempts}`);

  // -- 7b. poison row does not spin the worker -----------------------------
  // Regression guard: before backoff existed, one failing row was retried as fast
  // as drain() could loop, reaching 1000 attempts in a single pass.
  const attemptsAfterSecondDrain = await (async () => {
    await boom.drain();
    const q = await pool.query('SELECT process_attempts FROM raze_inbox WHERE processed_at IS NULL');
    return q.rows[0]?.process_attempts;
  })();
  check('failing row backs off instead of spinning',
    attemptsAfterSecondDrain <= 2,
    `attempts after a second drain=${attemptsAfterSecondDrain}`);

  // -- 8. expectation resolution -------------------------------------------
  await reset();
  await withTransaction(pool, async (tx) => {
    await ps.expect({ subjectType: 'order', subjectId: orderId, event: 'payment.captured', within: '15m' }, tx);
  });
  await send(ladder[0]);
  await ps.drain();
  const exp = await pool.query('SELECT resolution FROM raze_expectations WHERE subject_id=$1', [orderId]);
  check('expectation resolved by the delivery that fulfils it',
    exp.rows[0]?.resolution === 'fulfilled',
    `resolution=${exp.rows[0]?.resolution}`);

  // -- 9. raw body preserved byte-exact ------------------------------------
  await reset();
  await send(ladder[0]);
  const stored = await pool.query('SELECT raw_body FROM raze_inbox WHERE event_id=$1', [ladder[0].eventId]);
  check('raw body persisted byte-identical to what arrived',
    stored.rows[0].raw_body.equals(ladder[0].body));

  await reset();
  server.close();
  await shutdown(pool);

  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
