'use strict';

/**
 * What Raze learns while it runs.
 *
 * The retry ladder was not read from documentation — it was measured, by
 * recording 796 real deliveries and computing over them. This module applies the
 * same method continuously, to this merchant's own traffic.
 *
 * WHY STATISTICS AND NOT A MODEL
 *
 * Every question here has an exact answer available from the record: how long
 * this merchant's handler takes, how long Razorpay really waits before retrying
 * on this account, how long a payment normally takes to arrive after an order is
 * created. A model would approximate answers that can simply be computed, and
 * could not show its working. When the output decides how long to wait before
 * declaring a payment lost, being able to say "p99 of 4,312 observations" is
 * worth more than any amount of inference.
 *
 * EVERY NUMBER CARRIES ITS SAMPLE COUNT
 *
 * A recommendation from four events must never look like one from four thousand.
 * Anything below MIN_SAMPLES is reported as insufficient rather than dressed up
 * as a finding, and nothing is applied automatically — insights are proposed the
 * same way mappings are.
 *
 * WHAT IT CANNOT DO
 *
 * It cannot promise there will be no failures. It can notice that this
 * merchant's handler is drifting towards the latency that causes duplicate
 * deliveries, that Razorpay is behaving differently for this account than the
 * baseline, or that reconciliation keeps finding drift — all before those become
 * incidents. Detection, not prophecy.
 */

const MIN_SAMPLES = Number(process.env.RAZE_MIN_SAMPLES || 20);

/**
 * The measured baseline, from the research section of README.md. Observations are compared
 * against it so a merchant can see when their account behaves differently from
 * what the study found.
 */
const BASELINE = {
  firstRetryMs: {
    'payment.authorized': 230,
    'payment.captured': 230,
    'order.paid': 240,
    'refund.created': 6400,
    'payment.failed': 7400,
  },
  maxDeliveries: 16,
  ladderSpanHours: 22.76,
};

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarise(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : null,
  };
}

/** Record one observation. Never throws into the caller's path. */
async function observe(pool, row) {
  try {
    await pool.query(
      `INSERT INTO raze_observations (kind, event_type, event_id, subject_id, value_ms, attempt, ok, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.kind, row.eventType || null, row.eventId || null, row.subjectId || null,
       row.valueMs == null ? null : Math.round(row.valueMs), row.attempt || null,
       row.ok == null ? null : !!row.ok, row.detail ? String(row.detail).slice(0, 300) : null]
    );
  } catch {
    // Observation is diagnostics. Losing one must never affect a payment.
  }
}

/**
 * How long Razorpay actually waits before retrying, on this account.
 *
 * Derived from the inbox rather than a separate log: the first delivery of an
 * event id and the attempts that followed are already recorded there.
 */
async function retryBehaviour(pool) {
  const { rows } = await pool.query(
    `SELECT event_type, value_ms, attempt
       FROM raze_observations
      WHERE kind = 'delivery' AND value_ms IS NOT NULL`
  );
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.event_type)) byType.set(r.event_type, { first: [], attempts: [] });
    const b = byType.get(r.event_type);
    if (r.attempt === 2) b.first.push(Number(r.value_ms));
    b.attempts.push(r.attempt || 1);
  }

  const out = [];
  for (const [type, b] of byType) {
    const stats = summarise(b.first);
    const baseline = BASELINE.firstRetryMs[type];
    const enough = stats.n >= MIN_SAMPLES;
    let divergence = null;
    if (enough && baseline && stats.p50 != null) {
      const ratio = stats.p50 / baseline;
      if (ratio > 1.5 || ratio < 0.66) {
        divergence = `first retry here is ${(stats.p50 / 1000).toFixed(2)}s against a measured baseline of ${(baseline / 1000).toFixed(2)}s`;
      }
    }
    out.push({
      eventType: type,
      firstRetry: stats,
      maxAttemptSeen: Math.max(...b.attempts),
      baselineMs: baseline || null,
      enough,
      divergence,
    });
  }
  return out.sort((a, b) => (b.firstRetry.n - a.firstRetry.n));
}

/**
 * How long the merchant's own handler takes.
 *
 * This is the number that decides whether they get duplicate deliveries. The
 * measurement showed the first retry arrives 0.23s after the original for
 * payment events, so a handler answering synchronously is racing a clock it
 * cannot win. Raze already answers before processing, but a slow handler still
 * signals a problem worth surfacing.
 */
async function handlerBehaviour(pool) {
  const { rows } = await pool.query(
    `SELECT event_type, value_ms, ok, detail
       FROM raze_observations
      WHERE kind = 'handler'`
  );
  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.event_type)) byType.set(r.event_type, { ms: [], fail: 0, total: 0, errors: new Map() });
    const b = byType.get(r.event_type);
    b.total++;
    if (r.value_ms != null) b.ms.push(Number(r.value_ms));
    if (r.ok === false) {
      b.fail++;
      const key = (r.detail || 'unknown').slice(0, 80);
      b.errors.set(key, (b.errors.get(key) || 0) + 1);
    }
  }

  const out = [];
  for (const [type, b] of byType) {
    const stats = summarise(b.ms);
    const failureRate = b.total ? b.fail / b.total : 0;
    const topError = [...b.errors.entries()].sort((x, y) => y[1] - x[1])[0] || null;
    out.push({
      eventType: type,
      duration: stats,
      total: b.total,
      failures: b.fail,
      failureRate,
      topError: topError ? { message: topError[0], count: topError[1] } : null,
      enough: b.total >= MIN_SAMPLES,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

/**
 * How long a payment actually takes to arrive after an order is created.
 *
 * This is what an expectation deadline should be, and guessing it is how a
 * ledger produces false abandonments. Fifteen minutes is a guess; the p99 of
 * this merchant's own fulfilments is a measurement.
 */
async function fulfilmentBehaviour(pool) {
  const { rows } = await pool.query(
    `SELECT extract(epoch from (resolved_at - created_at)) * 1000 AS ms, resolution
       FROM raze_expectations
      WHERE resolved_at IS NOT NULL AND resolution IN ('fulfilled', 'recovered')`
  );
  const ms = rows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n >= 0);
  const stats = summarise(ms);

  const { rows: counts } = await pool.query(
    `SELECT resolution, count(*)::int n FROM raze_expectations
      WHERE resolved_at IS NOT NULL GROUP BY resolution`
  );
  const resolutions = Object.fromEntries(counts.map((r) => [r.resolution, r.n]));

  // A deadline should sit beyond nearly every real fulfilment, with headroom.
  // Too tight produces false abandonments; too loose delays detection.
  const suggestedDeadlineMs = stats.p99 != null ? Math.ceil((stats.p99 * 1.5) / 60000) * 60000 : null;

  return { duration: stats, resolutions, suggestedDeadlineMs, enough: stats.n >= MIN_SAMPLES };
}

/** How often reconciliation finds something delivery missed. */
async function deliveryReliability(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int runs,
            count(*) FILTER (WHERE ok)::int ok_runs,
            coalesce(sum(drift_found), 0)::int drift,
            coalesce(sum(razorpay_count), 0)::int seen
       FROM raze_reconcile_runs`
  );
  const r = rows[0];
  return {
    runs: r.runs,
    okRuns: r.ok_runs,
    drift: r.drift,
    seen: r.seen,
    driftRate: r.seen ? r.drift / r.seen : 0,
    enough: r.runs >= 5,
  };
}

/** Everything, plus the recommendations that follow from it. */
async function insights(pool) {
  const [retries, handlers, fulfilment, reliability] = await Promise.all([
    retryBehaviour(pool), handlerBehaviour(pool), fulfilmentBehaviour(pool), deliveryReliability(pool),
  ]);

  const recommendations = [];

  if (fulfilment.enough && fulfilment.suggestedDeadlineMs) {
    recommendations.push({
      setting: 'expectation deadline',
      value: `${Math.round(fulfilment.suggestedDeadlineMs / 60000)}m`,
      because: `p99 of ${fulfilment.duration.n} real fulfilments is ${(fulfilment.duration.p99 / 1000).toFixed(1)}s; this leaves 50% headroom`,
    });
  }

  for (const h of handlers) {
    if (!h.enough) continue;
    if (h.failureRate > 0.05) {
      recommendations.push({
        setting: `handler for ${h.eventType}`,
        value: 'investigate',
        because: `${(h.failureRate * 100).toFixed(1)}% of ${h.total} runs failed` +
          (h.topError ? `, most often: ${h.topError.message}` : ''),
      });
    }
    if (h.duration.p95 != null && h.duration.p95 > 5000) {
      recommendations.push({
        setting: `handler for ${h.eventType}`,
        value: 'reduce latency',
        because: `p95 is ${(h.duration.p95 / 1000).toFixed(1)}s — a synchronous handler this slow is retried before it answers`,
      });
    }
  }

  for (const r of retries) {
    if (r.divergence) {
      recommendations.push({
        setting: `retry expectations for ${r.eventType}`,
        value: 'review',
        because: r.divergence,
      });
    }
  }

  if (reliability.enough && reliability.driftRate > 0.01) {
    recommendations.push({
      setting: 'reconcile interval',
      value: 'shorten',
      because: `${(reliability.driftRate * 100).toFixed(2)}% of payments seen by reconciliation were missing locally`,
    });
  }
  if (reliability.runs > 0 && reliability.okRuns < reliability.runs) {
    recommendations.push({
      setting: 'reconciliation health',
      value: 'investigate',
      because: `${reliability.runs - reliability.okRuns} of ${reliability.runs} runs did not complete — an uncovered window is not the same as no drift`,
    });
  }

  return { retries, handlers, fulfilment, reliability, recommendations, minSamples: MIN_SAMPLES };
}

/**
 * Wrap a runtime so every delivery and handler run is observed.
 *
 * Recording is best-effort and never sits between a payment and its effect.
 */
function attach(rz, pool) {
  const originalOn = rz.on;

  rz.on = function observedOn(eventType, handler) {
    return originalOn.call(rz, eventType, async (event, tx, meta) => {
      const started = Date.now();
      try {
        const out = await handler(event, tx, meta);
        await observe(pool, {
          kind: 'handler', eventType, eventId: meta && meta.eventId,
          valueMs: Date.now() - started, attempt: meta && meta.attempt, ok: true,
        });
        return out;
      } catch (err) {
        await observe(pool, {
          kind: 'handler', eventType, eventId: meta && meta.eventId,
          valueMs: Date.now() - started, attempt: meta && meta.attempt,
          ok: false, detail: err.message,
        });
        throw err;
      }
    });
  };

  /**
   * Record the arrival of a delivery relative to the first one for that event.
   * Called from the middleware path; the first delivery establishes the origin.
   */
  async function observeDelivery({ eventId, eventType, subjectId }) {
    try {
      const { rows } = await pool.query(
        `SELECT min(at) AS first_at, count(*)::int n
           FROM raze_observations WHERE kind='delivery' AND event_id=$1`,
        [eventId]
      );
      const first = rows[0] && rows[0].first_at;
      const valueMs = first ? Date.now() - new Date(first).getTime() : 0;
      await observe(pool, {
        kind: 'delivery', eventType, eventId, subjectId,
        valueMs, attempt: (rows[0] ? rows[0].n : 0) + 1, ok: true,
      });
    } catch {}
  }

  return { observeDelivery, insights: () => insights(pool), observe: (r) => observe(pool, r) };
}

module.exports = {
  attach, observe, insights, retryBehaviour, handlerBehaviour,
  fulfilmentBehaviour, deliveryReliability, summarise, BASELINE, MIN_SAMPLES,
};
