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
  // The targeted check. More often than reconciliation because it is one
  // request per open order and it is the one that catches a fresh payment.
  pollMs: 20 * 1000,
  overlapMs: 5 * 60 * 1000,
};

function createLoops({ pool, razorpay, config = {}, merchant = {}, columns, ordersTable,
  logFile, mappingSpec = null, onEvent = () => {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
  const { createLedger } = require(path.join(RAZE, 'src', 'ledger'));

  let reconcileTimer = null;
  let lastTickAt = null;
  let pollTimer = null;
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

    // A mapping the merchant stated outranks anything inferred. On a schema whose
    // column names are the author's own, inference finds the key by reading the
    // data but cannot tell a status column from a money column — it declines,
    // and the merchant's own answer is the only thing that can fill the gap.
    let base = mappingSpec;
    if (!base) {
      const { proposals } = await infer.infer({ pool, corpusPath: logFile });
      const found = proposals.find(
        (p) => p.eventType === 'payment.captured' && p.spec.table === ordersTable);
      if (!found) {
        return {
          applied: false,
          reason: `nothing here can say how to write "${ordersTable}" from a captured `
            + 'payment. Confirm the mapping and Raze will use it.',
        };
      }
      base = found.spec;
    }

    // Two corrections the merchant's configuration implies but inference cannot
    // know on its own.
    const spec = JSON.parse(JSON.stringify(base));

    // 1. Never write the column the amount is checked against.
    //
    // Inference sees two integer columns and cannot tell "what this order should
    // cost" from "what we have credited so far". If it picks the first, every
    // repair inflates the expected amount — corrupting the exact figure the
    // policy compares against, so the next check passes for the wrong reason.
    if (cols.expected && spec.add && spec.add[cols.expected] !== undefined) {
      delete spec.add[cols.expected];
      if (cols.amount && cols.amount !== cols.expected) {
        spec.add[cols.amount] = 'payload.payment.entity.amount';
      }
    }

    // 2. A repair never creates an order.
    //
    // The policy already refuses a payment with no matching order; the mapping
    // has to agree, or a drain of unrelated queued events would invent rows for
    // orders this merchant never had.
    spec.insertIfMissing = false;

    const rz = raze.create({ db: pool, webhookSecret: resolveDemoSecret(process.env).secret });
    const m = mapping.attach(rz, pool);
    await m.map('payment.captured', spec);
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

    const attempt = await applyThroughHandler(payment, orderId);

    // Read the merchant's own table back. This is the only evidence.
    const after = await readOrder(orderId);
    const landed = after.order && Number(after.order.appliedAmount) > 0;
    await actions.record(pool, {
      kind: landed ? 'recovered' : 'escalated',
      orderId,
      paymentId: payment.id,
      amountPaise: payment.amount,
      rule: landed ? verdict.rule : 'write-did-not-land',
      // A failure that says nothing is worse than no message at all — it was
      // being reported to the merchant as a blank line.
      why: landed ? verdict.why
        : (attempt && attempt.reason)
          || 'The repair was queued and processed, but your order still does not show the '
             + 'payment. Something about the mapping does not fit this table.',
      verifiedState: after.order,
    });
    onEvent({
      type: landed ? 'recovered' : 'escalated',
      orderId,
      amount: payment.amount,
      why: landed ? verdict.why : (attempt && attempt.reason) || 'the write did not land',
    });
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

  /**
   * Ask about the orders the merchant is actually waiting on.
   *
   * Reconciliation enumerates: it asks Razorpay for the payments it has and
   * compares. That is the right shape for finding drift across an account, and
   * it has one blind spot that turns out to matter more than any of them —
   * Razorpay's list endpoints lag. Measured on this account: a payment captured
   * and confirmed by GET /v1/orders/{id}/payments was still absent from
   * GET /v1/payments, while the list happily returned records from the previous
   * day. A merchant watching their own order sees nothing happen for as long as
   * that lasts, which is precisely the window Raze exists to close.
   *
   * So this goes the other way round. It starts from the merchant's unpaid
   * orders — the rows they are waiting on — and asks Razorpay about each one
   * directly. Targeted reads do not lag: the payment is there the moment it is
   * captured.
   *
   * It is bounded on purpose. Only orders that carry a gateway id, only the
   * most recent ones, and each one costs a single request — so this stays a
   * small, predictable amount of traffic no matter how large the order book is.
   * Everything it finds goes through the same policy and the same write as any
   * other route; nothing here is a shortcut past the checks.
   */
  async function pollOpenOrders(limit = 25) {
    const auth = 'Basic ' + Buffer.from(
      `${razorpay.keyId}:${razorpay.keySecret}`).toString('base64');

    const open = await pool.query(
      `SELECT "${cols.key}" AS id
         FROM "${ordersTable}"
        WHERE "${cols.key}" IS NOT NULL
          AND coalesce("${cols.amount}", 0) = 0
        ORDER BY 1 DESC
        LIMIT ${Number(limit)}`);

    let checked = 0;
    let found = 0;
    const seen = [];
    const outcomes = [];
    for (const row of open.rows) {
      checked++;
      seen.push(row.id);
      try {
        // Ask the order, not the list of payments hanging off it.
        //
        // Both were tried. The payments sub-resource returned an empty list to
        // this process for the same order that returned a captured payment to a
        // freshly started one, minutes apart, on the same credentials — a stale
        // answer served to a long-lived connection. Whatever the cause, the
        // order resource is the better question anyway: "has this order been
        // paid" is a property of the order, and Razorpay answers it with
        // status and amount_paid.
        //
        // No-store is set because this is the one call that must never be
        // answered from anything but the current state.
        const ask = (url) => fetch(url, {
          headers: { authorization: auth, 'cache-control': 'no-cache', pragma: 'no-cache' },
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });

        const r = await ask(`https://api.razorpay.com/v1/orders/${encodeURIComponent(row.id)}`);
        if (!r.ok) { outcomes.push({ id: row.id, status: r.status }); continue; }
        const order = await r.json();
        if (order.status !== 'paid' || !Number(order.amount_paid)) {
          outcomes.push({ id: row.id, saw: order.status, attempts: order.attempts });
          continue;
        }

        // The order says it is paid. Name the payment if Razorpay will say which
        // one; if it will not, the repair still goes ahead on the order's own
        // word, labelled so the record shows where the figure came from. What
        // must never happen is refusing to fix a paid order because a secondary
        // endpoint was slow.
        let payment = null;
        try {
          const p = await ask(
            `https://api.razorpay.com/v1/orders/${encodeURIComponent(row.id)}/payments`);
          if (p.ok) {
            const body = await p.json();
            payment = (body.items || []).find((x) => x.status === 'captured') || null;
          }
        } catch { /* the order's own word is enough */ }

        found++;
        const verdict = await handleDrift({
          id: payment ? payment.id : `orderpaid_${order.id}`,
          order_id: row.id,
          amount: payment ? payment.amount : Number(order.amount_paid),
          status: 'captured',
        });
        outcomes.push({ id: row.id, payment: payment ? payment.id : '(named by order)', verdict });
      } catch (err) {
        outcomes.push({ id: row.id, error: err.message });
        onEvent({ type: 'error', where: 'pollOpenOrders', error: err.message });
      }
    }
    onEvent({ type: 'polled', checked, found });
    return { checked, found, seen, outcomes };
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
      // Every completed pass stamps the clock. "Running" is a flag this object
      // sets about itself and will keep reporting long after its work has
      // stopped happening; the stamp is the only claim that can be checked from
      // outside, and a console saying "watching your payments" needs to be able
      // to check it.
      // Every pass leaves a row, whether or not it found anything.
      //
      // Three fixes were made from reading logs and none of them worked, because
      // the absence of a log line is not evidence — a log tail can be stale, and
      // an interval that never fires produces exactly the same silence as an
      // interval whose work found nothing. This makes the difference visible:
      // a row per tick, in the merchant's own database, with a timestamp.
      //
      // If these rows stop appearing between deploys, the loops are dead and
      // every theory about Razorpay was wrong.
      await pool.query(`CREATE TABLE IF NOT EXISTS raze_heartbeat (
        id      BIGSERIAL PRIMARY KEY,
        at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind    TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ms      INT,
        detail  TEXT)`).catch(() => {});

      const tick = async (fn, where) => {
        const began = Date.now();
        let outcome = 'ok';
        let detail = null;
        try {
          const result = await fn();
          lastTickAt = Date.now();
          detail = result ? JSON.stringify(result).slice(0, 400) : null;
        } catch (err) {
          outcome = 'error';
          detail = err.message;
          onEvent({ type: 'error', where, error: err.message });
        }
        try {
          await pool.query(
            `INSERT INTO raze_heartbeat (kind, outcome, ms, detail) VALUES ($1,$2,$3,$4)`,
            [where, outcome, Date.now() - began, detail]);
          // Keep it small; this is a pulse, not an archive.
          await pool.query(
            `DELETE FROM raze_heartbeat WHERE at < now() - interval '2 hours'`);
        } catch { /* a heartbeat that cannot be written is not worth crashing for */ }
      };
      // Run both immediately so a merchant who just finished setup sees a real
      // number rather than waiting a minute for the first tick.
      await tick(reconcileOnce, 'reconcile');
      await tick(pollOpenOrders, 'poll');
      await tick(sweepOnce, 'sweep');
      reconcileTimer = setInterval(() => tick(reconcileOnce, 'reconcile'), cfg.reconcileMs);

      // On its own timer, deliberately.
      //
      // These were chained — reconcile, then poll, on one beat — and the chain
      // put the fast check behind the slow one. Reconciliation enumerates
      // Razorpay's payment list; that list is the thing that lags, and while it
      // was hanging the poll behind it never ran at all. A payment sat captured
      // and unrepaired while the loop looked perfectly healthy, because the half
      // that was working kept stamping the clock.
      //
      // They answer different questions and neither should be able to stop the
      // other: one asks Razorpay what it has, the other asks about the orders
      // this merchant is still waiting on. The second is the one that catches a
      // payment the list has not caught up with, so it runs more often and
      // depends on nothing.
      pollTimer = setInterval(() => tick(pollOpenOrders, 'poll'), cfg.pollMs);
      sweepTimer = setInterval(() => tick(sweepOnce, 'sweep'), cfg.sweepMs);
      onEvent({ type: 'started', reconcileMs: cfg.reconcileMs, sweepMs: cfg.sweepMs });
    },
    stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      reconcileTimer = pollTimer = sweepTimer = null;
      running = false;
    },
    get running() { return running; },
    // When a pass last finished, so a caller can tell a loop that is working
    // from one that merely says it is.
    get lastTickAt() { return lastTickAt; },
    reconcileOnce,
    pollOpenOrders,
    sweepOnce,
    handleDrift,
    config: cfg,
  };
}

module.exports = { createLoops, DEFAULTS };
