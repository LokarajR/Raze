'use strict';

/**
 * Acme Store — order service.
 *
 * Handles Razorpay webhooks and updates order state.
 *
 * This is the file the repair agent rewrites. It is deliberately ordinary: the
 * kind of handler a competent developer writes in an afternoon, reading the
 * Razorpay docs and getting the happy path right. Nothing here is a strawman —
 * it parses correctly, it uses transactions, it returns sensible status codes.
 *
 * It is also wrong in ways that only show up under real delivery conditions,
 * which is exactly why the probes replay real captured traffic instead of
 * reasoning about the code.
 */

const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 4200);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();

app.get('/health', (req, res) => res.json({ ok: true, service: 'acme-orders' }));

app.post('/webhook', express.raw({ type: () => true }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (event.event === 'payment.authorized') {
      const payment = event.payload.payment.entity;
      await client.query(
        `INSERT INTO shop_orders (order_id, status)
         VALUES ($1, 'authorized')
         ON CONFLICT (order_id) DO UPDATE SET status = 'authorized', updated_at = now()`,
        [payment.order_id]
      );
    }

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      await client.query(
        `INSERT INTO shop_orders (order_id, status, credited_paise, credit_count)
         VALUES ($1, 'paid', $2, 1)
         ON CONFLICT (order_id) DO UPDATE
           SET status = 'paid',
               credited_paise = shop_orders.credited_paise + EXCLUDED.credited_paise,
               credit_count = shop_orders.credit_count + 1,
               updated_at = now()`,
        [payment.order_id, payment.amount]
      );
    }

    if (event.event === 'order.paid') {
      const order = event.payload.order.entity;
      await client.query(
        `INSERT INTO shop_orders (order_id, status)
         VALUES ($1, 'paid')
         ON CONFLICT (order_id) DO UPDATE SET status = 'paid', updated_at = now()`,
        [order.id]
      );
    }

    if (event.event === 'refund.created') {
      const refund = event.payload.refund.entity;
      await client.query(
        `UPDATE shop_orders
            SET status = 'refunded',
                credited_paise = credited_paise - $2,
                updated_at = now()
          WHERE order_id = $1`,
        [refund.payment_id, refund.amount]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('webhook handler failed:', err.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  } finally {
    client.release();
  }

  return res.status(200).json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`acme-orders listening on :${PORT}`);
});

process.on('SIGTERM', () => { server.close(); pool.end(); });
process.on('SIGINT', () => { server.close(); pool.end(); process.exit(0); });

module.exports = app;
