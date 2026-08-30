'use strict';

/**
 * Chaos — the guarantee under conditions that break things.
 *
 * Every other layer tests a mechanism working. This one tests the claim:
 *
 *   every payment Razorpay records reaches merchant state exactly once, and an
 *   order is only unpaid if the customer never paid
 *
 * against processes being killed mid-transaction, deliveries being dropped,
 * handlers throwing at random, duplicates and forgeries arriving in the same
 * stream, and the database going away underneath.
 *
 * Two rules kept this test honest while writing it.
 *
 * Kills are real. A worker child is SIGKILLed, not asked to stop and not made to
 * throw. A thrown exception exercises the error path; only a kill exercises the
 * crash path, where nothing gets to clean up and Postgres rolls back a
 * transaction the process still thought was open.
 *
 * The disorder is seeded. A chaos test that shuffles differently every run
 * cannot be debugged when it fails, and a flaky guarantee is not a guarantee.
 * The seed is printed so any failure is reproducible exactly.
 *
 *   node test/layer10.test.js [seed]
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const { spawn } = require('child_process');
const { connect, migrate, shutdown } = require('../src/db');
const raze = require('../src/runtime');
const { createReconciler } = require('../src/reconcile');

const ROOT = path.join(__dirname, '..', '..');
const LOG = [
  path.join(__dirname, '..', 'measurement', 'deliveries.jsonl'),
  path.join(ROOT, 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const TABLE = 'chaos_orders';
const SEED = Number(process.argv[2] || 20260830);

/** Deterministic PRNG, so a failing run can be reproduced from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const { loadEnv, signing } = require('./env');

// Assigned in main(), before any fixture is built.
let signer;

/** Distinct captured payments, each with its full real retry ladder. */
function ladders() {
  const rows = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const byKey = new Map();
  for (const r of rows) {
    if (!r.event_id || !r.raw_body_b64 || r.event_type !== 'payment.captured') continue;
    const k = `${r.event_id}|${r.mode}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const out = [];
  const seenOrders = new Set();
  for (const v of byKey.values()) {
    v.sort((a, b) => a.received_at_ms - b.received_at_ms);
    const body = Buffer.from(v[0].raw_body_b64, 'base64');
    const entity = JSON.parse(body.toString()).payload.payment.entity;
    if (seenOrders.has(entity.order_id)) continue;
    seenOrders.add(entity.order_id);
    out.push({
      orderId: entity.order_id,
      amount: entity.amount,
      attempts: v.map((d) => ({
        body: Buffer.from(d.raw_body_b64, 'base64'),
        eventId: d.event_id,
        signature: signer.forBytes(Buffer.from(d.raw_body_b64, 'base64'), d.signature),
      })),
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

async function main() {
  const env = loadEnv();
  signer = signing(env);
  // Downstream code reads the secret off env; keep the two in step.
  env.RAZORPAY_WEBHOOK_SECRET = signer.secret;
  const rand = rng(SEED);
  const { pool, url: dbUrl } = await connect();
  await migrate(pool);

  console.log(`\nLayer 10 — chaos  (seed ${SEED})\n`);

  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    order_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'created',
    credited_paise BIGINT NOT NULL DEFAULT 0,
    credit_count INT NOT NULL DEFAULT 0)`);

  const reset = async () => {
    await pool.query(`TRUNCATE ${TABLE}, raze_inbox, raze_subject_state, raze_expectations`);
  };

  const payments = ladders();

  // Cases that need the live Razorpay API are skipped, not silently dropped.
  // Asking Razorpay what it recorded is the point of those cases and cannot be
  // stubbed without destroying their meaning. A signature check is likewise
  // meaningless with no secret to verify against.
  const haveCreds = !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const haveSecret = !!env.RAZORPAY_WEBHOOK_SECRET;
  let skipped = 0;
  console.log(`  ${payments.length} distinct payment(s), full real ladders\n`);

  // =====================================================================
  // 1. A worker killed mid-transaction
  // =====================================================================
  await reset();

  // Queue every delivery directly, so the test is about processing rather than
  // about the HTTP path (which layer 1 already covers).
  const crypto = require('crypto');
  for (const p of payments) {
    for (const a of p.attempts) {
      await pool.query(
        `INSERT INTO raze_inbox
           (event_id, event_type, raw_body, raw_body_sha256, signature, headers, subject_id, source)
         VALUES ($1,'payment.captured',$2,$3,$4,'{}'::jsonb,$5,'webhook')
         ON CONFLICT (event_id) DO NOTHING`,
        [a.eventId, a.body, crypto.createHash('sha256').update(a.body).digest('hex'),
         a.signature, p.orderId]
      );
    }
  }
  const queued = await pool.query('SELECT count(*)::int n FROM raze_inbox');

  let kills = 0;
  for (let round = 0; round < 4; round++) {
    const child = spawn(process.execPath, [path.join(__dirname, 'chaos-worker.js'), dbUrl, TABLE], {
      env: { ...process.env, RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    let finished = false;
    let stderr = '';
    let exited = false;

    // The exit promise is created at spawn time. Attaching the listener later
    // would miss a child that already died — which is exactly what happens when
    // the worker fails to start, and the wait would then never return.
    const exit = new Promise((r) => child.on('exit', (code) => { exited = true; r(code); }));

    child.stdout.on('data', (d) => {
      const t = d.toString();
      if (t.includes('ready')) ready = true;
      if (t.includes('drained')) finished = true;
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const deadline = Date.now() + 15000;
    while (!ready && !exited && Date.now() < deadline) await sleep(20);

    if (!ready && exited) {
      console.log(`  worker died before it was ready: ${stderr.slice(0, 200).trim()}`);
      break;
    }
    if (!ready) {
      child.kill('SIGKILL');
      await exit;
      console.log('  worker never signalled ready within 15s');
      break;
    }

    // Kill at a random point inside the working window — very likely mid
    // transaction, given the deliberate delay in the worker's write.
    await sleep(120 + Math.floor(rand() * 260));
    if (!finished && !exited) {
      child.kill('SIGKILL');
      kills++;
    }
    await exit;
    if (finished) break;
  }

  // Whatever survived the kills, finish the work in-process.
  const rzFinish = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, allowUnsigned: !env.RAZORPAY_WEBHOOK_SECRET });
  rzFinish.on('payment.captured', async (event, tx) => {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO ${TABLE} (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = ${TABLE}.credited_paise + EXCLUDED.credited_paise,
             credit_count = ${TABLE}.credit_count + 1`,
      [p.order_id, p.amount]
    );
  });
  for (let i = 0; i < 40; i++) {
    await pool.query('UPDATE raze_inbox SET next_attempt_at = NULL WHERE processed_at IS NULL');
    const n = await rzFinish.drain(200);
    if (n === 0) break;
  }

  const afterKills = await pool.query(
    `SELECT order_id, credited_paise, credit_count FROM ${TABLE} ORDER BY order_id`
  );
  const expectedByOrder = new Map(payments.map((p) => [p.orderId, p.amount]));

  const exactlyOnce = afterKills.rows.every(
    (r) => Number(r.credit_count) === 1 && Number(r.credited_paise) === expectedByOrder.get(r.order_id)
  );
  check(`survives ${kills} mid-transaction SIGKILL(s): every payment applied exactly once`,
    kills > 0 && exactlyOnce && afterKills.rowCount === payments.length,
    afterKills.rows.map((r) => `${r.order_id}=${r.credit_count}x${r.credited_paise}`).join(' '));

  const unprocessed = await pool.query(
    `SELECT count(*)::int n FROM raze_inbox WHERE processed_at IS NULL AND NOT needs_attention`
  );
  check('no event is left half-done after the kills',
    unprocessed.rows[0].n === 0,
    `${unprocessed.rows[0].n} of ${queued.rows[0].n} still pending`);

  // =====================================================================
  // 2. A handler that fails at random, mixed with duplicates and forgeries
  // =====================================================================
  await reset();
  const rzFlaky = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, allowUnsigned: !env.RAZORPAY_WEBHOOK_SECRET });
  let attempts = 0;
  let refusals = 0;
  const failuresPerEvent = new Map();
  const FAIL_FIRST = 2;
  rzFlaky.on('payment.captured', async (event, tx, meta) => {
    attempts++;
    // Deterministic rather than random: the first two attempts at every event
    // fail, then it succeeds. Randomness made this weak — deduplication means a
    // 16-delivery ladder reaches the handler once, so "fail 50% of the time"
    // sampled three calls and happened to fail none of them. Forcing the
    // failures guarantees the retry path is exercised for every event, and keeps
    // the run reproducible.
    const id = (meta && meta.eventId) || 'unknown';
    const soFar = failuresPerEvent.get(id) || 0;
    if (soFar < FAIL_FIRST) {
      failuresPerEvent.set(id, soFar + 1);
      refusals++;
      throw new Error(`intermittent handler failure ${soFar + 1}/${FAIL_FIRST}`);
    }
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO ${TABLE} (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = ${TABLE}.credited_paise + EXCLUDED.credited_paise,
             credit_count = ${TABLE}.credit_count + 1`,
      [p.order_id, p.amount]
    );
  });

  const app = express();
  app.use('/webhook', express.raw({ type: () => true }), rzFlaky.middleware());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;

  // Every delivery, shuffled, with forged copies injected.
  const stream = [];
  for (const p of payments) for (const a of p.attempts) stream.push({ ...a, forged: false });
  for (const p of payments) {
    stream.push({ ...p.attempts[0], eventId: `forged-${p.orderId}`, signature: '0'.repeat(64), forged: true });
  }
  for (let i = stream.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [stream[i], stream[j]] = [stream[j], stream[i]];
  }

  let rejected = 0;
  for (const d of stream) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-event-id': d.eventId,
        'x-razorpay-signature': d.signature,
      },
      body: d.body,
    });
    await res.text();
    if (res.status === 401) rejected++;
  }

  for (let i = 0; i < 60; i++) {
    await pool.query('UPDATE raze_inbox SET next_attempt_at = NULL WHERE processed_at IS NULL');
    await rzFlaky.drain(200);
  }
  server.close();

  const flaky = await pool.query(
    `SELECT order_id, credited_paise, credit_count FROM ${TABLE} ORDER BY order_id`
  );
  // With no secret, the forged copies are accepted — correctly, because nothing
  // can distinguish them — so each order is credited twice. That is a property of
  // running unsigned, not a failure of exactly-once, and the expectation adjusts
  // rather than pretending the forgeries were not delivered.
  const perOrder = haveSecret ? 1 : 2;
  const flakyOnce = flaky.rows.every(
    (r) => Number(r.credit_count) === perOrder
      && Number(r.credited_paise) === expectedByOrder.get(r.order_id) * perOrder
  );
  check(`a handler that fails its first ${FAIL_FIRST} attempts (${refusals} of ${attempts} calls) still applies each delivered event exactly once`,
    // Unsigned, the forged copies are accepted as distinct events too, so twice
    // as many events are retried. Counting only the genuine ones would make this
    // assertion fail for the right reason and the wrong number.
    refusals === payments.length * perOrder * FAIL_FIRST
      && flakyOnce && flaky.rowCount === payments.length,
    flaky.rows.map((r) => `${r.order_id}=${r.credit_count}x${r.credited_paise}`).join(' '));

  if (haveSecret) {
    check(`every forged delivery was rejected before reaching the handler (${rejected})`,
      rejected === payments.length, `rejected=${rejected} expected=${payments.length}`);
  } else {
    console.log('  SKIP  forged deliveries rejected — no webhook secret to verify against');
    skipped++;
  }

  // =====================================================================
  // 3. Deliveries dropped entirely — reconciliation is the only path left
  // =====================================================================
  await reset();
  if (!haveCreds) {
    console.log('  SKIP  dropped deliveries recovered by reconciliation — needs Razorpay credentials');
    console.log('  SKIP  a second reconciliation does not double-apply');
    skipped += 2;
  } else {
    const rec = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    // Nothing has been applied, so nothing is known — the strongest form of
    // "every delivery was dropped".
    localOrderIds: async () => new Set(),
    localRefundIds: async () => new Set(),
    config: { coldStartMs: 4 * 24 * 3600 * 1000 },
  });
  const run = await rec.runOnce();

  const rzRecovered = raze.create({ db: pool, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET, allowUnsigned: !env.RAZORPAY_WEBHOOK_SECRET });
  rzRecovered.on('payment.captured', async (event, tx) => {
    const p = event.payload.payment.entity;
    await tx.query(
      `INSERT INTO ${TABLE} (order_id, status, credited_paise, credit_count)
       VALUES ($1,'paid',$2,1)
       ON CONFLICT (order_id) DO UPDATE
         SET credited_paise = ${TABLE}.credited_paise + EXCLUDED.credited_paise,
             credit_count = ${TABLE}.credit_count + 1`,
      [p.order_id, p.amount]
    );
  });
  for (let i = 0; i < 10; i++) { await rzRecovered.drain(100); await sleep(80); }

  const recovered = await pool.query(`SELECT count(*)::int n FROM ${TABLE} WHERE credit_count = 1`);
  check('with every delivery dropped, reconciliation still recovers the payments',
    run.ok && run.repaired > 0 && recovered.rows[0].n > 0,
    JSON.stringify({ repaired: run.repaired, recovered: recovered.rows[0].n }));

  // Reconciling again must not double-apply what was just recovered.
  const rec2 = createReconciler({
    db: pool,
    razorpay: { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET },
    localOrderIds: async () => {
      const r = await pool.query(`SELECT order_id FROM ${TABLE} WHERE credit_count > 0`);
      return new Set(r.rows.map((x) => x.order_id));
    },
    localRefundIds: async () => new Set(),
    config: { coldStartMs: 4 * 24 * 3600 * 1000 },
  });
  await rec2.runOnce();
  for (let i = 0; i < 10; i++) { await rzRecovered.drain(100); await sleep(60); }
  const doubled = await pool.query(`SELECT count(*)::int n FROM ${TABLE} WHERE credit_count > 1`);
  check('a second reconciliation does not double-apply a recovered payment',
    doubled.rows[0].n === 0, `${doubled.rows[0].n} order(s) credited more than once`);

  // =====================================================================
  }

  // 4. The database goes away mid-run
  // =====================================================================
  const survived = await (async () => {
    const { Pool } = require('pg');
    const doomed = new Pool({ connectionString: dbUrl, max: 2 });
    doomed.on('error', () => {});
    try {
      await doomed.query('SELECT 1');
      // Terminate this pool's own backends from another connection.
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND application_name = ''
            AND state = 'idle' AND backend_start > now() - interval '30 seconds'`
      ).catch(() => {});
      await sleep(200);
      const r = await doomed.query('SELECT 1 AS ok');
      await doomed.end();
      return r.rows[0].ok === 1;
    } catch (err) {
      await doomed.end().catch(() => {});
      return false;
    }
  })();
  check('a pool whose connections are terminated reconnects rather than dying',
    survived, 'the pool did not recover');

  await reset();
  await shutdown(pool);
  const skipNote = skipped ? `, ${skipped} skipped without credentials` : '';
  console.log(`
${pass}/${pass + fail} passed${skipNote}   (seed ${SEED})
`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
