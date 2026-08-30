'use strict';

/**
 * The outbox — effects that live outside the transaction.
 *
 * Everything Raze guarantees rests on one transaction: the dedupe write and the
 * business write commit together, so an event is applied exactly once. An email,
 * a shipping call or a WhatsApp message cannot join that transaction. There is
 * no way to send an email and commit a row atomically, and pretending otherwise
 * is how systems end up sending three receipts for one payment.
 *
 * So the handler writes its intent to this table inside the transaction, and a
 * drainer delivers it afterwards. That moves the guarantee, honestly:
 *
 *   inside the transaction    exactly-once business state
 *   outside it                at-least-once delivery, deduplicated by an
 *                             idempotency key the receiver is expected to honour
 *
 * The distinction is not pedantry. A merchant reading "exactly-once" and then
 * sending money or email on that basis would be misled, and the README says the
 * same thing in the same words.
 *
 * A row is claimed with FOR UPDATE SKIP LOCKED, so several drainers can run
 * without delivering the same effect twice.
 */

const DEFAULTS = {
  intervalMs: Number(process.env.OUTBOX_INTERVAL_MS || 2000),
  batchSize: Number(process.env.OUTBOX_BATCH || 20),
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS || 12),
  baseBackoffMs: Number(process.env.OUTBOX_BACKOFF_MS || 500),
};

function createOutbox(opts) {
  const pool = opts.db;
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };

  /**
   * How each effect type is actually delivered. The merchant registers these;
   * Raze never invents a way to send something.
   */
  const senders = new Map();

  function on(effectType, sender) {
    senders.set(effectType, sender);
  }

  /**
   * Deliver one pending effect.
   *
   * The row is claimed and delivered outside any transaction the business write
   * used — by this point that transaction has committed, which is the whole
   * reason the effect is here rather than inline.
   */
  async function deliverOne() {
    const claimed = await pool.query(
      `UPDATE raze_outbox
          SET attempts = attempts + 1
        WHERE id = (
          SELECT id FROM raze_outbox
           WHERE delivered_at IS NULL
             AND attempts < $1
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING id, idempotency_key, effect_type, payload, attempts`,
      [cfg.maxAttempts]
    );
    if (claimed.rowCount === 0) return null;

    const row = claimed.rows[0];
    const sender = senders.get(row.effect_type);

    if (!sender) {
      // Not a failure of delivery — nothing knows how to deliver it. Recorded
      // rather than retried, because retrying will not conjure a sender.
      await pool.query(
        `UPDATE raze_outbox SET last_error = $2, next_attempt_at = now() + interval '1 hour'
          WHERE id = $1`,
        [row.id, `no sender registered for effect type "${row.effect_type}"`]
      );
      return { id: row.id, delivered: false, reason: 'no sender' };
    }

    try {
      await sender(row.payload, {
        idempotencyKey: row.idempotency_key,
        effectType: row.effect_type,
        attempt: row.attempts,
      });
      await pool.query(
        `UPDATE raze_outbox SET delivered_at = now(), last_error = NULL WHERE id = $1`,
        [row.id]
      );
      return { id: row.id, delivered: true, attempts: row.attempts };
    } catch (err) {
      const backoff = Math.min(cfg.baseBackoffMs * 2 ** row.attempts, 3600000);
      await pool.query(
        `UPDATE raze_outbox
            SET last_error = $2,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval
          WHERE id = $1`,
        [row.id, String(err.message).slice(0, 400), String(Math.round(backoff))]
      );
      return { id: row.id, delivered: false, error: err.message, attempts: row.attempts };
    }
  }

  async function drain(limit = cfg.batchSize) {
    let delivered = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const r = await deliverOne();
      if (!r) break;
      if (r.delivered) delivered++; else failed++;
    }
    return { delivered, failed };
  }

  let timer = null;
  function start() {
    if (timer) return stop;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await drain(); } catch { /* a drainer must not die on one bad effect */ }
      running = false;
    };
    timer = setInterval(tick, cfg.intervalMs);
    if (timer.unref) timer.unref();
    tick();
    return stop;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  async function status() {
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE delivered_at IS NULL)::int pending,
              count(*) FILTER (WHERE delivered_at IS NOT NULL)::int delivered,
              count(*) FILTER (WHERE delivered_at IS NULL AND attempts >= $1)::int exhausted,
              max(last_error) AS last_error
         FROM raze_outbox`,
      [cfg.maxAttempts]
    );
    return { running: !!timer, ...r.rows[0], senders: [...senders.keys()] };
  }

  return { on, drain, deliverOne, start, stop, status, config: cfg };
}

module.exports = { createOutbox, DEFAULTS };
