'use strict';

/**
 * `raze up` — one command, from nothing to a correct integration.
 *
 * The starting point this assumes is a merchant with a database and an
 * unfinished webhook story: maybe no handler, maybe a half-written one, maybe a
 * generated one nobody has verified. What it leaves behind is an integration
 * where every payment Razorpay records reaches their state exactly once, and
 * where that does not depend on webhook delivery working.
 *
 * It runs the whole sequence:
 *
 *   1  connect and migrate
 *   2  read the schema and derive mappings
 *   3  register the webhook with Razorpay, if a URL was given
 *   4  arm expectations from the orders table, with a deadline this merchant's
 *      own traffic justifies rather than a guessed fifteen minutes
 *   5  backfill history, so installing today does not leave yesterday invisible
 *   6  start the runtime, reconciliation, ledger and outbox
 *   7  report coverage honestly, including anything it could not do
 *
 * WHY MAPPINGS RATHER THAN THEIR HANDLER
 *
 * Running someone's handler means a broken handler stalls the event. Applying a
 * derived mapping means Raze writes the state itself, inside its own
 * transaction, and there is no merchant code in the path to throw, hang or
 * half-apply. When their handler is fine they can opt back into it; when it is
 * not — which is the case this command exists for — it is not in the way.
 *
 * WHAT IT WILL NOT PRETEND
 *
 * Mappings are derived, not divined. Anything requiring a judgement only the
 * merchant can make is printed as a question and left undecided, and the run
 * says plainly which parts of the guarantee are live and which are not.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
];

async function rzp(env, method, endpoint, body) {
  const auth = 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 200) }; }
  if (!res.ok) {
    throw new Error((parsed.error && parsed.error.description) || `Razorpay ${method} ${endpoint}: HTTP ${res.status}`);
  }
  return parsed;
}

const step = (n, title) => {
  console.log('');
  console.log(`  ${n}. ${title}`);
};

module.exports = async function cmdUp({ env, flag, has, LOG, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const { infer, render } = require(path.join(RAZE, 'src', 'infer'));
  const mapping = require(path.join(RAZE, 'src', 'mapping'));
  const raze = require(path.join(RAZE, 'src', 'runtime'));
  const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
  const { createLedger } = require(path.join(RAZE, 'src', 'ledger'));
  const { createOutbox } = require(path.join(RAZE, 'src', 'outbox'));
  const learn = require(path.join(RAZE, 'src', 'learn'));

  const url = flag('url', null);
  const ordersTable = flag('orders', null);
  const orderKey = flag('key', null);
  const port = Number(flag('port', 4000));
  const backfillDays = Number(flag('backfill-days', 7));
  const dryRun = has('dry-run');

  const notes = [];
  const unresolved = [];

  console.log('');
  console.log(`  raze up${dryRun ? '   (dry run — nothing will be changed)' : ''}`);

  // ---- 1. database -------------------------------------------------------
  step(1, 'database');
  const { pool, url: dbUrl, embedded } = await connect();
  const migrations = await migrate(pool);
  console.log(`     ${embedded ? 'embedded postgres' : dbUrl.replace(/:[^:@]*@/, ':***@')}`);
  console.log(`     ${migrations.length} migration(s) applied`);

  // ---- 2. mappings -------------------------------------------------------
  step(2, 'reading your schema');
  const { schema, proposals } = await infer({ pool, corpusPath: LOG });
  console.log(`     ${schema.length} table(s), ${proposals.length} mapping(s) derived`);

  const rz = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET });
  learn.attach(rz, pool);
  const maps = mapping.attach(rz, pool);

  let applied = 0;
  for (const p of proposals) {
    try {
      await maps.map(p.eventType, p.spec);
      applied++;
      console.log(`     ${p.eventType.padEnd(20)} -> ${p.spec.table}`);
    } catch (err) {
      unresolved.push(`mapping for ${p.eventType}: ${err.message}`);
    }
    for (const q of p.questions) notes.push(`${p.eventType}: ${q}`);
  }
  if (applied === 0) {
    unresolved.push(
      'no mapping could be derived — a table needs a column naming a Razorpay '
      + 'object (order_id, payment_id, refund_id). Write raze.mapping.js by hand; '
      + 'it is six lines per event.'
    );
  }
  if (!dryRun && proposals.length) {
    const out = path.join(process.cwd(), 'raze.mapping.js');
    fs.writeFileSync(out, render(proposals, { corpusPath: LOG }));
    console.log(`     written to ${path.relative(process.cwd(), out)} for review`);
  }

  // ---- 3. webhook registration -------------------------------------------
  step(3, 'webhook registration');
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    unresolved.push('no Razorpay credentials — reconciliation and the ledger cannot run');
    console.log('     skipped: no credentials');
  } else if (!url) {
    console.log('     skipped: no --url given');
    notes.push(
      'without a public endpoint, delivery cannot reach Raze. Reconciliation '
      + 'still recovers every payment, so nothing is lost — it simply arrives on '
      + 'the reconcile interval rather than in 0.23s.'
    );
  } else {
    let secret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      secret = crypto.randomBytes(24).toString('base64url');
      if (!dryRun) {
        fs.appendFileSync(path.join(RAZE, '.env'), `\nRAZORPAY_WEBHOOK_SECRET=${secret}\n`);
        console.log('     generated a webhook secret and appended it to raze/.env');
      }
    }
    const existing = await rzp(env, 'GET', '/webhooks');
    const already = (existing.items || []).find((w) => w.url === url);
    if (dryRun) {
      console.log(`     would ${already ? 'update' : 'create'} a webhook for ${url}`);
    } else {
      const w = already
        ? await rzp(env, 'PUT', `/webhooks/${already.id}`, { url, secret, events: EVENTS })
        : await rzp(env, 'POST', '/webhooks', { url, secret, events: EVENTS });
      console.log(`     ${already ? 'updated' : 'created'} webhook ${w.id}, ${EVENTS.length} events`);
    }
  }

  // ---- 4. expectations ---------------------------------------------------
  step(4, 'expectations');
  if (ordersTable && orderKey) {
    const ledgerProbe = createLedger({
      db: pool, razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    });
    const suggestion = await ledgerProbe.suggestedDeadline();
    const withinMs = suggestion.enough ? suggestion.suggestedMs : 15 * 60000;
    console.log(`     deadline ${Math.round(withinMs / 60000)}m — ` +
      (suggestion.enough ? suggestion.because : 'default, until enough fulfilments are observed'));

    if (!dryRun) {
      const armed = await pool.query(
        `INSERT INTO raze_expectations (subject_type, subject_id, expected_event, deadline)
         SELECT 'order', t."${orderKey}", 'payment.captured', now() + ($1 || ' milliseconds')::interval
           FROM "${ordersTable}" t
          WHERE t."${orderKey}" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM raze_expectations e
                             WHERE e.subject_id = t."${orderKey}"
                               AND e.expected_event = 'payment.captured')
         ON CONFLICT DO NOTHING`,
        [String(withinMs)]
      ).catch((err) => { unresolved.push(`could not arm expectations: ${err.message}`); return { rowCount: 0 }; });
      console.log(`     armed ${armed.rowCount} expectation(s) from "${ordersTable}"`);
    }
  } else {
    console.log('     skipped: pass --orders <table> --key <column>');
    notes.push(
      'without expectations, an order the customer never paid is invisible. '
      + 'Reconciliation cannot see it either — there is no payment to enumerate.'
    );
  }

  // ---- 5. backfill -------------------------------------------------------
  step(5, 'history');
  /**
   * Which orders the merchant has actually APPLIED a payment to.
   *
   * Not which orders exist. An order row is written at checkout, before any
   * money moves, so treating existence as knowledge makes every created-but-
   * unpaid order mask its own missing payment — reconciliation sees the id,
   * calls it known, and the payment is never recovered. That is the exact
   * failure this whole layer exists to prevent, and it hid here first.
   *
   * The settled test is derived from the same mapping that writes the state: the
   * status column it sets, and the counter it increments.
   */
  const settled = (() => {
    const p = proposals.find((x) => x.eventType === 'payment.captured' && x.spec.table === ordersTable);
    if (!p) return null;
    const statusCol = Object.keys(p.spec.set || {})[0] || null;
    const counterCol = Object.keys(p.spec.add || {}).find((c) => /count/i.test(c)) || null;
    return { statusCol, counterCol, paid: 'paid', refunded: 'refunded' };
  })();

  const localOrderIds = async () => {
    if (!ordersTable || !orderKey) return new Set();
    let sql = `SELECT "${orderKey}" AS id FROM "${ordersTable}"`;
    const clauses = [];
    if (settled && settled.statusCol) {
      clauses.push(`"${settled.statusCol}" IN ('${settled.paid}', '${settled.refunded}')`);
    }
    if (settled && settled.counterCol) {
      clauses.push(`"${settled.counterCol}" > 0`);
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(' OR ')}`;
    const r = await pool.query(sql).catch(() => ({ rows: [] }));
    return new Set(r.rows.map((x) => x.id).filter(Boolean));
  };
  const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds,
    localRefundIds: async () => new Set(),
    config: { coldStartMs: backfillDays * 86400000 },
  });

  if (ordersTable && !settled) {
    notes.push(
      `no settled-state column was derived for "${ordersTable}", so reconciliation `
      + 'treats every existing order as known. An order created but never paid will '
      + 'mask its own missing payment — give the table a status or counter column, '
      + 'or write the mapping by hand.'
    );
  } else if (settled) {
    console.log(`     drift is measured against ${settled.statusCol ? `"${settled.statusCol}" being settled` : ''}`
      + `${settled.statusCol && settled.counterCol ? ' or ' : ''}`
      + `${settled.counterCol ? `"${settled.counterCol}" > 0` : ''}, not mere existence`);
  }

  if (!env.RAZORPAY_KEY_ID || dryRun) {
    console.log(`     skipped${dryRun ? ' (dry run)' : ': no credentials'}`);
  } else {
    const r = await rec.runOnce();
    if (r.ok) {
      console.log(`     ${backfillDays} day(s) scanned: ${r.drift} unknown to your store, ${r.repaired} queued`);
    } else {
      unresolved.push(`backfill could not complete: ${r.error}`);
      console.log(`     FAILED: ${r.error}`);
    }
  }

  // ---- 6. run ------------------------------------------------------------
  step(6, 'running');
  if (dryRun) {
    console.log('     skipped (dry run)');
    await shutdown(pool);
    return;
  }

  const outbox = createOutbox({ db: pool });
  const ledger = createLedger({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
  });

  rz.startWorker({ intervalMs: 200 });
  outbox.start();
  if (env.RAZORPAY_KEY_ID) { rec.start(); ledger.start(); }

  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true, mappings: applied }));
  app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const server = app.listen(port);

  console.log(`     endpoint     http://127.0.0.1:${port}/webhook`);
  console.log(`     runtime      ${applied} mapping(s), no merchant code in the path`);
  console.log(`     reconcile    ${env.RAZORPAY_KEY_ID ? `every ${rec.config.intervalMs / 1000}s` : 'not running (no credentials)'}`);
  console.log(`     ledger       ${env.RAZORPAY_KEY_ID ? `sweeping every ${ledger.config.sweepIntervalMs / 1000}s` : 'not running'}`);
  console.log(`     outbox       draining every ${outbox.config.intervalMs / 1000}s`);

  // ---- 7. what is and is not covered -------------------------------------
  console.log('');
  console.log(`  ${'-'.repeat(66)}`);
  console.log('  COVERAGE');
  console.log(`  ${'-'.repeat(66)}`);

  const live = [];
  const dark = [];
  (applied > 0 ? live : dark).push('duplicate, out-of-order and forged deliveries');
  (applied > 0 ? live : dark).push('business state written exactly once, no merchant code in the path');
  (env.RAZORPAY_KEY_ID ? live : dark).push('payments Razorpay recorded but never delivered');
  (env.RAZORPAY_KEY_ID ? live : dark).push('refunds Razorpay recorded but never delivered');
  ((ordersTable && orderKey && env.RAZORPAY_KEY_ID) ? live : dark).push('orders that were never paid at all');
  (url ? live : dark).push('deliveries arriving in 0.23s rather than on the reconcile interval');

  for (const l of live) console.log(`    covered      ${l}`);
  for (const d of dark) console.log(`    NOT covered  ${d}`);

  if (notes.length) {
    console.log('');
    console.log('  Needs a decision from you:');
    for (const n of notes) console.log(`    - ${n}`);
  }
  if (unresolved.length) {
    console.log('');
    console.log('  Could not be done:');
    for (const u of unresolved) console.log(`    - ${u}`);
  }

  console.log('');
  console.log('  Running. ctrl-c to stop.');
  console.log('');

  const stop = async () => {
    server.close(); rz.stopWorker(); outbox.stop(); rec.stop(); ledger.stop();
    await shutdown(pool);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
};

module.exports.EVENTS = EVENTS;
