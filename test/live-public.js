#!/usr/bin/env node
'use strict';

/**
 * Run real published Razorpay handlers live, with and without Raze.
 *
 * Static pattern recognition says what a file looks like. This runs the code:
 * each handler is mounted with the datastore it expects, the genuine 16-attempt
 * retry ladder is replayed at it, and its own database is read afterwards.
 *
 * Nothing is vendored. The repositories are cloned at run time and their code is
 * used unmodified — the only accommodation is resolving their npm dependencies
 * from this package, which avoids installing inside someone else's tree and
 * changes none of their logic.
 *
 * WHAT "WITH RAZE" MEANS HERE
 *
 * The same handler, unedited, behind the Raze runtime. Raze does not repair a
 * broken handler and never claims to. What changes is that the delivery is
 * verified, deduplicated and durably recorded before their code runs, so a
 * failure is visible and the event survives to be retried or reconciled instead
 * of being acknowledged and lost.
 *
 *   node test/live-public.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');

const RAZE = path.join(__dirname, '..');
const CACHE = path.join(RAZE, '.public-merchants');
const CORPUS = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = (n = 72) => '='.repeat(n);

/** Resolve their requires from our node_modules rather than installing in their tree. */
function shareModules() {
  const Module = require('module');
  const original = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from) {
    return original.call(this, from).concat(path.join(RAZE, 'node_modules'));
  };
}

/** The real ladder Razorpay sent for one captured event. */
function ladder(eventType) {
  const rows = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64 || r.event_type !== eventType) continue;
    const k = `${r.event_id}|${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  let best = null;
  for (const v of byKey.values()) {
    v.sort((a, b) => a.received_at_ms - b.received_at_ms);
    if (!best || v.length > best.length) best = v;
  }
  return best.map((d) => ({
    body: Buffer.from(d.raw_body_b64, 'base64'),
    eventId: d.event_id,
    signature: d.signature,
    at: d.received_at_iso,
  }));
}

async function post(url, f) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': f.eventId,
        'x-razorpay-signature': f.signature,
      },
      body: f.body,
      signal: AbortSignal.timeout(8000),
    });
    await res.text();
    return res.status;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The subjects. Each says how to mount its own handler and read its own state.
// ---------------------------------------------------------------------------
const SUBJECTS = [
  {
    repo: 'neharahman-razorpay-webhook',
    label: 'neharahman/razorpay-webhook',
    eventType: 'payment.authorized',
    async setup(root, event) {
      const model = require(path.join(root, 'models', 'payment'));
      const controller = require(path.join(root, 'controllers', 'paymentGateway'));
      const orderId = event.payload.payment.entity.order_id;
      return {
        handler: (req, res) => controller.paymentSuccess(req, res),
        parseBody: true,
        async seed() {
          await model.deleteMany({});
          await new model({ _id: orderId }).save();
        },
        async read() {
          const doc = await model.findById(orderId).lean();
          return { recorded: !!(doc && doc.flag), detail: doc ? `flag=${!!doc.flag}` : 'no row' };
        },
      };
    },
  },
  {
    repo: 'pavankumaroff-razorpay-webhook',
    label: 'pavankumaroff/razorpay-webhook',
    eventType: 'payment.captured',
    async setup(repoRoot, event) {
      // Their application lives under backend/, not at the repository root.
      const root = path.join(repoRoot, 'backend');
      const { Payment } = require(path.join(root, 'models', 'payment'));
      const controller = require(path.join(root, 'controllers', 'paymentController'));
      const orderId = event.payload.payment.entity.order_id;
      return {
        handler: (req, res) => controller.verify(req, res),
        parseBody: true,
        async seed() { await Payment.deleteMany({}); },
        async read() {
          const docs = await Payment.find({ order_id: orderId }).lean();
          return {
            recorded: docs.length > 0,
            rows: docs.length,
            detail: `${docs.length} payment row(s)`,
          };
        },
      };
    },
  },
];

async function runSubject(subject, pool) {
  const root = path.join(CACHE, subject.repo);
  if (!fs.existsSync(root)) {
    console.log(`\n  ${subject.label}: not cloned, skipping\n`);
    return null;
  }

  const attempts = ladder(subject.eventType);
  const event = JSON.parse(attempts[0].body.toString());

  console.log(`\n${rule()}`);
  console.log(`  ${subject.label}`);
  console.log(rule());
  console.log(`  fixture   real ${attempts.length}-delivery ladder of ${subject.eventType}`);
  console.log(`  window    ${attempts[0].at}  ->  ${attempts[attempts.length - 1].at}`);

  let ctx;
  try {
    ctx = await subject.setup(root, event);
  } catch (err) {
    console.log(`  could not mount their handler: ${err.message}`);
    return { label: subject.label, error: err.message };
  }

  // ---------------------------------------------------------------- bare
  await ctx.seed();
  const app = express();
  if (ctx.parseBody) app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.post('/webhook', (req, res) => ctx.handler(req, res));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const bareCodes = [];
  for (const a of attempts) bareCodes.push(await post(url, a));
  await sleep(900);
  const bare = await ctx.read();
  server.close();

  const ok2xx = bareCodes.filter((c) => c >= 200 && c < 300).length;
  console.log('');
  console.log('  AS PUBLISHED');
  console.log(`    ${attempts.length} deliveries of ONE payment`);
  console.log(`    responses            ${[...new Set(bareCodes)].join(', ')}`);
  console.log(`    answered 2xx         ${ok2xx}/${bareCodes.length}`);
  console.log(`    payment recorded     ${bare.recorded ? 'yes' : 'NO'}   (${bare.detail})`);
  if (!bare.recorded && ok2xx > 0) {
    console.log('    Razorpay reads those as delivered and stops retrying.');
    console.log('    The payment is gone, and nothing in their logs says so.');
  }
  if (bare.rows > 1) {
    console.log(`    One payment became ${bare.rows} rows.`);
  }

  // ---------------------------------------------------------------- raze
  await ctx.seed();
  await pool.query('TRUNCATE raze_inbox, raze_subject_state');

  const rz = raze.create({ db: pool, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET });
  let invoked = 0;
  rz.on(subject.eventType, async (ev, tx, meta) => {
    invoked++;
    await new Promise((resolve, reject) => {
      let code = 200;
      const req = { body: ev, headers: (meta && meta.headers) || {}, header: () => undefined };
      const settle = (payload) => {
        if (payload instanceof Error) return reject(payload);
        if (code < 200 || code >= 300) {
          return reject(new Error(`merchant answered ${code}`));
        }
        resolve();
      };
      const res = {
        status(c) { code = c; return this; },
        json(p) { settle(p); return this; },
        send(p) { settle(p); return this; },
      };
      Promise.resolve(ctx.handler(req, res)).catch(reject);
      setTimeout(() => reject(new Error('handler never responded')), 5000);
    });
  });

  const guarded = express();
  guarded.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const gServer = await new Promise((r) => { const s = guarded.listen(0, () => r(s)); });
  const gUrl = `http://127.0.0.1:${gServer.address().port}/webhook`;

  const gCodes = [];
  for (const a of attempts) gCodes.push(await post(gUrl, a));
  for (let i = 0; i < 8; i++) { await rz.drain(); await sleep(200); }
  const guarded2 = await ctx.read();

  const inbox = await pool.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE processed_at IS NULL)::int held,
            max(last_error) err
       FROM raze_inbox`
  );
  const i = inbox.rows[0];
  gServer.close();

  console.log('');
  console.log('  BEHIND RAZE  (their code unedited)');
  console.log(`    ${attempts.length} deliveries deduplicated to ${i.total} event`);
  console.log(`    their handler invoked ${invoked} time(s)`);
  console.log(`    payment recorded     ${guarded2.recorded ? 'yes' : 'NO'}   (${guarded2.detail})`);
  console.log(`    still held for retry ${i.held}`);
  if (i.err) console.log(`    failure surfaced     "${String(i.err).slice(0, 60)}"`);

  return {
    label: subject.label,
    bare: { deliveries: attempts.length, ok2xx, recorded: bare.recorded, detail: bare.detail },
    raze: { events: i.total, invoked, recorded: guarded2.recorded, held: i.held, error: i.err, detail: guarded2.detail },
  };
}

async function main() {
  shareModules();
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('public_merchants'));

  const { pool } = await connect();
  await migrate(pool);

  const results = [];
  for (const s of SUBJECTS) {
    try {
      const r = await runSubject(s, pool);
      if (r) results.push(r);
    } catch (err) {
      console.log(`\n  ${s.label}: harness error — ${err.message}\n`);
      results.push({ label: s.label, error: err.message });
    }
  }

  console.log(`\n${rule()}`);
  console.log('  SUMMARY');
  console.log(rule());
  for (const r of results) {
    if (r.error) { console.log(`\n  ${r.label}: ${r.error}`); continue; }
    console.log(`\n  ${r.label}`);
    console.log(`    as published   ${r.bare.deliveries} deliveries, ${r.bare.ok2xx} answered 2xx, ${r.bare.detail}`);
    console.log(`    behind Raze    deduplicated to ${r.raze.events} event, ${r.raze.detail}` +
      `${r.raze.held ? `, ${r.raze.held} held for retry` : ''}`);
  }
  console.log('');
  console.log('  Raze does not repair a broken handler. What changes is whether a');
  console.log('  failed delivery is acknowledged and lost, or recorded and recoverable.');
  console.log('');

  await mongoose.disconnect();
  await mongod.stop();
  await shutdown(pool);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
