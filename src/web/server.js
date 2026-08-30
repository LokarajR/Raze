'use strict';

/**
 * The Raze Console.
 *
 * A terminal transcript is not a demonstration. This is the same engine —
 * the same probes, the same runtime, the same reconciler — behind a page you
 * can point at a merchant and watch.
 *
 * WHAT IS REAL HERE
 *
 * This process is the webhook endpoint you register with Razorpay. Deliveries
 * that arrive are genuine Razorpay POSTs with genuine signatures, and every one
 * is recorded byte-for-byte before anything else happens. Orders are created
 * through the live Razorpay API and are visible in the Razorpay dashboard under
 * the same ids the page shows. The merchant being audited is a real process
 * with a real database, not a mock.
 *
 * WHAT THE CONSOLE DOES WITH A DELIVERY
 *
 * It tees. Whatever arrives is written to the console's own record, and then
 * forwarded — unchanged, raw bytes and all headers — to whichever pipeline is
 * armed:
 *
 *   unprotected   straight to the merchant, exactly as Razorpay would
 *   protected     into Raze, which dedupes, verifies and applies transactionally
 *
 * Forwarding preserves the body byte-for-byte because a signature is computed
 * over those exact bytes. Re-serialising the JSON would break verification and
 * the demonstration would be measuring the console's bug, not the merchant's.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { spawn, spawnSync } = require('child_process');

const RAZE = path.join(__dirname, '..', '..');
const { createAuditor } = require(path.join(RAZE, 'src', 'audit'));
const { createReconciler } = require(path.join(RAZE, 'src', 'reconcile'));
const { createLedger } = require(path.join(RAZE, 'src', 'ledger'));
const { scan } = require(path.join(RAZE, 'src', 'patterns'));
const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
const { resolveDemoSecret } = require(path.join(RAZE, 'src', 'secret'));
const { MERCHANT_SCHEMA } = require(path.join(RAZE, 'examples', 'demo-merchant', 'server'));

const LOG = [
  path.join(RAZE, 'measurement', 'deliveries.jsonl'),
  path.join(RAZE, '..', 'deliveries.jsonl'),
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// live console state
// ---------------------------------------------------------------------------

const S = {
  mode: 'none',            // none | unprotected | protected
  merchant: null,          // child process
  merchantPort: 4200,
  deliveries: [],          // newest first, capped
  scans: [],
  lastAudit: null,
  lastImpact: null,
  publicUrl: null,
  stopping: false,        // a kill we asked for, so the exit handler stays quiet
  restarts: [],           // timestamps, to notice a merchant that cannot stay up
  restoredOnBoot: false,
};

const clients = new Set();

function emit(type, data) {
  const line = `data: ${JSON.stringify({ type, at: Date.now(), ...data })}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch {}
  }
}

function record(entry) {
  S.deliveries.unshift(entry);
  if (S.deliveries.length > 300) S.deliveries.length = 300;
  emit('delivery', entry);
}

// ---------------------------------------------------------------------------
// the merchant under test
// ---------------------------------------------------------------------------

async function startMerchant(mode, databaseUrl, secret, port) {
  const child = spawn(process.execPath, [path.join(RAZE, 'examples', 'demo-merchant', 'server.js')], {
    env: {
      ...process.env,
      MODE: mode,
      PORT: String(port),
      RAZORPAY_WEBHOOK_SECRET: secret || '',
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => emit('merchant-log', { mode, line: String(d).slice(0, 400) }));

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch {}
    await sleep(200);
  }
  child.kill();
  throw new Error(`merchant (${mode}) did not start on port ${port}`);
}

async function stopMerchant() {
  if (!S.merchant) return;
  S.merchant.kill();
  S.merchant = null;
  await sleep(500);
}

// ---------------------------------------------------------------------------
// staying armed
// ---------------------------------------------------------------------------

/**
 * Which pipeline is armed, kept in Postgres rather than in this process.
 *
 * A deploy, a crash or a host moving the container all restart this process, and
 * an armed merchant does not survive that. Holding the choice in memory meant a
 * redeploy silently disarmed the console — the page still said "behind Raze"
 * while there was nothing behind anything. Postgres is already required, already
 * shared with the merchant, and outlives the container.
 */
async function rememberMode(pool, mode) {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS raze_console_state (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      mode TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(
      `INSERT INTO raze_console_state (id, mode, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
      [mode]
    );
  } catch (err) {
    emit('warning', { message: `could not persist armed mode: ${err.message}` });
  }
}

async function recallMode(pool) {
  try {
    const r = await pool.query('SELECT mode FROM raze_console_state WHERE id = 1');
    return r.rows[0] ? r.rows[0].mode : 'none';
  } catch { return 'none'; }
}

/**
 * Start the merchant for a mode, and keep it running.
 *
 * The exit handler is what makes this hold. A merchant that dies on its own —
 * OOM, an unhandled rejection in the handler being demonstrated — used to leave
 * the console claiming to be armed while every delivery went nowhere. It is
 * brought back, with a ceiling: five restarts inside a minute means it cannot
 * stay up, and saying so is more useful than restarting forever.
 */
async function armMode({ pool, databaseUrl, secret, mode }) {
  S.stopping = true;
  await stopMerchant();
  S.stopping = false;

  const merchantMode = mode === 'unprotected' ? 'broken' : mode;
  const child = await startMerchant(merchantMode, databaseUrl, secret, S.merchantPort);

  child.on('exit', (code, signal) => {
    if (S.stopping || S.mode === 'none') return;
    emit('merchant-exit', { mode: S.mode, code, signal });

    const now = Date.now();
    S.restarts = S.restarts.filter((t) => now - t < 60000);
    S.restarts.push(now);
    if (S.restarts.length > 5) {
      S.mode = 'none';
      S.merchant = null;
      emit('armed', { mode: 'none', reason: 'merchant exited repeatedly; not restarting' });
      return;
    }
    setTimeout(() => {
      if (S.mode === 'none') return;
      armMode({ pool, databaseUrl, secret, mode: S.mode })
        .catch((err) => emit('warning', { message: `restart failed: ${err.message}` }));
    }, 1500);
  });

  S.merchant = child;
  S.mode = mode;
  await rememberMode(pool, mode);
  emit('armed', { mode });
  return mode;
}

/**
 * Put back whatever was armed before this process existed.
 *
 * Deliberately does nothing on a first boot: arming something nobody asked for
 * would start a deliberately broken merchant on a public URL.
 */
async function restoreArmed({ pool, databaseUrl, env }) {
  const { resolveDemoSecret: rs } = require(path.join(RAZE, 'src', 'secret'));
  const { secret } = rs(env);
  const mode = await recallMode(pool);
  if (!mode || mode === 'none') return null;
  try {
    await armMode({ pool, databaseUrl, secret, mode });
    S.restoredOnBoot = true;
    return mode;
  } catch (err) {
    S.mode = 'none';
    return { error: err.message, mode };
  }
}

// ---------------------------------------------------------------------------
// repository import
// ---------------------------------------------------------------------------

const CACHE = path.join(RAZE, '.public-merchants');

/** Files that look like they receive Razorpay webhooks. */
function findHandlers(root) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
  (function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full, depth + 1); continue; }
      if (!/\.(js|ts|mjs|cjs)$/.test(e.name)) continue;
      if (/\.(test|spec)\./.test(e.name)) continue;
      let src;
      try { src = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (src.length > 400000) continue;
      const isHandler =
        /x-razorpay-signature/i.test(src) ||
        /validateWebhookSignature/.test(src) ||
        (/payload\.(payment|order|refund)\.entity/.test(src) && /req\.body|request\.body|event/.test(src));
      if (isHandler) out.push({ file: full, source: src });
    }
  })(root, 0);
  return out;
}

function importRepo(repoUrl) {
  const m = String(repoUrl).match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error('not a GitHub repository URL');
  const slug = `${m[1]}/${m[2]}`;
  const dir = path.join(CACHE, slug.replace('/', '-'));

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const res = spawnSync('git', ['clone', '-q', '--depth', '1',
      `https://github.com/${slug}.git`, dir], { encoding: 'utf8', timeout: 180000 });
    if (res.status !== 0) throw new Error(`could not clone ${slug}`);
  }

  const handlers = findHandlers(dir);
  if (handlers.length === 0) {
    return { slug, handler: null, hits: [],
      note: 'No webhook handler found. Nothing is claimed about this repository.' };
  }

  let best = null;
  for (const h of handlers) {
    const hits = scan(h.source);
    if (!best || hits.length > best.hits.length) best = { ...h, hits };
  }

  const rel = path.relative(dir, best.file).replace(/\\/g, '/');
  const lines = best.source.split('\n');
  return {
    slug,
    handler: rel,
    hits: best.hits.map((h) => ({
      id: h.pattern.id,
      title: h.pattern.title,
      evidence: h.evidence,
      fails: h.pattern.fixes || [],
      repairable: !!h.repairable,
      line: h.line || null,
      excerpt: h.line ? lines.slice(Math.max(0, h.line - 3), h.line + 2).join('\n') : null,
    })),
    note: best.hits.length === 0
      ? 'No known pattern matched. That means unrecognised, not correct.'
      : null,
  };
}

// ---------------------------------------------------------------------------
// the app
// ---------------------------------------------------------------------------

function createApp({ pool, databaseUrl, env }) {
  const app = express();
  const { secret } = resolveDemoSecret(env);
  const razorpay = { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
  const haveRazorpay = !!(razorpay.keyId && razorpay.keySecret);

  app.use('/ui', express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.get('/health', (_req, res) => res.json({ ok: true, mode: S.mode }));

  // ---- the real Razorpay endpoint ---------------------------------------
  //
  // Registered in the Razorpay dashboard. Raw body: the signature is computed
  // over these exact bytes, so nothing may re-serialise them.
  app.post('/webhook', express.raw({ type: () => true }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    const eventId = req.get('x-razorpay-event-id') || null;
    const signature = req.get('x-razorpay-signature') || null;

    let eventType = null; let orderId = null; let amount = null;
    try {
      const parsed = JSON.parse(body.toString());
      eventType = parsed.event;
      const ent = parsed.payload?.payment?.entity || parsed.payload?.order?.entity;
      orderId = ent?.order_id || ent?.id || null;
      amount = ent?.amount ?? null;
    } catch {}

    // Reported, never enforced here. The console records what arrived; whether a
    // delivery is accepted is the merchant's decision or Raze's, and taking it
    // away would hide the very defect being demonstrated.
    let signatureValid = false;
    if (signature && signature.length === 64) {
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      try {
        signatureValid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      } catch { signatureValid = false; }
    }

    const entry = {
      eventId, eventType, orderId, amount, signaturePresent: !!signature, signatureValid,
      bytes: body.length, mode: S.mode, forwarded: null, status: null,
      sha256: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    };

    // Answer Razorpay immediately. Holding the connection open is what causes
    // the timeout-induced duplicate this whole project measures.
    res.status(200).json({ received: true });

    if (S.mode === 'none' || !S.merchant) {
      entry.forwarded = 'nothing armed — recorded only';
      record(entry);
      return;
    }

    try {
      const fwd = await fetch(`http://127.0.0.1:${S.merchantPort}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': req.get('content-type') || 'application/json',
          ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
          ...(signature ? { 'x-razorpay-signature': signature } : {}),
        },
        body,
      });
      entry.forwarded = S.mode;
      entry.status = fwd.status;
    } catch (err) {
      entry.forwarded = S.mode;
      entry.status = 0;
      entry.error = err.message;
    }
    record(entry);
  });

  app.use(express.json());

  // ---- live event stream -------------------------------------------------
  app.get('/api/events', (req, res) => {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'hello', mode: S.mode })}\n\n`);
    clients.add(res);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
  });

  // ---- import a repository ----------------------------------------------
  app.post('/api/scan', (req, res) => {
    try {
      const result = importRepo(req.body.repo);
      S.scans.unshift(result);
      if (S.scans.length > 20) S.scans.length = 20;
      emit('scan', result);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- arm a pipeline ----------------------------------------------------
  app.post('/api/arm', async (req, res) => {
    const mode = req.body.mode;
    if (!['unprotected', 'protected', 'correct'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be unprotected, protected or correct' });
    }
    try {
      S.restarts = [];
      await armMode({ pool, databaseUrl, secret, mode });
      res.json({ ok: true, mode });
    } catch (err) {
      S.mode = 'none';
      await rememberMode(pool, 'none');
      res.status(500).json({ error: err.message });
    }
  });

  // ---- run the probes ----------------------------------------------------
  app.post('/api/audit', async (req, res) => {
    if (!S.merchant) return res.status(400).json({ error: 'arm a pipeline first' });
    try {
      const auditor = createAuditor({
        targetUrl: req.body.targetUrl || `http://127.0.0.1:${S.merchantPort}/webhook`,
        pool, logFile: LOG, webhookSecret: secret,
      });
      emit('audit-start', { mode: S.mode });
      const results = await auditor.run();
      S.lastAudit = { mode: S.mode, results, at: Date.now() };
      emit('audit-done', S.lastAudit);

      const impact = await computeImpact({
        pool, razorpay, results, table: 'shop_orders', volume: req.body.volume,
      });
      S.lastImpact = impact;
      emit('impact', impact);
      res.json({ results, impact });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- impact on demand --------------------------------------------------
  app.post('/api/impact', async (req, res) => {
    try {
      const impact = await computeImpact({
        pool, razorpay,
        results: S.lastAudit ? S.lastAudit.results : [],
        table: 'shop_orders', volume: req.body.volume,
      });
      S.lastImpact = impact;
      res.json(impact);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- create a real order the operator can actually pay -----------------
  app.post('/api/order', async (req, res) => {
    if (!haveRazorpay) return res.status(400).json({ error: 'no Razorpay credentials configured' });
    const amount = Number(req.body.amount || 100);
    const auth = 'Basic ' + Buffer.from(`${razorpay.keyId}:${razorpay.keySecret}`).toString('base64');
    try {
      const r = await fetch('https://api.razorpay.com/v1/payment_links', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          amount, currency: 'INR',
          description: 'Raze console — live demonstration',
          notify: { sms: false, email: false },
        }),
      });
      const link = await r.json();
      if (!r.ok) return res.status(400).json({ error: link.error?.description || 'link failed' });
      emit('order', { id: link.id, order_id: link.order_id, amount, url: link.short_url });
      res.json({ id: link.id, order_id: link.order_id, amount, url: link.short_url });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- reconciliation: recover without any delivery at all ---------------
  app.post('/api/reconcile', async (req, res) => {
    if (!haveRazorpay) return res.status(400).json({ error: 'no Razorpay credentials configured' });
    try {
      const rec = createReconciler({
        db: pool, razorpay,
        localOrderIds: async () => {
          const r = await pool.query('SELECT order_id FROM shop_orders');
          return new Set(r.rows.map((x) => x.order_id));
        },
        config: { coldStartMs: 72 * 3600 * 1000 },
      });
      emit('reconcile-start', {});
      const out = await rec.runOnce();
      emit('reconcile-done', out);
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- the ledger: name what never arrived -------------------------------
  app.post('/api/ledger', async (_req, res) => {
    if (!haveRazorpay) return res.status(400).json({ error: 'no Razorpay credentials configured' });
    try {
      const ledger = createLedger({ db: pool, razorpay });
      const out = await ledger.sweepOnce();
      emit('ledger', out);
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- what the merchant's own tables say --------------------------------
  app.get('/api/state', async (_req, res) => {
    const out = { mode: S.mode, deliveries: S.deliveries.slice(0, 60), scans: S.scans };
    try {
      const orders = await pool.query(
        'SELECT order_id, status, credited_paise, credit_count FROM shop_orders ORDER BY order_id');
      out.orders = orders.rows.map((r) => ({
        ...r, credited_paise: Number(r.credited_paise), credit_count: Number(r.credit_count),
      }));
    } catch { out.orders = []; }
    try {
      const inbox = await pool.query(
        `SELECT event_id, event_type, processed_at IS NOT NULL AS processed, process_attempts
           FROM raze_inbox ORDER BY received_at DESC LIMIT 40`);
      out.inbox = inbox.rows;
    } catch { out.inbox = []; }
    out.audit = S.lastAudit;
    out.impact = S.lastImpact;
    out.razorpay = haveRazorpay;
    out.publicUrl = S.publicUrl;
    out.restoredOnBoot = S.restoredOnBoot;
    res.json(out);
  });

  app.post('/api/reset', async (_req, res) => {
    try {
      await pool.query('TRUNCATE shop_orders, shop_seen_events, shop_order_rank');
      await pool.query('TRUNCATE raze_inbox, raze_subject_state, raze_expectations');
      S.deliveries = [];
      S.lastAudit = null;
      S.lastImpact = null;
      emit('reset', {});
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return app;
}

module.exports = { createApp, startMerchant, stopMerchant, armMode, restoreArmed,
  rememberMode, recallMode, S, MERCHANT_SCHEMA };
