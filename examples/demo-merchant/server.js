'use strict';

/**
 * Demo merchant — the subject under test.
 *
 * One codebase, three integrations of the same business logic. Only the
 * integration changes between them, which is the point: the business rule
 * ("a captured payment credits the wallet once") is identical in all three.
 *
 *   MODE=broken     naive. No dedupe, no signature verification.
 *                   What a first-pass integration looks like.
 *   MODE=correct    hand-written correct integration. Dedupe table,
 *                   signature verification, ordering guard. No Raze.
 *   MODE=protected  the broken handler, unchanged, behind Raze.
 *
 * `broken` and `protected` share the exact same handler body. That is the
 * demonstration: the merchant did not fix their code, Raze made the same code
 * safe.
 *
 * Probes read this merchant's state directly from Postgres. There is no
 * /test-state endpoint — instrumentation built for the test would be a form of
 * simulation.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { connect, migrate, withTransaction } = require('../../src/db');
const raze = require('../../src/runtime');

const MODE = (process.env.MODE || 'broken').toLowerCase();
const PORT = Number(process.env.PORT || 4100);
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const MERCHANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_orders (
  order_id       TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  credited_paise BIGINT NOT NULL DEFAULT 0,
  credit_count   INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only the 'correct' integration uses this. Raze has its own inbox.
CREATE TABLE IF NOT EXISTS shop_seen_events (
  event_id   TEXT PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shop_order_rank (
  order_id TEXT PRIMARY KEY,
  rank     INT NOT NULL
);
`;

const RANK = {
  'payment.authorized': 1,
  'payment.captured': 2,
  'payment.failed': 2,
  'order.paid': 2,
  'refund.created': 3,
};

/**
 * The business rule. Byte-for-byte the same in every mode.
 * A captured payment credits the wallet and marks the order paid.
 */
async function applyBusinessRule(tx, event) {
  const type = event.event;
  if (type === 'payment.captured') {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO shop_orders (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET status = 'paid',
             credited_paise = shop_orders.credited_paise + EXCLUDED.credited_paise,
             credit_count   = shop_orders.credit_count + 1,
             updated_at = now()`,
      [p.order_id, p.amount]
    );
  } else if (type === 'payment.authorized') {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO shop_orders (order_id, status) VALUES ($1,'authorized')
       ON CONFLICT (order_id) DO UPDATE SET status='authorized', updated_at=now()`,
      [p.order_id]
    );
  } else if (type === 'order.paid') {
    const o = event.payload.order.entity;
    await tx.query(
      `INSERT INTO shop_orders (order_id, status) VALUES ($1,'paid')
       ON CONFLICT (order_id) DO UPDATE SET status='paid', updated_at=now()`,
      [o.id]
    );
  } else if (type === 'refund.created') {
    // A refund.created payload carries BOTH entities: the refund and the payment
    // it belongs to. The order is on the payment — the refund entity only has
    // payment_id, never order_id.
    const r = event.payload.refund.entity;
    const orderId = event.payload.payment?.entity?.order_id;
    if (!orderId) return;
    await tx.query(
      `UPDATE shop_orders
          SET status = 'refunded',
              credited_paise = credited_paise - $2,
              updated_at = now()
        WHERE order_id = $1`,
      [orderId, r.amount]
    );
  }
}

function verifySignature(raw, header, secret) {
  if (!secret) return true;
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(header), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function main() {
  const { pool } = await connect();
  await migrate(pool);
  await pool.query(MERCHANT_SCHEMA);

  const app = express();
  let ps = null;

  if (MODE === 'protected') {
    // ---------------------------------------------------------------------
    // The broken handler, unchanged, behind Raze.
    // ---------------------------------------------------------------------
    ps = raze.create({ db: pool, webhookSecret: SECRET });
    for (const t of Object.keys(RANK)) {
      ps.on(t, async (event, tx) => { await applyBusinessRule(tx, event); });
    }
    ps.startWorker({ intervalMs: 200 });
    app.use('/webhook', express.raw({ type: () => true }), ps.middleware());
  } else {
    app.use('/webhook', express.raw({ type: () => true }), async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const eventId = req.headers['x-razorpay-event-id'];
      const signature = req.headers['x-razorpay-signature'];

      if (MODE === 'correct') {
        // ----- hand-written correct integration ---------------------------
        if (!verifySignature(raw, signature, SECRET)) {
          return res.status(401).json({ ok: false, error: 'bad signature' });
        }
        let event;
        try { event = JSON.parse(raw.toString('utf8')); }
        catch { return res.status(400).json({ ok: false, error: 'bad json' }); }
        if (!eventId) return res.status(400).json({ ok: false, error: 'no event id' });

        try {
          await withTransaction(pool, async (tx) => {
            const ins = await tx.query(
              'INSERT INTO shop_seen_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
              [eventId]
            );
            if (ins.rowCount === 0) return; // already applied
            const subject = event.payload?.payment?.entity?.order_id
              || event.payload?.order?.entity?.id;
            const rank = RANK[event.event] || 0;
            if (subject && rank) {
              const cur = await tx.query(
                'SELECT rank FROM shop_order_rank WHERE order_id=$1 FOR UPDATE', [subject]
              );
              if ((cur.rows[0]?.rank || 0) > rank) return; // stale, ignore
              await tx.query(
                `INSERT INTO shop_order_rank (order_id, rank) VALUES ($1,$2)
                 ON CONFLICT (order_id) DO UPDATE SET rank = GREATEST(shop_order_rank.rank, EXCLUDED.rank)`,
                [subject, rank]
              );
            }
            await applyBusinessRule(tx, event);
          });
        } catch (err) {
          return res.status(500).json({ ok: false, error: err.message });
        }
        return res.status(200).json({ ok: true });
      }

      // ----- broken integration -------------------------------------------
      // Broken in exactly two ways, both of them common in production:
      //   no signature verification, and no dedupe on x-razorpay-event-id.
      //
      // Ordering IS guarded here. That is deliberate: it keeps the bug surface
      // to the two documented defects, so a finding on ordering would be a false
      // positive rather than a second real bug. Returns 200 to everything, which
      // is precisely why status codes cannot detect any of it.
      let event;
      try { event = JSON.parse(raw.toString('utf8')); }
      catch { return res.status(400).json({ ok: false, error: 'bad json' }); }
      try {
        await withTransaction(pool, async (tx) => {
          const subject = event.payload?.payment?.entity?.order_id
            || event.payload?.order?.entity?.id;
          const rank = RANK[event.event] || 0;
          if (subject && rank) {
            const cur = await tx.query(
              'SELECT rank FROM shop_order_rank WHERE order_id=$1 FOR UPDATE', [subject]
            );
            if ((cur.rows[0]?.rank || 0) > rank) return; // stale, ignore
            await tx.query(
              `INSERT INTO shop_order_rank (order_id, rank) VALUES ($1,$2)
               ON CONFLICT (order_id) DO UPDATE SET rank = GREATEST(shop_order_rank.rank, EXCLUDED.rank)`,
              [subject, rank]
            );
          }
          await applyBusinessRule(tx, event);
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      return res.status(200).json({ ok: true });
    });
  }

  app.get('/health', (req, res) => res.json({ ok: true, mode: MODE }));

  const server = app.listen(PORT, () => {
    console.log(`demo merchant  mode=${MODE}  port=${PORT}`);
  });

  const shutdown = () => { server.close(); if (ps) ps.stopWorker(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { MERCHANT_SCHEMA, applyBusinessRule, RANK };
