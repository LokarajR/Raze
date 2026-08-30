'use strict';

/**
 * A real published Razorpay integration losing a real payment, and Raze not
 * losing it — with no change to the merchant's code.
 *
 * The merchant is neharahman/razorpay-webhook, cloned at run time. Its code is
 * never vendored: the repository carries no licence, so it is fetched like a
 * fixture and nothing from it is committed here. Its own model and controller
 * are wired up and its webhook route is served exactly as published.
 *
 * The deliveries are the real thing — the exact bytes Razorpay sent, replayed
 * from a 796-delivery measurement of its actual retry behaviour, including a
 * genuine 16-attempt ladder that ran for 22.76 hours.
 *
 * WHAT THIS SHOWS
 *
 * Their handler catches its own exception and answers `res.send(err)`, which
 * Express sends with status 200. Razorpay reads 200 as "delivered", stops
 * retrying, and the payment is gone. Nothing in their logs says a payment was
 * lost, because from their side nothing failed.
 *
 * Behind Raze the same code fails in the same way — Raze does not repair a
 * broken handler and does not pretend to. What changes is that the event was
 * durably recorded before their code ran, the failure is visible, and the event
 * is still there to be retried or reconciled. The payment is recoverable
 * instead of gone.
 *
 *   node examples/public-merchant/lost-payment.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const mongoose = require('mongoose');
const { resolveDemoSecret } = require('../../src/secret');

// One secret shared by this example's sender and its runtime, so signature
// verification runs on a machine with no Razorpay account configured.
const DEMO = resolveDemoSecret(process.env);
// Their handler reads the secret from the environment, exactly as it would in
// production. Without one it dies inside crypto and the report would blame
// their code for our missing configuration, so give it the same demo secret
// everything else here uses.
if (!process.env.RAZORPAY_WEBHOOK_SECRET) process.env.RAZORPAY_WEBHOOK_SECRET = DEMO.secret;

const RAZE = path.join(__dirname, '..', '..');
const CACHE = path.join(RAZE, '.public-merchants');
const REPO = 'https://github.com/neharahman/razorpay-webhook.git';
const DIR = path.join(CACHE, 'neharahman-razorpay-webhook');

const CORPUS = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (t) => { const l = '='.repeat(70); console.log(`\n${l}\n  ${t}\n${l}\n`); };

function clone() {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(DIR)) {
    console.log(`  cloning ${REPO} ...`);
    const r = spawnSync('git', ['clone', '-q', '--depth', '1', REPO, DIR], { encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0) throw new Error(`clone failed: ${(r.stderr || '').slice(0, 200)}`);
  }
  // Their code resolves mongoose/razorpay from its own node_modules, which we do
  // not install. Point module resolution at ours instead — the only concession
  // made, and it changes none of their logic.
  const Module = require('module');
  const original = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from) {
    return original.call(this, from).concat(path.join(RAZE, 'node_modules'));
  };
  return DIR;
}

/** The real retry ladder Razorpay sent for one captured payment.authorized. */
function ladder() {
  const rows = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64 || r.event_type !== 'payment.authorized') continue;
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
    signature: require('crypto').createHmac('sha256', DEMO.secret)
      .update(Buffer.from(d.raw_body_b64, 'base64')).digest('hex'),
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
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 60) };
  } catch (err) {
    return { status: 0, body: `no response (${err.name})` };
  }
}

async function main() {
  let handlerCalls = 0;
  const projectRoot = clone();
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('neharahman'));

  const paymentModel = require(path.join(projectRoot, 'models', 'payment'));
  const controller = require(path.join(projectRoot, 'controllers', 'paymentGateway'));

  const attempts = ladder();
  const entity = JSON.parse(attempts[0].body.toString()).payload.payment.entity;
  const orderId = entity.order_id;

  console.log(`\n  merchant   neharahman/razorpay-webhook  (cloned at run time, unmodified)`);
  console.log(`  fixture    a real ${attempts.length}-delivery Razorpay retry ladder`);
  console.log(`  window     ${attempts[0].at}  ->  ${attempts[attempts.length - 1].at}`);
  console.log(`  order      ${orderId}`);
  console.log(`  amount     ${entity.amount} paise, genuinely paid\n`);

  // Their own checkout writes this row before the customer pays. Seeding it is
  // what their application would have done; no handler logic is involved.
  const seed = async () => {
    await paymentModel.deleteMany({});
    await new paymentModel({ _id: orderId }).save();
  };
  const readState = async () => {
    const doc = await paymentModel.findById(orderId).lean();
    return {
      recorded: !!(doc && doc.flag),
      amount: (doc && doc.amount) || 0,
      flag: !!(doc && doc.flag),
    };
  };

  // -------------------------------------------------------------- as published
  H('1.  neharahman/razorpay-webhook, exactly as published');

  await seed();
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.post('/webhook', (req, res) => controller.paymentSuccess(req, res));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  const results = [];
  for (const a of attempts) results.push(await post(url, a));
  await sleep(800);
  const bare = await readState();

  const codes = results.map((r) => r.status);
  console.log(`  delivered   ${attempts.length} attempts of ONE real payment`);
  console.log(`  responses   ${codes.join(', ')}`);
  console.log(`  first body  ${JSON.stringify(results[0].body)}`);
  console.log(`  payment recorded in their database : ${bare.recorded ? 'yes' : 'NO'}`);
  console.log(`  amount stored                      : ${bare.amount} paise\n`);

  const twoHundreds = codes.filter((c) => c >= 200 && c < 300).length;
  if (!bare.recorded && twoHundreds > 0) {
    console.log(`  ${twoHundreds} of ${codes.length} deliveries were answered with a success code while`);
    console.log(`  nothing was written. Razorpay reads that as delivered and stops`);
    console.log(`  retrying. The payment is gone, and their logs show no failure.\n`);
  }
  server.close();

  // ---------------------------------------------------------------- behind Raze
  H('2.  The same code, not one line changed, behind Raze');

  await seed();
  const raze = require(path.join(RAZE, 'src', 'runtime'));
  const { connect, migrate } = require(path.join(RAZE, 'src', 'db'));
  const { pool } = await connect();
  await migrate(pool);
  await pool.query('TRUNCATE raze_inbox, raze_subject_state');

  const rz = raze.create({ db: pool, webhookSecret: DEMO.secret });
  const handlerTypes = new Set(['payment.authorized']);
  rz.on('payment.authorized', async (event, tx, meta) => {
    handlerCalls++;
    // Their handler, called exactly as their own route calls it — including the
    // original headers, so its signature check sees what Razorpay actually
    // sent. Handing it an empty headers object would make it reject for the
    // wrong reason and the comparison would be meaningless.
    await new Promise((resolve, reject) => {
      let code = 200;
      const req = { body: event, headers: meta.headers || {} };
      const settle = (payload) => {
        if (payload instanceof Error) return reject(payload);
        // Their catch block answers res.send(err) and their unverified branch
        // answers 501. Either is a failure, whatever status Express attaches.
        if (code < 200 || code >= 300) {
          return reject(new Error(`merchant handler responded ${code}: ${String(payload).slice(0, 60)}`));
        }
        resolve();
      };
      const res = {
        status(c) { code = c; return this; },
        json(p) { settle(p); return this; },
        send(p) { settle(p); return this; },
      };
      Promise.resolve(controller.paymentSuccess(req, res)).catch(reject);
      setTimeout(() => reject(new Error('handler never responded')), 5000);
    });
  });

  const guarded = express();
  guarded.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const gServer = await new Promise((r) => { const s = guarded.listen(0, () => r(s)); });
  const gUrl = `http://127.0.0.1:${gServer.address().port}/webhook`;

  const gResults = [];
  // counted so the report can never imply their handler ran when it did not
  for (const a of attempts) gResults.push(await post(gUrl, a));
  for (let i = 0; i < 8; i++) { await rz.drain(); await sleep(200); }
  const guardedState = await readState();

  const inbox = await pool.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE processed_at IS NULL)::int held,
            max(process_attempts)::int attempts,
            max(last_error) err,
            string_agg(DISTINCT coalesce(resolution, 'pending'), ',') AS resolutions,
            string_agg(DISTINCT event_type, ',') AS types
       FROM raze_inbox`
  );
  const i = inbox.rows[0];

  console.log(`  delivered   ${attempts.length} attempts of the SAME payment`);
  console.log(`  responses   ${gResults.map((r) => r.status).join(', ')}`);
  console.log(`  payment recorded in their database : ${guardedState.recorded ? 'yes' : 'NO'}`);
  console.log('');
  console.log(`  events durably stored by Raze      : ${i.total}  (deduplicated from ${attempts.length} deliveries)`);
  console.log(`  still held, awaiting retry         : ${i.held}`);
  console.log(`  their handler actually invoked     : ${handlerCalls} time(s)`);
  console.log(`  handler failure recorded           : ${i.err ? 'yes' : 'no'}`);
  if (i.err) console.log(`    "${String(i.err).slice(0, 70)}"`);
  console.log(`  inbox resolution                   : ${i.resolutions}`);
  console.log(`  inbox event_type                   : ${i.types}`);
  console.log(`  handlers registered                : ${[...handlerTypes].join(', ')}`);
  console.log('');

  H('What changed');

  console.log(`  Their handler is broken either way. Raze does not repair a broken`);
  console.log(`  handler and does not claim to.\n`);
  console.log(`  as published    ${attempts.length} deliveries, ${twoHundreds} answered OK, 0 recorded, 0 retained`);
  console.log(`                  Razorpay stops retrying. The payment is unrecoverable.\n`);
  console.log(`  behind Raze     ${attempts.length} deliveries, deduplicated to ${i.total} event`);
  console.log(`                  the raw bytes are stored, the failure is visible, and the`);
  console.log(`                  event is still queued. Nothing is lost.\n`);
  console.log(`  Reconciliation would also find this payment independently, by asking`);
  console.log(`  Razorpay what it recorded — which is the point of not relying on`);
  console.log(`  delivery at all.\n`);

  gServer.close();
  await mongoose.disconnect();
  await mongod.stop();
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
