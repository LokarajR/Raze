'use strict';

/**
 * Learning tests.
 *
 * The claim being checked is narrow and deliberate: Raze derives what it reports
 * from what it recorded, attaches the sample count to every figure, and refuses
 * to draw a conclusion from too few observations.
 *
 * The failure mode that matters here is a confident recommendation built on
 * four events. These tests exist to make that impossible.
 *
 *   node test/layer6.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const learn = require('../src/learn');

const ROOT = path.join(__dirname, '..', '..');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(ROOT, 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

function loadEnv() {
  const out = {};
  for (const p of [path.join(__dirname, '..', '.env'), path.join(ROOT, 'probe-server', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0 && !line.trim().startsWith('#')) {
          const k = line.slice(0, i).trim();
          if (!(k in out)) out[k] = line.slice(i + 1).trim();
        }
      }
    } catch {}
  }
  return { ...out, ...process.env };
}

function ladder(type) {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64 || r.event_type !== type) continue;
    const k = `${r.event_id}|${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let best = null;
  for (const v of byKey.values()) {
    v.sort((a, b) => a.received_at_ms - b.received_at_ms);
    if (!best || v.length > best.length) best = v;
  }
  return best.map((d) => ({
    body: Buffer.from(d.raw_body_b64, 'base64'),
    eventId: d.event_id,
    signature: d.signature,
  }));
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function main() {
  const env = loadEnv();
  const { pool } = await connect();
  await migrate(pool);
  console.log('\nLayer 6 tests  (learning from observed behaviour)\n');

  const reset = async () => {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  };
  await pool.query(`CREATE TABLE IF NOT EXISTS learn_orders (
    order_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'created',
    credited_paise BIGINT NOT NULL DEFAULT 0, credit_count INT NOT NULL DEFAULT 0)`);
  await reset();

  // ---- 1. summarise reports percentiles and the sample count --------------
  const s = learn.summarise([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  check('percentiles are computed with the sample count attached',
    s.n === 10 && s.p50 === 50 && s.p99 === 100, JSON.stringify(s));

  // ---- 2. too few observations is reported, never dressed up --------------
  await reset();
  for (let i = 0; i < 3; i++) {
    await learn.observe(pool, { kind: 'handler', eventType: 'payment.captured', valueMs: 100, ok: true });
  }
  let i1 = await learn.insights(pool);
  const h1 = i1.handlers.find((h) => h.eventType === 'payment.captured');
  check('three observations are marked insufficient, not turned into a finding',
    h1 && h1.enough === false && i1.recommendations.length === 0,
    `enough=${h1 && h1.enough} recs=${i1.recommendations.length}`);

  // ---- 3. a real failure rate is surfaced with its cause -------------------
  await reset();
  for (let i = 0; i < 30; i++) {
    await learn.observe(pool, {
      kind: 'handler', eventType: 'payment.captured', valueMs: 40,
      ok: i % 3 !== 0, detail: i % 3 === 0 ? 'paymentModel.update is not a function' : null,
    });
  }
  let i2 = await learn.insights(pool);
  const rec = i2.recommendations.find((r) => /handler for payment.captured/.test(r.setting));
  check('a sustained failure rate becomes a recommendation naming the cause',
    !!rec && /paymentModel\.update/.test(rec.because), JSON.stringify(rec));

  // ---- 4. a slow handler is flagged before it causes duplicates ------------
  await reset();
  for (let i = 0; i < 30; i++) {
    await learn.observe(pool, { kind: 'handler', eventType: 'order.paid', valueMs: 9000, ok: true });
  }
  const i3 = await learn.insights(pool);
  const slow = i3.recommendations.find((r) => /reduce latency/.test(r.value));
  check('a handler slower than the retry window is flagged',
    !!slow && /p95/.test(slow.because), JSON.stringify(slow));

  // ---- 5. the deadline is derived from real fulfilments --------------------
  await reset();
  for (let i = 0; i < 40; i++) {
    await pool.query(
      `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline, created_at, resolved_at, resolution)
       VALUES ('order', $1, 'payment.captured', now(), now() - ($2 || ' milliseconds')::interval, now(), 'fulfilled')`,
      [`order_${i}`, String(30000 + i * 1000)]
    );
  }
  const i4 = await learn.insights(pool);
  const deadline = i4.recommendations.find((r) => r.setting === 'expectation deadline');
  check('the expectation deadline is derived from observed fulfilment times',
    !!deadline && i4.fulfilment.enough && i4.fulfilment.duration.n === 40,
    JSON.stringify(deadline));

  // ---- 6. divergence from the measured baseline is noticed ----------------
  await reset();
  for (let i = 0; i < 30; i++) {
    // 4s first retry against a 0.23s measured baseline for payment.captured
    await learn.observe(pool, {
      kind: 'delivery', eventType: 'payment.captured', eventId: `e${i}`, valueMs: 4000, attempt: 2, ok: true,
    });
  }
  const i5 = await learn.insights(pool);
  const div = i5.retries.find((r) => r.eventType === 'payment.captured');
  check('behaviour diverging from the 796-delivery baseline is reported',
    !!div && !!div.divergence && /baseline/.test(div.divergence), JSON.stringify(div && div.divergence));

  // ---- 7. observing never breaks the payment path -------------------------
  await reset();
  const rz = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  const observed = learn.attach(rz, pool);
  let applied = 0;
  rz.on('payment.captured', async (event, tx) => {
    applied++;
    await tx.query(
      `INSERT INTO learn_orders (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1) ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = learn_orders.credited_paise + EXCLUDED.credited_paise,
             credit_count = learn_orders.credit_count + 1`,
      [event.payload.payment.entity.order_id, event.payload.payment.entity.amount]
    );
  });

  const app = express();
  app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const attempts = ladder('payment.captured');
  for (const a of attempts) {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': a.eventId,
        'x-razorpay-signature': a.signature,
      },
      body: a.body,
    }).then((r) => r.text());
  }
  await rz.drain();

  const orderId = JSON.parse(attempts[0].body.toString()).payload.payment.entity.order_id;
  const state = await pool.query('SELECT credit_count FROM learn_orders WHERE order_id=$1', [orderId]);
  const obs = await pool.query(`SELECT count(*)::int n FROM raze_observations WHERE kind='handler'`);

  check('the real ladder still applies exactly once while being observed',
    state.rows[0] && Number(state.rows[0].credit_count) === 1 && applied === 1,
    `credit_count=${state.rows[0] && state.rows[0].credit_count} handlerRuns=${applied}`);
  check('handler runs were recorded',
    obs.rows[0].n >= 1, `observations=${obs.rows[0].n}`);

  // ---- 8. a broken observation sink cannot break a payment ----------------
  await reset();
  await pool.query('ALTER TABLE raze_observations RENAME TO raze_observations_hidden');
  let survived = true;
  try {
    await learn.observe(pool, { kind: 'handler', eventType: 'x', valueMs: 1, ok: true });
  } catch {
    survived = false;
  }
  await pool.query('ALTER TABLE raze_observations_hidden RENAME TO raze_observations');
  check('an observation that cannot be written is swallowed, not raised',
    survived, 'observe() threw into the caller');

  await reset();
  server.close();
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
