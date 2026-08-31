'use strict';

/**
 * Kettle & Crumb — a shop that takes Razorpay payments.
 *
 * This exists so the problem Raze solves can be watched happening, rather than
 * described. It is not instrumented, it does not import Raze, and it has never
 * heard of it. It is a normal small integration: create an order, open Checkout,
 * and mark the order paid when the browser comes back and says the payment
 * succeeded.
 *
 * THE BUG IS THAT THERE IS NO BUG
 *
 * Nothing here is sabotaged. There is no flag that breaks it, no injected
 * failure, no artificial delay. The only path from "pending" to "paid" is the
 * customer's browser posting back after Checkout closes — which is exactly how a
 * first integration is written, because it is the path the quickstart shows and
 * it works every time you test it yourself.
 *
 * It works every time you test it because you never close the tab. A customer on
 * a train does. Their card is charged, Razorpay has the money, and this shop's
 * database still says pending — forever, because nothing will ever ask again.
 * The customer's order is not shipped and their money is gone.
 *
 * Razorpay's answer to this is webhooks, and the merchant's job is then to write
 * a handler that verifies an HMAC over raw bytes, deduplicates on an event id,
 * survives out-of-order delivery, and answers inside five seconds. Most shops
 * this size do not, which is the gap Raze fills — from the outside, without this
 * file changing by one character.
 *
 * WHAT IS SEEDED AND WHAT IS NOT
 *
 * On first boot this inserts a few months of prior orders so the table is not
 * empty. Those rows are invented and carry no gateway id, because the shop took
 * that trade over the counter. Every row with a gateway_order_id is a real
 * Razorpay order created by this server against the real API. Nothing fakes a
 * payment, a signature, or a Razorpay response.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 4100);
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

/**
 * The shop keeps its own database.
 *
 * DATABASE_URL points at whatever Postgres instance is to hand, which on a
 * shared host already has other people's tables in it. A shop's order book
 * living beside them is wrong for two reasons: a name as ordinary as
 * shop_orders collides — this file's first deployment crashed on someone
 * else's table of that name — and anything reading this database to understand
 * the shop would have to guess which tables are the shop's.
 *
 * So the shop creates and uses a database of its own on that instance. What
 * Raze is later pointed at is then exactly one merchant's data, which is what a
 * merchant would be handing over in the first place.
 */
const SHOP_DB = process.env.SHOP_DB || 'kettle';
const ssl = /\bsslmode=require\b/.test(process.env.DATABASE_URL || '')
  ? { rejectUnauthorized: false } : false;

function urlFor(database) {
  const u = new URL(process.env.DATABASE_URL || 'postgres://localhost:5432/postgres');
  u.pathname = '/' + database;
  return u.toString();
}

let pool;

async function openShopDatabase() {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 10000, ssl });
  admin.on('error', () => {});
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [SHOP_DB]);
    // CREATE DATABASE cannot run inside a transaction block, so it goes on its
    // own, and only when it is actually missing.
    if (!rows.length) await admin.query(`CREATE DATABASE ${SHOP_DB}`);
  } finally {
    await admin.end().catch(() => {});
  }
  pool = new Pool({ connectionString: urlFor(SHOP_DB), max: 6,
    connectionTimeoutMillis: 10000, ssl });
  pool.on('error', () => {});
}

const auth = () => 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

// ---------------------------------------------------------------------------
// The shop's own schema.
//
// Written the way a shop would write it, not the way an integration would like
// it: two money columns because the owner wants to see what was billed next to
// what actually arrived, a status the shop's staff read in plain words, and the
// gateway's id kept in a column of its own rather than overloaded onto the
// order reference the customer is quoted.
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_orders (
  id                 bigserial PRIMARY KEY,
  order_ref          text UNIQUE NOT NULL,
  gateway_order_id   text UNIQUE,
  customer_email     text NOT NULL,
  item               text NOT NULL,
  quantity           int NOT NULL DEFAULT 1,
  amount_due_paise   bigint NOT NULL,
  amount_paid_paise  bigint NOT NULL DEFAULT 0,
  order_state        text NOT NULL DEFAULT 'pending',
  placed_at          timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz
);
-- CREATE TABLE IF NOT EXISTS is not a migration: on a database that already has
-- a shop_orders of an older shape it does nothing at all, and the next statement
-- fails on a column that was never added. Each column is therefore stated again
-- on its own, which is a no-op on a table this file just created and a repair on
-- one it did not.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS order_ref         text;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS gateway_order_id  text;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS customer_email    text;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS item              text;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS quantity          int NOT NULL DEFAULT 1;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS amount_due_paise  bigint NOT NULL DEFAULT 0;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS amount_paid_paise bigint NOT NULL DEFAULT 0;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS order_state       text NOT NULL DEFAULT 'pending';
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS placed_at         timestamptz NOT NULL DEFAULT now();
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS paid_at           timestamptz;

CREATE INDEX IF NOT EXISTS shop_orders_gateway ON shop_orders (gateway_order_id);
CREATE INDEX IF NOT EXISTS shop_orders_state ON shop_orders (order_state);
`;

const CATALOGUE = [
  { sku: 'kettle', name: 'Cast iron kettle', paise: 249000 },
  { sku: 'beans', name: 'Single origin beans, 500g', paise: 89000 },
  { sku: 'grinder', name: 'Hand grinder', paise: 415000 },
  { sku: 'sourdough', name: 'Sourdough starter kit', paise: 62500 },
];

const NAMES = ['aditi', 'rahul', 'meera', 'farhan', 'nikhil', 'divya', 'sanjay',
  'priya', 'kabir', 'lakshmi', 'imran', 'tanvi'];

/**
 * Prior trade, so the table has a shape before anyone places an order.
 *
 * Deliberately gateway-free: these are counter sales. Anything that claims a
 * Razorpay order id in this database got it from Razorpay.
 */
async function seed() {
  const { rows } = await pool.query('SELECT count(*)::int n FROM shop_orders');
  if (rows[0].n > 0) return rows[0].n;

  const values = [];
  const params = [];
  for (let i = 0; i < 140; i++) {
    const item = CATALOGUE[i % CATALOGUE.length];
    const qty = 1 + (i % 3);
    const due = item.paise * qty;
    const daysAgo = 7 + Math.floor(i * 1.6);
    const who = `${NAMES[i % NAMES.length]}${100 + i}@example.com`;
    const p = params.length;
    params.push(`KC-${2000 + i}`, who, item.name, qty, due, due, 'paid',
      new Date(Date.now() - daysAgo * 86400000));
    values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 8})`);
  }
  await pool.query(
    `INSERT INTO shop_orders
       (order_ref, customer_email, item, quantity, amount_due_paise,
        amount_paid_paise, order_state, placed_at, paid_at)
     VALUES ${values.join(',')}`, params);
  return 140;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const send = (res, code, body, type = 'application/json') => {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true, shop: 'kettle-and-crumb' });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, page.replace('__KEY_ID__', KEY_ID), 'text/html; charset=utf-8');
    }

    if (url.pathname === '/api/catalogue') {
      return send(res, 200, { items: CATALOGUE, keyId: KEY_ID });
    }

    // The order exists in the shop's database before the customer is asked for
    // money, which is correct: an order nobody can find is worse than an order
    // that was never paid for.
    if (url.pathname === '/api/order' && req.method === 'POST') {
      const body = await readBody(req);
      const item = CATALOGUE.find((c) => c.sku === body.sku) || CATALOGUE[0];
      const qty = Math.max(1, Math.min(9, Number(body.quantity) || 1));
      const email = String(body.email || '').trim() || 'guest@example.com';
      const due = item.paise * qty;
      const ref = 'KC-' + Date.now().toString(36).toUpperCase();

      if (!KEY_ID || !KEY_SECRET) {
        return send(res, 500, { error: 'the shop has no Razorpay keys configured' });
      }
      const created = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { authorization: auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ amount: due, currency: 'INR', receipt: ref }),
      });
      const order = await created.json();
      if (!created.ok) {
        return send(res, 502, {
          error: (order.error && order.error.description) || `Razorpay said ${created.status}`,
        });
      }

      await pool.query(
        `INSERT INTO shop_orders
           (order_ref, gateway_order_id, customer_email, item, quantity, amount_due_paise)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ref, order.id, email, item.name, qty, due]);

      return send(res, 200, {
        orderRef: ref, gatewayOrderId: order.id, amount: due,
        keyId: KEY_ID, item: item.name, quantity: qty, email,
      });
    }

    // The only route to "paid", and the whole problem in four lines. It runs
    // when the customer's browser comes back. If it does not come back, nothing
    // else in this program will ever mark this order paid.
    if (url.pathname === '/api/confirm' && req.method === 'POST') {
      const body = await readBody(req);
      const gatewayOrderId = String(body.gatewayOrderId || '');
      const { rowCount } = await pool.query(
        `UPDATE shop_orders
            SET order_state = 'paid',
                amount_paid_paise = amount_due_paise,
                paid_at = now()
          WHERE gateway_order_id = $1 AND order_state = 'pending'`,
        [gatewayOrderId]);
      return send(res, 200, { updated: rowCount });
    }

    if (url.pathname === '/api/orders') {
      const { rows } = await pool.query(
        `SELECT order_ref, gateway_order_id, customer_email, item, quantity,
                amount_due_paise, amount_paid_paise, order_state, placed_at, paid_at
           FROM shop_orders
          WHERE gateway_order_id IS NOT NULL
          ORDER BY placed_at DESC
          LIMIT 40`);
      const totals = await pool.query(
        `SELECT count(*) FILTER (WHERE order_state = 'pending' AND gateway_order_id IS NOT NULL)::int AS pending,
                coalesce(sum(amount_due_paise) FILTER (WHERE order_state = 'pending'
                  AND gateway_order_id IS NOT NULL), 0)::bigint AS pending_paise,
                count(*)::int AS total
           FROM shop_orders`);
      return send(res, 200, { orders: rows, totals: totals.rows[0] });
    }

    return send(res, 404, { error: 'no such route' });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

(async () => {
  await openShopDatabase();
  await pool.query(SCHEMA);
  const seeded = await seed();
  server.listen(PORT, () => {
    console.log(`kettle & crumb on ${PORT}, database ${SHOP_DB}, `
      + `${seeded} prior order(s) in the book`);
  });
})().catch((err) => {
  console.error('could not start:', err.message);
  process.exit(1);
});
