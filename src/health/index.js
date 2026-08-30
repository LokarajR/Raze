'use strict';

/**
 * Is this merchant's payment handling actually correct, right now?
 *
 * Seven claims, each answered by something that ran: a real captured Razorpay
 * delivery fired at the endpoint, or a real query against Razorpay and the
 * merchant's own tables. Nothing here checks configuration. A tick that meant
 * "a library is installed" would be worth nothing, because every defect this
 * project exists to catch lives in code that was installed correctly.
 *
 * Shared by the console and the MCP server so a merchant and an agent are never
 * told different things about the same system.
 */

const path = require('path');

const RAZE = path.join(__dirname, '..', '..');

async function computeHealth({ pool, razorpay, targetUrl, webhookSecret, logFile, ordersTable = 'shop_orders' }) {
  const { createAuditor } = require(path.join(RAZE, 'src', 'audit'));
  const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));

  // Read before the probes run. They clear every table in the schema between
  // rounds — expectations included — so a count taken afterwards is always zero.
  let absenceOk = false;
  let absenceWhy = 'no expectations armed';
  try {
    const r = await pool.query('SELECT count(*)::int n FROM raze_expectations');
    const n = r.rows[0].n;
    absenceOk = n > 0;
    absenceWhy = n > 0
      ? `${n} order(s) watched; an overdue one resolves to recovered, failed or abandoned`
      : 'installed, but no order is being watched — nothing would notice a payment that '
        + 'never arrives';
  } catch (err) { absenceWhy = 'raze_expectations unreadable: ' + err.message; }

  const auditor = createAuditor({ targetUrl, pool, logFile, webhookSecret });
  const results = await auditor.run();
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  const probe = (name) => by[name] || null;
  const probeCheck = (label, name, extra) => {
    const p = probe(name);
    return {
      name: label,
      ok: !!(p && p.pass && !p.skipped && (extra ? extra(p) : true)),
      detail: p ? p.observed : 'not run',
    };
  };

  let reconcileOk = false;
  let reconcileWhy = 'no Razorpay credentials configured';
  if (razorpay && razorpay.keyId && razorpay.keySecret) {
    try {
      const rec = createReconciler({
        db: pool,
        razorpay,
        localOrderIds: async () => {
          const r = await pool.query(`SELECT order_id FROM "${ordersTable}"`);
          return new Set(r.rows.map((x) => x.order_id));
        },
        config: { coldStartMs: 72 * 3600 * 1000 },
      });
      const out = await rec.runOnce();
      reconcileOk = !!out.ok;
      reconcileWhy = out.ok
        ? `asked Razorpay directly; ${out.drift} drifted, ${out.payments.repaired} repaired`
        : out.error;
    } catch (err) { reconcileWhy = err.message; }
  }

  const checks = [
    probeCheck('Signature verification', 'tampered-signature'),
    probeCheck('Duplicate-safe processing', 'duplicate-delivery'),
    probeCheck('Retry-safe processing', 'timeout-retry'),
    probeCheck('State transition protection', 'out-of-order'),
    probeCheck('Refund handling', 'refund-event'),
    { name: 'Reconciliation active', ok: reconcileOk, detail: reconcileWhy },
    { name: 'Missing-payment detection', ok: absenceOk, detail: absenceWhy },
  ];

  const isProtected = checks.every((c) => c.ok);
  return {
    checks,
    protected: isProtected,
    verdict: isProtected ? 'PROTECTED' : 'NOT PROTECTED',
    failing: checks.filter((c) => !c.ok).map((c) => c.name),
    note: isProtected
      ? 'Every check above is the outcome of a real delivery or a real query, not a '
        + 'configuration check.'
      : 'A failing check is a real failure against real deliveries, not a warning.',
  };
}

module.exports = { computeHealth };
