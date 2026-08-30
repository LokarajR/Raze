'use strict';

/**
 * What the defects cost, in money, measured rather than asserted.
 *
 * Every number here comes from one of three places, and each figure carries
 * which one it came from so nothing has to be taken on trust:
 *
 *   probe     the audit fired real deliveries at the running merchant and read
 *             the merchant's own table afterwards
 *   razorpay  the live Razorpay API, asked what it actually recorded
 *   measured  the 796-delivery retry measurement bundled in measurement/
 *
 * Two rules keep this honest, and both cost us headline numbers:
 *
 * An order nobody paid for is NOT a loss. The Expectation Ledger separates
 * "abandoned" from "failed to record", and only the second is money. A tool
 * that counts abandonment as revenue loss is inflating its own case.
 *
 * A projection is never presented as a measurement. Projected figures exist
 * only when the operator supplies their own volume, and they are returned in a
 * separate object with the arithmetic attached, so the reader can check it.
 */

const RUPEES = (paise) => Math.round(paise) / 100;

/** From measurement/RESULTS.md — the observed Razorpay retry behaviour. */
const MEASURED = {
  maxDeliveries: 16,
  firstRetryMs: 230,
  spanHours: 22.76,
  corpusDeliveries: 796,
};

/**
 * Damage the probes actually caused, read back from the merchant's own rows.
 *
 * The probes pay real attention to which defect produced which kind of loss,
 * because they are not the same kind. Money credited that nobody paid is a
 * different failure from money paid that was never credited, and a merchant
 * cares about them differently.
 */
function fromProbes(results) {
  const out = {
    phantomCreditPaise: 0,   // credited without a matching payment
    unrecordedPaise: 0,      // real payment the merchant never recorded
    corruptedOrders: 0,      // state left wrong in a way money depends on
    failed: [],
  };

  for (const r of results || []) {
    if (r.pass) continue;
    const e = r.evidence || {};
    out.failed.push(r.name);

    if (r.name === 'duplicate-delivery') {
      // Credited more than once for one payment. The excess over the payment's
      // real amount is money the merchant gave away against a single payment.
      const credited = Number(e.credited_paise || 0);
      const owed = Number(e.amount_paise || 0);
      if (credited > owed) out.phantomCreditPaise += credited - owed;
    }

    if (r.name === 'timeout-retry') {
      // The merchant's own single-delivery result is the control. Anything the
      // retries added on top of it is money nobody paid.
      const one = Number(e.single_credited_paise || 0);
      const many = Number(e.retried_credited_paise || 0);
      if (many > one) out.phantomCreditPaise += many - one;
    }

    if (r.name === 'tampered-signature') {
      // Anyone who knows the URL can credit an account. Every paise of it is
      // phantom: there is no payment behind it at all.
      out.phantomCreditPaise += Number(e.credited_paise || 0);
    }

    if (r.name === 'refund-event') {
      // A refund that leaves the balance wrong is corruption in either
      // direction: credit that survived a refund, or a negative balance the
      // merchant now owes against.
      out.corruptedOrders += 1;
      const after = Number(e.credited_paise_after || 0);
      if (after < 0) out.phantomCreditPaise += Math.abs(after);
    }

    if (r.name === 'out-of-order') {
      out.corruptedOrders += 1;
    }
  }
  return out;
}

/**
 * Ask Razorpay what it recorded, and compare against the merchant's table.
 *
 * This is the figure that matters most and the one a merchant cannot get from
 * their own logs: payments Razorpay captured that never became business state.
 * Their webhook returned 200 for every one of them.
 */
async function fromRazorpay({
  pool, razorpay, table = 'shop_orders', windowHours = 72,
  // A merchant's columns are theirs, not ours. Hardcoding order_id and
  // credited_paise made every real schema look unreadable, and "unreadable"
  // was then reported as if Razorpay were down.
  keyColumn = 'order_id', amountColumn = 'credited_paise',
} = {}) {
  if (!razorpay || !razorpay.keyId || !razorpay.keySecret) {
    return { available: false, kind: 'provider', reason: 'no Razorpay credentials configured' };
  }
  const to = Math.floor(Date.now() / 1000);
  const from = to - windowHours * 3600;
  const auth = 'Basic ' + Buffer.from(`${razorpay.keyId}:${razorpay.keySecret}`).toString('base64');

  let items = [];
  try {
    const res = await fetch(
      `https://api.razorpay.com/v1/payments?from=${from}&to=${to}&count=100`,
      { headers: { authorization: auth } }
    );
    const body = await res.json();
    if (!res.ok) {
      return { available: false, kind: 'provider',
        reason: body.error?.description || `HTTP ${res.status}` };
    }
    items = body.items || [];
  } catch (err) {
    return { available: false, kind: 'provider', reason: err.message };
  }

  // Only settled money counts. A refunded payment was still captured — the
  // money moved, and the merchant still had to record it.
  const settled = items.filter((p) => p.status === 'captured' || p.status === 'refunded');

  let local = new Map();
  try {
    const r = await pool.query(
      `SELECT "${keyColumn}" AS key, "${amountColumn}" AS amount FROM "${table}"`);
    local = new Map(r.rows.map((x) => [x.key, x]));
  } catch (err) {
    // Razorpay answered. It is the merchant's own table that cannot be read —
    // a different problem with a different fix, and reporting it as "cannot
    // reach Razorpay" would send them to look in the wrong place.
    return {
      available: false, kind: 'local',
      reason: `cannot read "${table}": ${err.message}`,
    };
  }

  const missing = [];
  for (const p of settled) {
    if (!p.order_id) continue;
    const row = local.get(p.order_id);
    const applied = row && Number(row.amount) > 0;
    if (!applied) missing.push({ id: p.id, order_id: p.order_id, amount: p.amount, status: p.status });
  }

  return {
    available: true,
    windowHours,
    capturedCount: settled.length,
    capturedPaise: settled.reduce((s, p) => s + p.amount, 0),
    unrecorded: missing,
    unrecordedPaise: missing.reduce((s, p) => s + p.amount, 0),
  };
}

/**
 * Orders that will never be paid, kept deliberately separate.
 *
 * Reconciliation cannot see these — there is no payment to enumerate — and they
 * are not revenue loss. They are reported so the operator can see the tool
 * telling them apart rather than quietly folding them into a bigger number.
 */
async function abandonment(pool) {
  try {
    const r = await pool.query(
      `SELECT resolution, count(*)::int n FROM raze_expectations
        WHERE resolved_at IS NOT NULL GROUP BY resolution`
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.resolution, x.n]));
    return {
      recovered: by.recovered || 0,
      failed: by.failed || 0,
      abandoned: by.abandoned || 0,
      note: 'abandoned means the customer never paid — not a delivery failure, and not revenue lost',
    };
  } catch {
    return { recovered: 0, failed: 0, abandoned: 0, note: 'no expectations armed yet' };
  }
}

/**
 * What Razorpay does to an endpoint that keeps failing.
 *
 * Measured, not quoted from documentation: 16 deliveries across 22.76 hours,
 * first retry 0.23s. After sustained failure Razorpay deactivates the endpoint,
 * which is the point at which a merchant stops receiving anything at all.
 */
function endpointRisk(failedProbes) {
  const failing = (failedProbes || []).length > 0;
  return {
    ...MEASURED,
    failing,
    consequence: failing
      ? 'Every delivery above returned HTTP 200, so Razorpay sees a healthy endpoint '
        + 'and stops retrying. The state is wrong and nothing will retry it.'
      : 'Deliveries are answered and applied; no escalation path is being exercised.',
  };
}

/**
 * Project onto the operator's own traffic.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not derive a transaction defect rate from how many probes failed.
 * Four of five probe categories failing does not mean four in five payments
 * lose money — they are categories of defect, not a sample of traffic, and
 * multiplying revenue by that ratio produces a number that is large and untrue.
 *
 * It also does not use the corpus retry rate. 80% of the events in the 796
 * delivery measurement received more than one delivery, but that is a property
 * of the experiment: deliveries were deliberately failed to make Razorpay retry
 * so the ladder could be measured. It records what Razorpay does when a delivery
 * fails, not how often deliveries fail in production.
 *
 * So the one number that decides the size of the loss — how often a delivery to
 * this merchant fails — has to come from the merchant. It is asked for, not
 * assumed, and the projection simply does not exist until it is supplied.
 */
function project({ monthlyTransactions, averageOrderValueRupees, retryRatePercent, defects }) {
  if (!monthlyTransactions || !averageOrderValueRupees) return null;
  if (retryRatePercent == null || retryRatePercent === '') return null;

  const rate = Number(retryRatePercent) / 100;
  if (!(rate >= 0 && rate <= 1)) return null;

  // Only defects that trigger on a repeated delivery scale with traffic. A
  // handler that accepts forged signatures is exposed on every request, but
  // that is an attack surface, not a rate, and it is reported separately rather
  // than folded into a revenue figure.
  const duplicating = (defects || []).some((d) => d === 'duplicate-delivery' || d === 'timeout-retry');
  if (!duplicating) {
    return {
      inputs: { monthlyTransactions, averageOrderValueRupees, retryRatePercent },
      applicable: false,
      reason: 'This merchant does not double-apply a repeated delivery, so there is no '
        + 'per-transaction loss to project. Any remaining findings are correctness or '
        + 'security issues, not a rate.',
    };
  }

  // One extra credit per retried transaction: the retry applies the same effect
  // a second time. Deeper ladders cost more, but the second delivery is the one
  // that is certain, so this is the conservative figure.
  const affected = monthlyTransactions * rate;
  const perMonth = affected * averageOrderValueRupees;
  return {
    inputs: { monthlyTransactions, averageOrderValueRupees, retryRatePercent },
    applicable: true,
    arithmetic: `${monthlyTransactions} txn/month x ${retryRatePercent}% retried `
      + `x Rs ${averageOrderValueRupees} credited twice = Rs ${Math.round(perMonth)}/month`,
    affectedPerMonth: Math.round(affected),
    perMonthRupees: Math.round(perMonth),
    perYearRupees: Math.round(perMonth * 12),
    basis: 'One duplicate credit per retried transaction — the second delivery is the one '
      + 'that is certain. A ladder that runs further costs more than this.',
    caveat: 'Arithmetic on the retry rate you supplied. Raze measures your real rate from '
      + 'your own traffic once it is running; until then this is your estimate, not a '
      + 'measurement.',
  };
}

async function computeImpact({ pool, razorpay, results, table, volume,
  keyColumn, amountColumn }) {
  const probes = fromProbes(results);
  const live = await fromRazorpay({ pool, razorpay, table, keyColumn, amountColumn });
  const expectations = await abandonment(pool);

  const examined = (results || []).length;
  const failed = (results || []).filter((r) => !r.pass).length;
  const defectRate = examined ? failed / examined : 0;

  const atRiskPaise = probes.phantomCreditPaise
    + (live.available ? live.unrecordedPaise : 0);

  return {
    measured: {
      probesRun: examined,
      probesFailed: failed,
      failedNames: probes.failed,
      phantomCreditPaise: probes.phantomCreditPaise,
      phantomCreditRupees: RUPEES(probes.phantomCreditPaise),
      corruptedOrders: probes.corruptedOrders,
      atRiskPaise,
      atRiskRupees: RUPEES(atRiskPaise),
      source: 'probes fired at the running merchant; state read from its own table',
    },
    razorpay: live,
    expectations,
    endpoint: endpointRisk(probes.failed),
    projection: project({
      monthlyTransactions: volume && volume.monthlyTransactions,
      averageOrderValueRupees: volume && volume.averageOrderValueRupees,
      retryRatePercent: volume && volume.retryRatePercent,
      defects: probes.failed,
    }),
    defectRate,
  };
}

module.exports = { computeImpact, MEASURED, RUPEES };
