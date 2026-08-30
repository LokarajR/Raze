'use strict';

/**
 * `raze backfill` — reconcile history, not just from now on.
 *
 * Reconciliation walks forward from the moment it starts, which leaves an
 * install blind to everything that happened before it. A merchant adopting Raze
 * after a bad week most needs the bad week: the payments that were already lost
 * are the ones worth recovering, and they are invisible to a forward-only scan.
 *
 * This walks a stated range in chunks and feeds anything the merchant does not
 * know about through the ordinary repair path — the same inbox, the same
 * handler or mapping, the same guarantees. Nothing about a backfilled event is
 * special except when it was found.
 *
 * It is safe to run repeatedly. Every insert is deduplicated on the synthetic
 * event id, so a second pass over the same range repairs nothing and changes
 * nothing.
 */

const path = require('path');

function parseWhen(value, fallbackDaysAgo) {
  if (!value) return new Date(Date.now() - fallbackDaysAgo * 86400000);
  const asDate = new Date(String(value));
  if (!Number.isNaN(asDate.getTime())) return asDate;
  const m = String(value).match(/^(\d+)\s*([dhm])$/);
  if (m) {
    const ms = Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
    return new Date(Date.now() - ms);
  }
  throw new Error(`unparseable date: ${value} (use 2026-08-01, or 7d / 12h)`);
}

module.exports = async function cmdBackfill({ env, flag, has, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
  const { MERCHANT_SCHEMA } = require(path.join(RAZE, 'examples', 'demo-merchant', 'server'));

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    console.error('\n  backfill queries the Razorpay API and needs credentials.\n');
    process.exit(1);
  }

  const from = parseWhen(flag('from', null), 30);
  const to = parseWhen(flag('to', null), 0);
  const chunkHours = Number(flag('chunk-hours', 24));
  const dryRun = has('dry-run');

  if (from >= to) {
    console.error(`\n  --from (${from.toISOString()}) must be before --to (${to.toISOString()})\n`);
    process.exit(1);
  }

  const { pool } = await connect();
  await migrate(pool);
  await pool.query(MERCHANT_SCHEMA);

  const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => {
      const r = await pool.query('SELECT order_id FROM shop_orders');
      return new Set(r.rows.map((x) => x.order_id));
    },
    localRefundIds: async () => {
      const r = await pool.query(
        `SELECT DISTINCT substring(resolution_detail->>'payment_id' from 1) AS id
           FROM raze_expectations WHERE resolution_detail ? 'payment_id'`
      ).catch(() => ({ rows: [] }));
      return new Set(r.rows.map((x) => x.id).filter(Boolean));
    },
  });

  const chunkMs = chunkHours * 3600000;
  const chunks = Math.ceil((to.getTime() - from.getTime()) / chunkMs);

  console.log('');
  console.log(`  backfill${dryRun ? '   (dry run — nothing will be repaired)' : ''}`);
  console.log(`    from      ${from.toISOString()}`);
  console.log(`    to        ${to.toISOString()}`);
  console.log(`    chunks    ${chunks} of ${chunkHours}h`);
  console.log('');

  let totalDrift = 0;
  let totalRepaired = 0;
  let failed = 0;

  for (let i = 0; i < chunks; i++) {
    const chunkTo = new Date(Math.min(to.getTime(), from.getTime() + (i + 1) * chunkMs));

    // runOnce derives its own window from the previous watermark, so the chunk
    // is expressed by pinning "now" and asking for exactly this span.
    const r = await rec.runOnce({ now: chunkTo.getTime() + rec.config.settleMs });

    const label = `${chunkTo.toISOString().slice(0, 16)}`;
    if (!r.ok) {
      failed++;
      console.log(`    ${label}   FAILED  ${r.error}`);
      continue;
    }
    totalDrift += r.drift;
    totalRepaired += r.repaired;
    const refunds = r.refunds && r.refunds.checked === false ? ' (refunds unchecked)' : '';
    console.log(`    ${label}   ${String(r.drift).padStart(3)} drifted, ${String(r.repaired).padStart(3)} queued${refunds}`);
  }

  console.log('');
  console.log(`    ${totalDrift} payment(s)/refund(s) the local store did not know about`);
  console.log(`    ${totalRepaired} queued for repair through the normal handler path`);
  if (failed) {
    console.log(`    ${failed} chunk(s) could not be covered — rerun to cover them`);
  }
  console.log('');
  console.log('    Nothing has been applied yet: repaired events go through the same');
  console.log('    inbox, handler and transaction as a delivered webhook. Run');
  console.log('    raze protect, or drain once, to apply them.');
  console.log('');

  await shutdown(pool);
  process.exit(failed ? 1 : 0);
};
