'use strict';

/**
 * Raze — Layer 3, reconciliation daemon.
 *
 * Answers the question the runtime cannot: did Razorpay record something we never
 * heard about? The runtime is only as good as what arrives; a webhook that is
 * never delivered leaves no trace in the inbox.
 *
 * The measurement makes the case concrete. Razorpay's retry ladder stops after
 * 22.76 hours, and sustained failure disables the endpoint outright — after which
 * delivery never resumes until a human re-enables it in a dashboard. Anything
 * missed in that window is never delivered. Waiting is not a recovery strategy;
 * enumeration is.
 *
 * Repairs go through the same handler as webhooks. There is no separate repair
 * code path, which is what makes the repair trustworthy: it is the same logic,
 * exercised the same way.
 *
 * Recovery is eventual and subject to Razorpay API availability and a correct
 * state mapping. The §1 gate established that mapping is `order_id`.
 */

const crypto = require('crypto');

const DEFAULTS = {
  intervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 60000),
  overlapMs: Number(process.env.RECONCILE_OVERLAP_MS || 5 * 60000),
  settleMs: Number(process.env.RECONCILE_SETTLE_MS || 30000),
  pageSize: Number(process.env.RECONCILE_PAGE_SIZE || 100), // gate recorded max 100
  coldStartMs: Number(process.env.RECONCILE_COLD_START_MS || 24 * 3600 * 1000),

  /**
   * Statuses that mean money actually moved and the merchant should know about it.
   *
   * `refunded` belongs here: a refunded payment was captured first, so a merchant
   * that never received its webhook has real drift — the order was paid and then
   * returned, and their state reflects neither. Excluding it would silently under-
   * report drift on exactly the payments most likely to matter.
   *
   * `failed` and `authorized` are deliberately absent. A failed payment moved no
   * money, and an authorized-but-uncaptured one has not settled. Absence of those
   * is the Expectation Ledger's job (§5), not reconciliation's.
   */
  settledStatuses: ['captured', 'refunded'],
};

function createReconciler(opts) {
  const pool = opts.db;
  const keyId = opts.razorpay?.keyId;
  const keySecret = opts.razorpay?.keySecret;
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };

  // How Raze learns which orders it already knows about. The merchant supplies
  // this because only they know their schema; it returns a Set of order ids.
  const localOrderIds = opts.localOrderIds;
  if (typeof localOrderIds !== 'function') {
    throw new Error('createReconciler requires localOrderIds(from, to) -> Set<order_id>');
  }

  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  let lastWindowTo = null;

  async function rzp(q) {
    const res = await fetch(`https://api.razorpay.com/v1${q}`, { headers: { authorization: auth } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 300) }; }
    if (res.status !== 200) {
      const err = new Error(`Razorpay API ${res.status}: ${(body.error && body.error.description) || 'unreadable'}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /** Enumerate a window completely, following skip until a short page returns. */
  async function enumeratePayments(fromSec, toSec) {
    const out = [];
    let skip = 0;
    for (;;) {
      const body = await rzp(`/payments?from=${fromSec}&to=${toSec}&count=${cfg.pageSize}&skip=${skip}`);
      const items = body.items || [];
      out.push(...items);
      if (items.length < cfg.pageSize) break;
      skip += cfg.pageSize;
      if (skip > 100000) throw new Error('pagination did not terminate');
    }
    return out;
  }

  /**
   * Turn a Razorpay API payment into an inbox row shaped like the webhook that
   * should have arrived. Marked source='reconcile' with a synthetic event id, so
   * repaired events are always distinguishable from delivered ones.
   */
  function synthesizeEvent(payment) {
    const event = {
      event: 'payment.captured',
      _raze_synthetic: true,
      _raze_note: 'reconstructed from the Razorpay API after the webhook was not delivered',
      payload: { payment: { entity: payment } },
    };
    const raw = Buffer.from(JSON.stringify(event), 'utf8');
    return {
      eventId: `recon_${payment.id}`,
      raw,
      sha: crypto.createHash('sha256').update(raw).digest('hex'),
      subjectId: payment.order_id || payment.id,
    };
  }

  /**
   * One reconciliation pass. Returns a summary; never throws for an unreachable
   * API — an unreachable API is recorded as a failed run, not a clean one.
   */
  async function runOnce({ now = Date.now() } = {}) {
    const windowTo = new Date(now - cfg.settleMs);
    // Overlapping windows are deliberate: a payment captured at the boundary can
    // be missed by a non-overlapping scan. ON CONFLICT DO NOTHING on the inbox
    // makes re-scanning harmless.
    const windowFrom = new Date((lastWindowTo ? lastWindowTo.getTime() : now - cfg.coldStartMs) - cfg.overlapMs);

    const fromSec = Math.floor(windowFrom.getTime() / 1000);
    const toSec = Math.floor(windowTo.getTime() / 1000);

    let payments;
    try {
      payments = await enumeratePayments(fromSec, toSec);
    } catch (err) {
      // Do NOT advance lastWindowTo — the window was not successfully covered.
      await pool.query(
        `INSERT INTO raze_reconcile_runs
           (window_from, window_to, razorpay_count, local_count, drift_found, drift_repaired, ok, error)
         VALUES ($1,$2,0,0,0,0,false,$3)`,
        [windowFrom, windowTo, err.message]
      );
      return { ok: false, error: err.message, windowFrom, windowTo, drift: 0, repaired: 0 };
    }

    const captured = payments.filter((p) => cfg.settledStatuses.includes(p.status));
    const known = await localOrderIds(windowFrom, windowTo);

    const drifted = captured.filter((p) => {
      const key = p.order_id || p.id;
      return key && !known.has(key);
    });

    let repaired = 0;
    for (const p of drifted) {
      const s = synthesizeEvent(p);
      const res = await pool.query(
        `INSERT INTO raze_inbox
           (event_id, event_type, raw_body, raw_body_sha256, signature, headers, subject_id, source)
         VALUES ($1,'payment.captured',$2,$3,NULL,'{}'::jsonb,$4,'reconcile')
         ON CONFLICT (event_id) DO NOTHING`,
        [s.eventId, s.raw, s.sha, s.subjectId]
      );
      if (res.rowCount > 0) repaired++;
    }

    lastWindowTo = windowTo;

    await pool.query(
      `INSERT INTO raze_reconcile_runs
         (window_from, window_to, razorpay_count, local_count, drift_found, drift_repaired, ok, detail)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
      [
        windowFrom, windowTo, captured.length, known.size, drifted.length, repaired,
        JSON.stringify({ drifted_payment_ids: drifted.map((p) => p.id).slice(0, 50) }),
      ]
    );

    return {
      ok: true, windowFrom, windowTo,
      razorpayCount: captured.length, localCount: known.size,
      drift: drifted.length, repaired,
      driftedIds: drifted.map((p) => p.id),
    };
  }

  let timer = null;
  function start() {
    if (timer) return stop;
    const tick = async () => { try { await runOnce(); } catch { /* keep the daemon alive */ } };
    timer = setInterval(tick, cfg.intervalMs);
    if (timer.unref) timer.unref();
    tick();
    return stop;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  async function status() {
    const r = await pool.query(
      `SELECT ran_at, ok, drift_found, drift_repaired, error
         FROM raze_reconcile_runs ORDER BY ran_at DESC LIMIT 1`
    );
    return { running: !!timer, lastRun: r.rows[0] || null, config: cfg };
  }

  return { runOnce, start, stop, status, enumeratePayments, synthesizeEvent, config: cfg };
}

module.exports = { createReconciler, DEFAULTS };
