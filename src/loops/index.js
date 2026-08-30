'use strict';

/**
 * Raze running by itself.
 *
 * Two loops, started once setup completes, independent of whether anyone has the
 * console open. A merchant asleep at 3am is exactly when this has to work.
 *
 *   reconcile   every 60s   ask Razorpay what it recorded, compare, act
 *   sweep       every 30s   resolve deadlines that have passed
 *
 * WHAT MAKES THIS SAFE TO LEAVE RUNNING
 *
 * The policy engine decides, not this file and not a model. Everything here does
 * is gather facts, hand them to `policy.decide`, and carry out the verdict. If
 * the verdict is escalate, nothing is written and the merchant is told why.
 *
 * WHAT MAKES IT HONEST
 *
 * A repair is not reported until it has been read back out of the merchant's own
 * table. An exception not being thrown proves nothing, and the inbox accepting a
 * row proves a row exists — not that the money landed where the merchant can see
 * it. Verification is a separate read, after the fact, every time.
 */

const path = require('path');

const RAZE = path.join(__dirname, '..', '..');
const policy = require(path.join(RAZE, 'src', 'policy'));
const actions = require(path.join(RAZE, 'src', 'actions'));

const DEFAULTS = {
  reconcileMs: 60 * 1000,
  sweepMs: 30 * 1000,
  overlapMs: 5 * 60 * 1000,
};

function createLoops({ pool, razorpay, config = {}, merchant = {}, columns, ordersTable,
  logFile, onEvent = () => {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
  const { createLedger } = require(path.join(RAZE, 'src', 'ledger'));

  let reconcileTimer = null;
  let sweepTimer = null;
  let running = false;

  const cols = columns || { key: 'order_id', status: 'status', amount: 'credited_paise',
    expected: null };

  /** The merchant's row, in the shape the policy expects. */
  async function readOrder(orderId) {
    const select = [`"${cols.status}" AS status`, `"${cols.amount}" AS applied`];
    if (cols.expected) select.push(`"${cols.expected}" AS expected`);
    const r = await pool.query(
      `SELECT ${select.join(', ')} FROM "${ordersTable}" WHERE "${cols.key}" = $1`,
      [orderId]);
    return {
      matchedRows: r.rowCount,
      order: r.rows[0] ? {
        status: r.rows[0].status,
        appliedAmount: Number(r.rows[0].applied || 0),
        // No column for it means it cannot be checked, and the policy treats
        // that as a reason to stop rather than a check to skip.
        expectedAmount: cols.expected && r.rows[0].expected !== null
          ? Number(r.rows[0].expected) : null,
      } : null,
    };
  }

  /**
   * Put a payment through the same path a live delivery takes.
   *
   * Deliberately not an UPDATE. The mapping, the state machine and the guards
   * are what make the write correct, and a repair that skips them is a different
   * operation wearing the same name.
   */
  async function applyThroughHandler(payment, orderId) {
    const crypto = require('crypto');
    const raze = require(path.join(RAZE, 'src', 'runtime'));
    const mapping = require(path.join(RAZE, 'src', 'mapping'));
    const infer = require(path.join(RAZE, 'src', 'infer'));
    const { resolveDemoSecret } = require(path.join(RAZE, 'src', 'secret'));

    const event = {
      event: 'payment.captured',
      _raze_synthetic: true,
      _raze_note: 'reconstructed from the Razorpay API by unattended recovery',
      payload: { payment: { entity: { ...payment, order_id: orderId } } },
    };
    const raw = Buffer.from(JSON.stringify(event), 'utf8');
    await pool.query(
      `INSERT INTO raze_inbox
         (event_id, event_type, raw_body, raw_body_sha256, signature, headers, subject_id, source)
       VALUES ($1,'payment.captured',$2,$3,NULL,'{}'::jsonb,$4,'auto-recovery')
       ON CONFLICT (event_id) DO NOTHING`,
      ['recon_' + payment.id, raw,
        crypto.createHash('sha256').update(raw).digest('hex'), orderId]);

    const { proposals } = await infer.infer({ pool, corpusPath: logFile });
    const spec = proposals.find(
      (p) => p.eventType === 'payment.captured' && p.spec.table === ordersTable);
    if (!spec) return { applied: false, reason: 'no mapping for ' + ordersTable };

    const rz = raze.create({ db: pool, webhookSecret: resolveDemoSecret(process.env).secret });
    const m = mapping.attach(rz, pool);
    await m.map('payment.captured', spec.spec);
    await rz.drain();
    return { applied: true };
  }

  /** One payment, from facts to verdict to outcome. */
  async function handleDrift(payment) {
    const orderId = payment.order_id;
    const { order, matchedRows } = await readOrder(orderId);
    const verdict = policy.decide({ payment, order, matchedRows, merchant });

    if (verdict.action === 'escalate') {
      // Only record it once. An escalation repeating every 60s is noise, and
      // noise is how a merchant learns to ignore the thing that matters.
      const existing = await pool.query(
        `SELECT 1 FROM raze_actions
          WHERE kind='escalated' AND order_id=$1 AND NOT acknowledged LIMIT 1`, [orderId]);
      if (existing.rowCount === 0) {
        await actions.record(pool, {
          kind: 'escalated', orderId, paymentId: payment.id, amountPaise: payment.amount,
          rule: verdict.rule, why: verdict.why,
        });
        onEvent({ type: 'escalated', orderId, amount: payment.amount, why: verdict.why });
      }
      return { action: 'escalate', rule: verdict.rule };
    }

    await applyThroughHandler(payment, orderId);

    // Read the merchant's own table back. This is the only evidence.
    const after = await readOrder(orderId);
    const landed = after.order && Number(after.order.appliedAmount) > 0;
    await actions.record(pool, {
      kind: landed ? 'recovered' : 'escalated',
      orderId,
      paymentId: payment.id,
      amountPaise: payment.amount,
      rule: landed ? verdict.rule : 'write-did-not-land',
      why: landed ? verdict.why
        : 'The repair was queued and processed, but your order still does not show the '
          + 'payment. Something about the mapping does not fit this table.',
      verifiedState: after.order,
    });
    onEvent({ type: landed ? 'recovered' : 'escalated', orderId, amount: payment.amount });
    return { action: landed ? 'recovered' : 'escalate', rule: verdict.rule };
  }

  async function reconcileOnce() {
    const rec = createReconciler({
      db: pool,
      razorpay,
      localOrderIds: async () => {
        const r = await pool.query(`SELECT "${cols.key}" AS id FROM "${ordersTable}"`);
        return new Set(r.rows.map((x) => x.id));
      },
      config: { coldStartMs: 72 * 3600 * 1000, overlapMs: cfg.overlapMs },
    });
    const out = await rec.runOnce();
    if (!out.ok) {
      onEvent({ type: 'reconcile-failed', error: out.error });
      return out;
    }

    // Drift the reconciler found is now put through policy rather than applied
    // for being present.
    const impact = require(path.join(RAZE, 'src', 'impact'));
    const live = await impact.computeImpact({
      pool, razorpay, results: [], table: ordersTable,
      keyColumn: cols.key, amountColumn: cols.amount,
    });
    if (live.razorpay && live.razorpay.available) {
      for (const p of live.razorpay.unrecorded) {
        try { await handleDrift(p); }
        catch (err) { onEvent({ type: 'error', where: 'handleDrift', error: err.message }); }
      }
    }
    return out;
  }

  async function sweepOnce() {
    const ledger = createLedger({ db: pool, razorpay });
    const out = await ledger.sweepOnce();
    for (const d of out.details || []) {
      if (d.outcome === 'recovered') continue; // the reconcile loop owns repairs
      await actions.record(pool, {
        kind: 'swept',
        orderId: d.subject_id,
        rule: d.outcome,
        why: d.outcome === 'abandoned'
          ? 'Nothing was ever attempted for this order — the customer started checkout and '
            + 'left. Not a delivery problem, and not lost revenue.'
          : d.outcome === 'failed'
            ? 'The customer tried to pay and their bank declined it. There is nothing to '
              + 'recover.'
            : `Could not tell yet: ${d.reason || 'unresolved'}. Left open rather than guessed.`,
      });
    }
    return out;
  }

  return {
    async start() {
      if (running) return;
      running = true;
      await actions.ensure(pool);
      const tick = async (fn, where) => {
        try { await fn(); }
        catch (err) { onEvent({ type: 'error', where, error: err.message }); }
      };
      // Run both immediately so a merchant who just finished setup sees a real
      // number rather than waiting a minute for the first tick.
      await tick(reconcileOnce, 'reconcile');
      await tick(sweepOnce, 'sweep');
      reconcileTimer = setInterval(() => tick(reconcileOnce, 'reconcile'), cfg.reconcileMs);
      sweepTimer = setInterval(() => tick(sweepOnce, 'sweep'), cfg.sweepMs);
      onEvent({ type: 'started', reconcileMs: cfg.reconcileMs, sweepMs: cfg.sweepMs });
    },
    stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      reconcileTimer = sweepTimer = null;
      running = false;
    },
    get running() { return running; },
    reconcileOnce,
    sweepOnce,
    handleDrift,
    config: cfg,
  };
}

module.exports = { createLoops, DEFAULTS };
