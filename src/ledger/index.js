'use strict';

/**
 * Raze — Layer 2, the Expectation Ledger.
 *
 * Reconciliation asks Razorpay what exists. The Ledger asks what we expected that
 * never arrived. Those are different questions, and only the second one can see
 * absence:
 *
 *   payment captured, webhook lost   reconcile catches it   ledger catches it
 *   payment attempted, declined      reconcile blind        ledger catches it
 *   order created, never paid        reconcile blind        ledger catches it
 *
 * Reconciliation enumerates what Razorpay recorded. If the customer never paid,
 * there is nothing to enumerate — no amount of scanning will surface an event
 * that does not exist. Only a deadline detects that.
 *
 * The sweeper has three outcomes, not one. Before flagging anything it asks
 * Razorpay what actually happened, because "the deadline passed" on its own
 * cannot distinguish a lost webhook from a declined card from a customer who
 * closed the tab. Reporting a declined payment as an abandonment would be wrong.
 */

const DEFAULTS = {
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS || 30000),
  batchSize: Number(process.env.SWEEP_BATCH || 100),
};

function createLedger(opts) {
  const pool = opts.db;
  const keyId = opts.razorpay?.keyId;
  const keySecret = opts.razorpay?.keySecret;
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };

  // Called when the sweeper finds a payment that exists but was never delivered.
  // Wired to the reconciler's repair path so recovery uses one code path.
  const repair = opts.repair || null;

  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  async function rzp(q) {
    const res = await fetch(`https://api.razorpay.com/v1${q}`, { headers: { authorization: auth } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  }

  /**
   * Ask Razorpay what happened to this subject. Returns one of:
   *   { kind: 'captured', payment }  money moved; the webhook was lost
   *   { kind: 'failed',   payment }  the customer tried, it was declined
   *   { kind: 'none' }               nothing ever happened
   *   { kind: 'unknown', reason }    could not tell — do NOT resolve
   */
  async function lookup(subjectType, subjectId) {
    const q = subjectType === 'order'
      ? `/orders/${encodeURIComponent(subjectId)}/payments`
      : `/payments/${encodeURIComponent(subjectId)}`;

    const { status, body } = await rzp(q);

    // A 400/404 on a well-formed id means Razorpay has no such order. That is a
    // real answer: nothing was ever created against it.
    if (status === 400 || status === 404) return { kind: 'none', detail: 'razorpay has no record of this subject' };
    if (status !== 200) return { kind: 'unknown', reason: `Razorpay API ${status}` };

    const payments = subjectType === 'order' ? (body.items || []) : [body];
    if (payments.length === 0) return { kind: 'none', detail: 'order exists, no payment attempted' };

    // A payment that reached captured (or was captured and later refunded) means
    // money moved and the merchant should know about it.
    const settled = payments.find((p) => p.status === 'captured' || p.status === 'refunded');
    if (settled) return { kind: 'captured', payment: settled };

    const failed = payments.find((p) => p.status === 'failed');
    if (failed) return { kind: 'failed', payment: failed };

    // authorized-but-not-captured: still in flight, not yet a verdict.
    return { kind: 'unknown', reason: `payments exist but none settled (${payments.map((p) => p.status).join(', ')})` };
  }

  /** One sweep. Returns the classification counts. */
  async function sweepOnce() {
    const due = await pool.query(
      `SELECT id, subject_type, subject_id, expected_event
         FROM raze_expectations
        WHERE resolved_at IS NULL AND deadline < now()
        ORDER BY deadline
        LIMIT $1`,
      [cfg.batchSize]
    );

    const counts = { checked: 0, recovered: 0, failed: 0, abandoned: 0, unknown: 0 };
    const details = [];

    for (const row of due.rows) {
      counts.checked++;
      const result = await lookup(row.subject_type, row.subject_id);

      if (result.kind === 'unknown') {
        // Leave it open. A verdict we cannot justify is worse than no verdict —
        // the expectation stays due and the next sweep tries again.
        counts.unknown++;
        details.push({ subject_id: row.subject_id, outcome: 'unknown', reason: result.reason });
        continue;
      }

      let resolution;
      if (result.kind === 'captured') {
        // Not an absence — a lost webhook. Feed it through the repair path so it
        // is applied by the same handler a delivered webhook would have used.
        resolution = 'recovered';
        counts.recovered++;
        if (repair) await repair(result.payment);
      } else if (result.kind === 'failed') {
        // The customer attempted and the bank declined. This is a payment
        // failure, NOT an abandonment. Conflating them misreports the funnel.
        resolution = 'failed';
        counts.failed++;
      } else {
        // Nothing exists. Reconciliation is structurally blind to this: there is
        // no record to enumerate.
        resolution = 'abandoned';
        counts.abandoned++;
      }

      await pool.query(
        `UPDATE raze_expectations
            SET resolved_at = now(), resolution = $2, resolution_detail = $3
          WHERE id = $1`,
        [row.id, resolution, JSON.stringify({
          checked_at: new Date().toISOString(),
          razorpay: result.kind,
          payment_id: result.payment?.id || null,
          detail: result.detail || null,
        })]
      );

      details.push({ subject_id: row.subject_id, outcome: resolution, payment_id: result.payment?.id || null });
    }

    return { ...counts, details };
  }

  let timer = null;
  function start() {
    if (timer) return stop;
    const tick = async () => { try { await sweepOnce(); } catch { /* keep the sweeper alive */ } };
    timer = setInterval(tick, cfg.sweepIntervalMs);
    if (timer.unref) timer.unref();
    tick();
    return stop;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  async function status() {
    const r = await pool.query(
      `SELECT
         count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
         count(*) FILTER (WHERE resolved_at IS NULL AND deadline < now())::int AS due,
         count(*) FILTER (WHERE resolution = 'fulfilled')::int AS fulfilled,
         count(*) FILTER (WHERE resolution = 'recovered')::int AS recovered,
         count(*) FILTER (WHERE resolution = 'failed')::int AS failed,
         count(*) FILTER (WHERE resolution = 'abandoned')::int AS abandoned
       FROM raze_expectations`
    );
    return { armed: !!timer, ...r.rows[0] };
  }

  return { sweepOnce, lookup, start, stop, status, config: cfg };
}

module.exports = { createLedger, DEFAULTS };
