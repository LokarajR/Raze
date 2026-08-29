'use strict';

/**
 * MongoDB mapping and inference tests.
 *
 * Real MongoDB, real captured Razorpay deliveries, real retry ladder. The claim
 * under test is the one that differs from Postgres: without a shared
 * transaction, the idempotency guard inside the update has to carry the whole
 * weight. If it does not, a retry double-applies.
 *
 *   node test/layer7.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const mongoMapping = require('../src/mongo/mapping');
const mongoInfer = require('../src/mongo/infer');

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
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('merchant'));
  const db = mongoose.connection.db;

  const { pool } = await connect();
  await migrate(pool);
  console.log('\nLayer 7 tests  (MongoDB mappings and inference)\n');

  // A merchant collection shaped the way a Mongo merchant would shape it.
  const orders = db.collection('orders');
  await orders.deleteMany({});
  await orders.insertMany([
    { razorpay_order_id: 'order_seed_1', payment_status: 'pending', amount_paise: 0, credit_count: 0 },
  ]);

  const attempts = ladder('payment.captured');
  const event = JSON.parse(attempts[0].body.toString());
  const orderId = event.payload.payment.entity.order_id;
  const amount = event.payload.payment.entity.amount;

  // ---- 1. inference reads the sampled shape ------------------------------
  const inf = await mongoInfer.infer({ db, corpusPath: LOG });
  const captured = inf.proposals.find((p) => p.eventType === 'payment.captured' && p.spec.collection === 'orders');
  check('inference proposes a mapping from sampled documents',
    !!captured && captured.spec.key.field === 'razorpay_order_id',
    JSON.stringify(captured && captured.spec));

  check('inference reports the paise ambiguity rather than assuming',
    !!captured && captured.questions.some((q) => /paise/.test(q)),
    JSON.stringify(captured && captured.questions));

  // ---- 2. an unknown collection is refused at registration ---------------
  const rz = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  const m = mongoMapping.attach(rz, db);
  let rejected = false;
  try {
    await m.map('payment.captured', {
      collection: 'not_a_real_collection',
      key: { field: 'razorpay_order_id', from: 'payload.payment.entity.order_id' },
      set: { payment_status: { literal: 'paid' } },
    });
  } catch (err) { rejected = /unknown collection/.test(err.message); }
  check('a mapping naming a collection that does not exist is refused', rejected);

  // ---- 3. the real mapping ------------------------------------------------
  await m.map('payment.captured', {
    collection: 'orders',
    key: { field: 'razorpay_order_id', from: 'payload.payment.entity.order_id' },
    set: { payment_status: { literal: 'paid' } },
    inc: { amount_paise: 'payload.payment.entity.amount', credit_count: { literal: 1 } },
    guard: { field: 'payment_status', notIn: ['refunded'] },
  });

  const app = express();
  app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const send = async (f) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': f.eventId,
        'x-razorpay-signature': f.signature,
      },
      body: f.body,
    });
    await res.text();
    return res.status;
  };
  const state = async () => (await orders.findOne({ razorpay_order_id: orderId })) || {};
  const reset = async () => {
    await orders.deleteMany({ razorpay_order_id: orderId });
    await pool.query('TRUNCATE raze_inbox, raze_subject_state');
  };

  await reset();
  await send(attempts[0]);
  await rz.drain();
  let s = await state();
  check('one delivery applies the declared effect once',
    s.payment_status === 'paid' && s.amount_paise === amount && s.credit_count === 1,
    JSON.stringify({ status: s.payment_status, amount: s.amount_paise, count: s.credit_count }));

  // ---- 4. the real retry ladder ------------------------------------------
  await reset();
  for (const a of attempts) await send(a);
  await rz.drain();
  s = await state();
  check(`the real ${attempts.length}-delivery ladder applies exactly once`,
    s.amount_paise === amount && s.credit_count === 1,
    JSON.stringify({ amount: s.amount_paise, count: s.credit_count }));

  // ---- 5. the guard is what carries idempotency, not the transaction -----
  // Applying the compiled statement directly, repeatedly, must be a no-op after
  // the first. This is the property that replaces the shared transaction.
  await reset();
  const spec = mongoMapping.normalise('payment.captured', {
    collection: 'orders',
    key: { field: 'razorpay_order_id', from: 'payload.payment.entity.order_id' },
    set: { payment_status: { literal: 'paid' } },
    inc: { amount_paise: 'payload.payment.entity.amount' },
  });
  const stmt = mongoMapping.compile(spec, event, attempts[0].eventId);
  for (let i = 0; i < 5; i++) {
    await db.collection(stmt.collection).updateOne(stmt.filter, stmt.update, { upsert: stmt.upsert });
  }
  s = await state();
  check('applying the same compiled update five times changes state once',
    s.amount_paise === amount,
    `amount=${s.amount_paise} expected=${amount}`);

  // ---- 6. a different event id does apply --------------------------------
  const second = mongoMapping.compile(spec, event, 'a-different-event-id');
  await db.collection(second.collection).updateOne(second.filter, second.update, { upsert: second.upsert });
  s = await state();
  check('a genuinely different event still applies',
    s.amount_paise === amount * 2, `amount=${s.amount_paise}`);

  // ---- 7. an event with no id cannot be applied idempotently -------------
  const noId = mongoMapping.compile(spec, event, null);
  check('an event without an id is skipped rather than applied unsafely',
    !!noId.skip && /event id/.test(noId.skip), JSON.stringify(noId));

  // ---- 8. field names are validated, not interpolated --------------------
  let refused = false;
  try {
    mongoMapping.normalise('payment.captured', {
      collection: 'orders',
      key: { field: 'razorpay_order_id', from: 'payload.payment.entity.order_id' },
      set: { '$where': { literal: 'x' } },
    });
  } catch (err) { refused = /invalid set field/.test(err.message); }
  check('an operator-shaped field name is refused', refused);

  await orders.deleteMany({});
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
