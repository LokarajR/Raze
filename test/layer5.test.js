'use strict';

/**
 * Declarative mapping tests — the merchant writes no handler at all.
 *
 * Same real captured deliveries, same real Postgres. The difference from the
 * other layers is that there is no merchant function anywhere in the request
 * path: the business effect is declared, compiled to parameterised SQL, and run
 * inside the runtime's transaction.
 *
 *   node test/layer5.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const mapping = require('../src/mapping');

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

function ladders() {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
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

const fixture = (d) => ({
  body: Buffer.from(d.raw_body_b64, 'base64'),
  eventId: d.event_id,
  signature: d.signature,
  eventType: d.event_type,
});

function longest(byKey, type) {
  let best = null;
  for (const v of byKey.values()) {
    if (v[0].event_type !== type || v.length < 2) continue;
    if (!best || v.length > best.length) best = v;
  }
  return best.map(fixture);
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
  console.log('\nLayer 5 tests  (declarative mapping — no merchant handler)\n');

  // The merchant's own table. Raze is told about it; it is never told how to
  // write to it beyond the declaration below.
  await pool.query(`CREATE TABLE IF NOT EXISTS shop_orders (
    order_id       TEXT PRIMARY KEY,
    status         TEXT NOT NULL DEFAULT 'created',
    credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count   INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now())`);

  const reset = async () => {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  };

  const rz = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  const m = mapping.attach(rz, pool);

  // ---- the entire merchant integration, in three declarations ------------
  await m.map('payment.captured', {
    table: 'orders_missing_on_purpose_check_later',
    key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
    set: { status: { literal: 'paid' } },
  }).then(
    () => check('mapping against an unknown table is rejected at registration', false, 'it was accepted'),
    (err) => check('mapping against an unknown table is rejected at registration',
      /unknown table/.test(err.message), err.message)
  );

  await m.map('payment.captured', {
    table: 'shop_orders',
    key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
    set: { status: { literal: 'paid' } },
    add: { credited_paise: 'payload.payment.entity.amount', credit_count: { literal: 1 } },
    guard: { column: 'status', notIn: ['refunded'] },
  });

  await m.map('payment.authorized', {
    table: 'shop_orders',
    key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
    set: { status: { literal: 'authorized' } },
    guard: { column: 'status', notIn: ['paid', 'refunded'] },
  });

  await m.map('refund.created', {
    table: 'shop_orders',
    key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
    set: { status: { literal: 'refunded' } },
    add: { credited_paise: { literal: 0 } },
  });

  const app = express();
  app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const send = async (f) => {
    const headers = { 'content-type': 'application/json' };
    if (f.eventId) headers['x-razorpay-event-id'] = f.eventId;
    if (f.signature) headers['x-razorpay-signature'] = f.signature;
    const res = await fetch(url, { method: 'POST', headers, body: f.body });
    await res.text();
    return res.status;
  };

  const state = async (orderId) => {
    const r = await pool.query(
      'SELECT status, credited_paise, credit_count FROM shop_orders WHERE order_id=$1', [orderId]);
    const row = r.rows[0];
    return row
      ? { status: row.status, credited: Number(row.credited_paise), count: Number(row.credit_count) }
      : { status: null, credited: 0, count: 0 };
  };

  const byKey = ladders();
  const captured = longest(byKey, 'payment.captured');
  const orderId = JSON.parse(captured[0].body.toString()).payload.payment.entity.order_id;
  const amount = JSON.parse(captured[0].body.toString()).payload.payment.entity.amount;

  // ---- 1. a single delivery applies once ---------------------------------
  await reset();
  await send(captured[0]);
  await rz.drain();
  let s = await state(orderId);
  check('one delivery applies the declared effect exactly once',
    s.status === 'paid' && s.credited === amount && s.count === 1,
    JSON.stringify(s));

  // ---- 2. the full real retry ladder -------------------------------------
  await reset();
  for (const d of captured) await send(d);
  await rz.drain();
  s = await state(orderId);
  check(`the real ${captured.length}-delivery ladder still applies exactly once`,
    s.credited === amount && s.count === 1,
    JSON.stringify(s));

  // ---- 3. ordering guard --------------------------------------------------
  // authorized arriving after captured must not drag the order backwards.
  await reset();
  const authorized = longest(byKey, 'payment.authorized');
  await send(captured[0]);
  await rz.drain();
  await send(authorized[0]);
  await rz.drain();
  s = await state(orderId);
  check('a late authorized event cannot move a paid order backwards',
    s.status === 'paid', JSON.stringify(s));

  // ---- 4. forged signature never reaches the mapping ---------------------
  await reset();
  const forged = { ...captured[0], signature: '0'.repeat(64), eventId: `forged-${Date.now()}` };
  const code = await send(forged);
  await rz.drain();
  s = await state(orderId);
  check('a forged signature is rejected before any mapping runs',
    code === 401 && s.status === null, `http=${code} ${JSON.stringify(s)}`);

  // ---- 5. an event with nothing addressable is skipped, not failed -------
  await reset();
  const stmt = mapping.compile(
    { table: 'shop_orders', key: { column: 'order_id', from: 'payload.nothing.here' },
      set: { status: 'x' }, add: {}, guard: null, insertIfMissing: true },
    { payload: {} }
  );
  check('an event with no addressable key is skipped rather than erroring',
    !!stmt.skip, JSON.stringify(stmt).slice(0, 80));

  // ---- 6. identifiers are validated, not interpolated --------------------
  let rejected = false;
  try {
    await m.map('payment.failed', {
      table: 'shop_orders; DROP TABLE shop_orders; --',
      key: { column: 'order_id', from: 'payload.payment.entity.order_id' },
      set: { status: { literal: 'x' } },
    });
  } catch (err) {
    rejected = /invalid table name/.test(err.message);
  }
  const stillThere = await pool.query(
    `SELECT to_regclass('public.shop_orders') IS NOT NULL AS ok`);
  check('an identifier that is not a plain name is refused',
    rejected && stillThere.rows[0].ok, `rejected=${rejected}`);

  // ---- 7. no merchant code ran at all ------------------------------------
  await reset();
  await send(captured[0]);
  await rz.drain();
  const inbox = await pool.query(
    `SELECT resolution FROM raze_inbox WHERE event_id=$1`, [captured[0].eventId]);
  check('the event is applied with no merchant handler in the path',
    inbox.rows[0]?.resolution === 'applied', JSON.stringify(inbox.rows[0]));

  await reset();
  server.close();
  await shutdown(pool);
  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
