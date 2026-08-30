'use strict';

/**
 * Raze against a real, independently written, public Razorpay integration.
 *
 * Runs the whole comparison in one process:
 *
 *   1. clone a public repository at run time (never vendored — those repos carry
 *      no licence, so their code is fetched like a fixture and never committed)
 *   2. start a real MongoDB and wire up that project's own model and controller
 *   3. replay a genuine Razorpay retry ladder at it — the same bytes Razorpay
 *      really sent, including all 16 attempts measured over 22.76 hours
 *   4. read the resulting state out of that project's own collection
 *   5. do it again with the Raze runtime in front of the same untouched code
 *
 * No merchant logic is written here, and the published code is never edited.
 * Whatever it gets wrong, it gets wrong on its own.
 *
 *   node examples/public-merchant/demo.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');

const RAZE = path.join(__dirname, '..', '..');
const { ensureCloned, prepareModuleResolution, startMongo, TARGETS } = require('./run');
const { resolveDemoSecret } = require('../../src/secret');

// One secret shared by this example's sender and its runtime, so signature
// verification runs on a machine with no Razorpay account configured.
const DEMO = resolveDemoSecret(process.env);
// Their handler reads the secret from the environment, exactly as it would in
// production. Without one it dies inside crypto and the report would blame
// their code for our missing configuration, so give it the same demo secret
// everything else here uses.
if (!process.env.RAZORPAY_WEBHOOK_SECRET) process.env.RAZORPAY_WEBHOOK_SECRET = DEMO.secret;

const CORPUS = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (n = 68) => '='.repeat(n);
const H = (t) => { console.log(`\n${line()}\n  ${t}\n${line()}\n`); };

/** The real retry ladder Razorpay sent for one captured event. */
function ladder() {
  const rows = fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64 || r.event_type !== 'payment.captured') continue;
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

async function send(url, f) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': f.eventId,
        'x-razorpay-signature': f.signature,
      },
      body: f.body,
    });
    await res.text();
    return res.status;
  } catch (err) {
    return 0;
  }
}

async function main() {
  const target = TARGETS['pavankumaroff'];
  const projectRoot = prepareModuleResolution(ensureCloned(target));
  const mongod = await startMongo();

  const attempts = ladder();
  const orderId = JSON.parse(attempts[0].body.toString()).payload.payment.entity.order_id;

  console.log(`\n  merchant   ${target.label}   (cloned at run time, unmodified)`);
  console.log(`  fixture    a real ${attempts.length}-delivery Razorpay retry ladder`);
  console.log(`  first      ${attempts[0].at}`);
  console.log(`  last       ${attempts[attempts.length - 1].at}`);
  console.log(`  order      ${orderId}`);
  console.log(`  state read from the project's own MongoDB collection\n`);

  // ---------------------------------------------------------------- as published
  H('1.  The integration as published');

  const bare = express();
  const controller = require(path.join(projectRoot, 'controllers', 'paymentController'));
  bare.post('/webhook', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }),
    (req, res) => controller.verify(req, res));
  const bareServer = await new Promise((r) => { const s = bare.listen(0, () => r(s)); });
  const bareUrl = `http://127.0.0.1:${bareServer.address().port}/webhook`;

  await target.reset();
  const codes = [];
  for (const a of attempts) codes.push(await send(bareUrl, a));
  await sleep(1200);
  const after = await target.state(orderId);

  console.log(`  delivered  ${attempts.length} attempts of ONE payment`);
  console.log(`  responses  ${codes.join(', ')}`);
  console.log(`  rows in their payments collection : ${after.credit_count}`);
  console.log(`  amount recorded                   : ${after.credited_paise} paise`);
  const expected = Math.round(JSON.parse(attempts[0].body.toString()).payload.payment.entity.amount);
  console.log(`  amount actually paid              : ${expected} paise\n`);

  if (after.credit_count > 1) {
    console.log(`  One payment was recorded ${after.credit_count} times.`);
    console.log(`  Every response above was a success code. Nothing in their logs says`);
    console.log(`  anything went wrong.\n`);
  } else if (after.credit_count === 0) {
    console.log(`  Their handler recorded nothing at all for a payment that really\n  happened.\n`);
  }
  bareServer.close();

  // ---------------------------------------------------------------- behind Raze
  H('2.  The same code, unedited, behind Raze');

  const raze = require(path.join(RAZE, 'src', 'runtime'));
  const { connect, migrate } = require(path.join(RAZE, 'src', 'db'));
  const { pool } = await connect();
  await migrate(pool);
  await pool.query('TRUNCATE raze_inbox, raze_subject_state');

  const rz = raze.create({ db: pool, webhookSecret: DEMO.secret });
  rz.on('payment.captured', async (event) => {
    await new Promise((resolve) => {
      const req = { body: event, header: () => undefined, headers: {} };
      const res = { status() { return this; }, json() { resolve(); return this; }, send() { resolve(); return this; } };
      Promise.resolve(controller.verify(req, res)).catch(() => resolve());
      setTimeout(resolve, 2500);
    });
  });

  const guarded = express();
  guarded.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  const guardedServer = await new Promise((r) => { const s = guarded.listen(0, () => r(s)); });
  const guardedUrl = `http://127.0.0.1:${guardedServer.address().port}/webhook`;

  await target.reset();
  const codes2 = [];
  for (const a of attempts) codes2.push(await send(guardedUrl, a));
  for (let i = 0; i < 20; i++) { await rz.drain(); await sleep(150); }
  const after2 = await target.state(orderId);

  console.log(`  delivered  ${attempts.length} attempts of the SAME payment`);
  console.log(`  responses  ${codes2.join(', ')}`);
  console.log(`  rows in their payments collection : ${after2.credit_count}`);
  console.log(`  amount recorded                   : ${after2.credited_paise} paise`);
  console.log(`  amount actually paid              : ${expected} paise\n`);

  H('Result');
  console.log(`  ${target.label}, unmodified:`);
  console.log(`    as published    ${after.credit_count} record(s), ${after.credited_paise} paise`);
  console.log(`    behind Raze     ${after2.credit_count} record(s), ${after2.credited_paise} paise`);
  console.log(`    correct         1 record, ${expected} paise\n`);
  console.log(`  Not one line of their code changed. The deliveries are the exact bytes`);
  console.log(`  Razorpay sent, replayed from a 796-delivery measurement of its real`);
  console.log(`  retry behaviour.\n`);

  guardedServer.close();
  await mongoose.disconnect();
  await mongod.stop();
  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
