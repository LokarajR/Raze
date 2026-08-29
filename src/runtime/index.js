'use strict';

/**
 * Raze — Layer 1, protected runtime.
 *
 * Sits between Razorpay's delivery and the merchant's business state. The
 * merchant writes business logic only; dedupe, signature verification and event
 * ordering are handled before their handler is reachable.
 *
 * The guarantee, stated precisely: exactly-once business-state transition within
 * Raze's transactional boundary. The dedupe write and the handler's writes commit
 * in the same Postgres transaction, so a crash between them rolls back both and
 * the event is retried cleanly. Side effects outside the database (email,
 * shipping, WhatsApp) are outside that boundary — those go through the outbox,
 * which is at-least-once with idempotent delivery.
 *
 * Proven against five measured failure modes; see measurement/RESULTS.md for the
 * 796-delivery study the timing constants come from.
 */

const crypto = require('crypto');
const { withTransaction } = require('../db');

/** Worker retry backoff. Exponential on process_attempts, capped. */
const RETRY_BASE_MS = Number(process.env.RAZE_RETRY_BASE_MS || 250);
const RETRY_MAX_MS = Number(process.env.RAZE_RETRY_MAX_MS || 60000);

/**
 * Event ordering. Razorpay does not guarantee delivery order — their own docs say
 * the expected sequence may not be followed, and the measurement observed
 * payment.authorized, payment.captured and order.paid arriving within
 * milliseconds of each other with retries interleaving them further.
 */
const RANK = {
  'payment.authorized': 1,
  'payment.captured': 2,
  'payment.failed': 2, // terminal alternative to captured
  'order.paid': 2,
  'refund.created': 3,
  'refund.processed': 4,
};

/** Pull the subject a given event is about, so ordering can be tracked per order. */
function subjectOf(event) {
  const p = event?.payload || {};
  return (
    p.payment?.entity?.order_id ||
    p.order?.entity?.id ||
    p.refund?.entity?.payment_id ||
    p.payment?.entity?.id ||
    null
  );
}

function create(opts) {
  const pool = opts.db;
  const webhookSecret = opts.webhookSecret || '';
  const handlers = new Map();
  let onWork = () => {};

  if (!pool) throw new Error('raze.create({ db }) requires a pg Pool');

  // -------------------------------------------------------------------------
  // Merchant-facing surface
  // -------------------------------------------------------------------------
  function on(eventType, handler) {
    handlers.set(eventType, handler);
  }

  /**
   * Register an expectation inside the merchant's own transaction, so an order
   * cannot exist without the expectation that it will be paid.
   */
  async function expect({ subjectType, subjectId, event, within }, tx) {
    const ms = parseDuration(within);
    const q = `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
               VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
               ON CONFLICT DO NOTHING
               RETURNING id`;
    const runner = tx || pool;
    const r = await runner.query(q, [subjectType, subjectId, event, String(ms)]);
    return r.rows[0]?.id || null;
  }

  // -------------------------------------------------------------------------
  // Request path (§3.2). Steps in exactly this order.
  // -------------------------------------------------------------------------
  function middleware() {
    return async function razeMiddleware(req, res) {
      // 1. Raw bytes. express.raw() has already put the untouched Buffer on
      //    req.body; any parse-and-reserialize would change key order and
      //    whitespace and produce a different HMAC.
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

      // 2 + 3. HMAC over the raw bytes, constant-time compare.
      const signature = req.headers['x-razorpay-signature'];
      if (webhookSecret) {
        if (!signature || !verifySignature(raw, signature, webhookSecret)) {
          return res.status(401).json({ ok: false, error: 'signature verification failed' });
        }
      }

      // 4. Parse, extract the event id.
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.status(400).json({ ok: false, error: 'body is not valid JSON' });
      }
      const eventId = req.headers['x-razorpay-event-id'];
      if (!eventId) {
        return res.status(400).json({ ok: false, error: 'missing x-razorpay-event-id' });
      }

      // 5. Durable insert, deduped on the primary key.
      await pool.query(
        `INSERT INTO raze_inbox
           (event_id, event_type, raw_body, raw_body_sha256, signature, headers, subject_id, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'webhook')
         ON CONFLICT (event_id) DO NOTHING`,
        [
          eventId,
          event.event || 'unknown',
          raw,
          crypto.createHash('sha256').update(raw).digest('hex'),
          signature || null,
          JSON.stringify(req.headers),
          subjectOf(event),
        ]
      );

      // 6. Respond immediately. The measurement showed the retry ladder starts at
      //    0.23s for payment events, so an endpoint that processes synchronously
      //    and takes seconds will be sent a duplicate. Acknowledge, then work.
      res.status(200).json({ ok: true, event_id: eventId });

      // 7. Nudge the worker.
      setImmediate(() => onWork());
    };
  }

  // -------------------------------------------------------------------------
  // Worker path (§3.3)
  // -------------------------------------------------------------------------

  /** Process one pending row. Returns the event_id handled, or null if none. */
  async function processOne() {
    return withTransaction(pool, async (tx) => {
      const picked = await tx.query(
        `SELECT event_id, event_type, raw_body, subject_id, process_attempts
           FROM raze_inbox
          WHERE processed_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY received_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`
      );
      if (picked.rowCount === 0) return null;

      const row = picked.rows[0];
      const event = JSON.parse(row.raw_body.toString('utf8'));
      const subject = row.subject_id || subjectOf(event);
      const rank = RANK[row.event_type] ?? 0;

      // State machine. A lower-ranked event arriving after a higher one is stale:
      // mark it processed and move on. Never regress state, never crash.
      if (subject && rank > 0) {
        const cur = await tx.query(
          'SELECT rank FROM raze_subject_state WHERE subject_id = $1 FOR UPDATE',
          [subject]
        );
        const currentRank = cur.rows[0]?.rank ?? 0;
        if (rank < currentRank) {
          await tx.query(
            `UPDATE raze_inbox SET processed_at = now(), resolution = 'ignored_stale'
              WHERE event_id = $1`,
            [row.event_id]
          );
          return { eventId: row.event_id, resolution: 'ignored_stale' };
        }
      }

      const handler = handlers.get(row.event_type);
      let resolution = 'no_handler';

      try {
        if (handler) {
          await handler(event, tx);
          resolution = 'applied';
        }

        // Advance the recorded rank for this subject.
        if (subject && rank > 0) {
          await tx.query(
            `INSERT INTO raze_subject_state (subject_id, rank, event_type)
             VALUES ($1,$2,$3)
             ON CONFLICT (subject_id) DO UPDATE
               SET rank = GREATEST(raze_subject_state.rank, EXCLUDED.rank),
                   event_type = EXCLUDED.event_type,
                   updated_at = now()`,
            [subject, rank, row.event_type]
          );
        }

        // Resolve any matching expectation in the same transaction (§5.2).
        if (subject) {
          await tx.query(
            `UPDATE raze_expectations
                SET resolved_at = now(), resolution = 'fulfilled'
              WHERE subject_id = $1 AND expected_event = $2 AND resolved_at IS NULL`,
            [subject, row.event_type]
          );
        }

        await tx.query(
          'UPDATE raze_inbox SET processed_at = now(), resolution = $2 WHERE event_id = $1',
          [row.event_id, resolution]
        );

        return { eventId: row.event_id, resolution };
      } catch (err) {
        // Let the transaction roll back; record the failure outside it.
        err._razeEventId = row.event_id;
        throw err;
      }
    }).catch(async (err) => {
      if (!err._razeEventId) throw err;
      // Exponential backoff, capped. A poison row then costs one attempt per
      // interval instead of spinning the worker.
      await pool.query(
        `UPDATE raze_inbox
            SET process_attempts = process_attempts + 1,
                last_error = $2,
                next_attempt_at = now() + (LEAST(POWER(2, process_attempts) * $3, $4) || ' milliseconds')::interval
          WHERE event_id = $1`,
        [err._razeEventId, String(err.message).slice(0, 500), RETRY_BASE_MS, RETRY_MAX_MS]
      );
      return { eventId: err._razeEventId, resolution: 'error', error: err.message };
    });
  }

  /**
   * Drain the inbox. Returns how many rows were handled.
   *
   * A row that errors is not retried within the same pass — it has been given a
   * next_attempt_at in the future, and re-selecting it here would spin. Seen ids
   * are tracked so a row whose backoff is already past cannot loop either.
   */
  async function drain(limit = 1000) {
    let n = 0;
    const seen = new Set();
    for (let i = 0; i < limit; i++) {
      const r = await processOne();
      if (!r) break;
      if (seen.has(r.eventId)) break;
      seen.add(r.eventId);
      n++;
      if (r.resolution === 'error') continue;
    }
    return n;
  }

  let workerTimer = null;
  function startWorker({ intervalMs = 500 } = {}) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await drain(); } catch { /* keep the worker alive */ }
      running = false;
    };
    onWork = tick;
    workerTimer = setInterval(tick, intervalMs);
    if (workerTimer.unref) workerTimer.unref();
    return () => clearInterval(workerTimer);
  }

  function stopWorker() {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    onWork = () => {};
  }

  /**
   * Queue a side effect outside the transactional boundary. At-least-once with
   * idempotent delivery — not exactly-once execution.
   */
  async function emit({ idempotencyKey, effectType, payload }, tx) {
    const runner = tx || pool;
    await runner.query(
      `INSERT INTO raze_outbox (idempotency_key, effect_type, payload)
       VALUES ($1,$2,$3) ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, effectType, JSON.stringify(payload || {})]
    );
  }

  return { on, expect, emit, middleware, processOne, drain, startWorker, stopWorker, pool, RANK };
}

function verifySignature(raw, header, secret) {
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(header), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseDuration(s) {
  if (typeof s === 'number') return s;
  const m = String(s).match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!m) throw new Error(`unparseable duration: ${s}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

module.exports = { create, RANK, subjectOf, verifySignature, parseDuration };
