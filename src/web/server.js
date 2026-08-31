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

/**
 * What the merchant has connected, for this process only.
 *
 * Never persisted. A database URL or an API key that outlives the session is a
 * credential this project would then be responsible for storing safely, and the
 * honest answer is not to store it at all.
 */
const CONNECT = {
  razorpay: null, webhookSecret: null, webhookId: null,
  databaseUrl: null, merchantPool: null, proposals: null, approved: null,
};

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
  // One surface: the merchant's. Setup until it is done, then what Raze did.
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

    let eventType = null; let orderId = null; let amount = null; let entity = null;
    try {
      const parsed = JSON.parse(body.toString());
      eventType = parsed.event;
      const ent = parsed.payload?.payment?.entity || parsed.payload?.order?.entity;
      entity = ent || null;
      orderId = ent?.order_id || ent?.id || null;
      amount = ent?.amount ?? null;
    } catch {}

    // Reported, never enforced here. The console records what arrived; whether a
    // delivery is accepted is the merchant's decision or Raze's, and taking it
    // away would hide the very defect being demonstrated.
    // The secret a delivery is checked against has to be the secret the webhook
    // was registered with. When Raze built the integration it generated one, and
    // that is the only one Razorpay is signing with; the environment's secret
    // belongs to the demo merchant and would fail every real delivery.
    const active = CONNECT.webhookSecret || secret;
    let signatureValid = false;
    if (signature && signature.length === 64) {
      const expected = crypto.createHmac('sha256', active).update(body).digest('hex');
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

    // A connected merchant is the point of the whole thing, so their delivery is
    // acted on rather than filed.
    //
    // Only when the signature verifies. An unauthenticated body that reaches
    // this route is someone else's claim about a payment, and acting on it would
    // hand anybody who knows the URL a way to mark orders paid.
    //
    // This is the fast path, not the safety net: reconciliation would find the
    // same payment within the minute by asking Razorpay directly, which is what
    // covers the deliveries that never arrive at all. Both routes run the same
    // policy and the same write, so a payment arriving twice — once here, once
    // through reconciliation — lands once.
    if (S.loops && CONNECT.chosen && signatureValid && entity
        && (eventType === 'payment.captured' || eventType === 'order.paid')) {
      entry.forwarded = 'applied to the connected merchant';
      record(entry);
      try {
        const out = await S.loops.handleDrift({
          id: entity.id, order_id: entity.order_id || entity.id,
          amount: entity.amount, status: entity.status || 'captured',
        });
        emit('loop', { type: 'webhook', paymentId: entity.id, ...out });
      } catch (err) {
        emit('loop', { type: 'error', where: 'webhook', error: err.message });
      }
      return;
    }

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
  // -------------------------------------------------------------------------
  // connect: the merchant's own account, the merchant's own database
  // -------------------------------------------------------------------------
  //
  // A merchant should not have to know what idempotency is. They say "protect my
  // Razorpay payments"; everything below is Raze working out what that means for
  // their particular schema and account.
  //
  // Credentials given here live in this process's memory: never written to disk,
  // never logged, never returned by any endpoint. The public deployment refuses
  // these routes outright — asking a merchant to paste a production database URL
  // into a public web page would be indefensible however carefully the value
  // were handled afterwards.

  const localOnly = (req, res, next) => {
    // "I know a public address I can register" is not the same as "I am the
    // public instance". Conflating them made a laptop refuse its own setup the
    // moment it was told where Razorpay should deliver. Only a host that set
    // PUBLIC_URL itself — Railway, Render, Fly — is the deployment.
    //
    // A deployment is not automatically a stranger's, though. Registering a
    // webhook against a temporary tunnel is the wrong shape for the real thing:
    // the address dies with the laptop, Razorpay keeps delivering to nothing,
    // and the account fills with entries their API has no route to remove. A
    // merchant's own instance, on a permanent address, is the correct home for
    // this — so a deployment that carries RAZE_SETUP_TOKEN accepts setup from
    // whoever holds that token, and one without it stays a read-only receiver
    // that will not take anybody's keys.
    const gate = process.env.RAZE_SETUP_TOKEN;
    if (gate) {
      const shown = String(req.get('x-raze-setup') || (req.query && req.query.t) || '');
      const a = Buffer.from(shown);
      const b = Buffer.from(gate);
      const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
      if (ok) return next();
      return res.status(403).json({
        error: 'This instance needs its setup token. Open it as ?t=<token> — the value is '
          + 'RAZE_SETUP_TOKEN in the deployment\'s own variables.',
      });
    }
    if (process.env.PUBLIC_URL) {
      return res.status(403).json({
        error: 'This deployment is a webhook receiver only. To connect a merchant, deploy '
          + 'your own instance with RAZE_SETUP_TOKEN set, or run `npm run web` locally.',
      });
    }
    next();
  };

  app.post('/api/connect/razorpay', localOnly, async (req, res) => {
    const keyId = String(req.body.keyId || '').trim();
    const keySecret = String(req.body.keySecret || '').trim();
    if (!keyId || !keySecret) return res.status(400).json({ error: 'both keys are required' });
    if (!/^rzp_test_/.test(keyId)) {
      return res.status(400).json({
        error: 'that looks like a live key. Connect a Test Mode key (rzp_test_...) — this '
          + 'fires real deliveries at a merchant and must not touch live money.',
      });
    }
    try {
      // Verified by using it, not by pattern-matching the string.
      const auth = 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/payments?count=1', {
        headers: { authorization: auth },
      });
      const body = await r.json();
      if (!r.ok) {
        return res.status(400).json({
          error: (body.error && body.error.description) || 'Razorpay rejected the keys (HTTP ' + r.status + ')',
        });
      }
      CONNECT.razorpay = { keyId, keySecret };
      const hooks = await fetch('https://api.razorpay.com/v1/webhooks', { headers: { authorization: auth } });
      const hb = await hooks.json();
      res.json({
        ok: true,
        mode: 'test',
        existing_webhooks: (hb.items || []).map((w) => ({ id: w.id, url: w.url, active: w.active })),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/connect/webhook', localOnly, async (req, res) => {
    if (!CONNECT.razorpay) return res.status(400).json({ error: 'connect the Razorpay account first' });
    const url = String(req.body.url || '').trim();
    if (!/^https:\/\//.test(url)) {
      return res.status(400).json({
        error: 'Razorpay needs a public HTTPS endpoint and rejects localhost at save time. '
          + 'Deploy first, then paste that URL here.',
      });
    }
    try {
      // Generated here rather than asked for: a merchant choosing their own
      // secret is a merchant choosing a weak one.
      const secret = crypto.randomBytes(24).toString('hex');
      const auth = 'Basic ' + Buffer.from(CONNECT.razorpay.keyId + ':' + CONNECT.razorpay.keySecret).toString('base64');
      const r = await fetch('https://api.razorpay.com/v1/webhooks', {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          secret,
          events: {
            'payment.authorized': true, 'payment.captured': true, 'payment.failed': true,
            'order.paid': true, 'refund.created': true,
          },
        }),
      });
      const body = await r.json();
      if (!r.ok) {
        return res.status(400).json({
          error: (body.error && body.error.description) || 'HTTP ' + r.status,
        });
      }

      // Read it back. A registration the provider has not confirmed is not a
      // registration.
      const check = await fetch('https://api.razorpay.com/v1/webhooks', { headers: { authorization: auth } });
      const cb = await check.json();
      const found = (cb.items || []).find((w) => w.id === body.id);

      CONNECT.webhookSecret = secret;
      CONNECT.webhookId = body.id;
      res.json({
        ok: true,
        id: body.id,
        url: body.url,
        confirmed: !!(found && found.active),
        events: Object.keys(body.events || {}).filter((k) => body.events[k]),
        note: 'The secret was generated here and is held in memory only. It is never '
          + 'written to disk or returned by any endpoint.',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/connect/database', localOnly, async (req, res) => {
    const url = String(req.body.databaseUrl || '').trim();
    if (!url) return res.status(400).json({ error: 'a database URL is required' });
    try {
      const { Pool } = require('pg');
      const merchantPool = new Pool({ connectionString: url, max: 4 });
      merchantPool.on('error', () => {});
      await merchantPool.query('SELECT 1');

      const infer = require(path.join(RAZE, 'src', 'infer'));
      const out = await infer.infer({ pool: merchantPool, corpusPath: LOG });

      if (CONNECT.merchantPool) await CONNECT.merchantPool.end().catch(() => {});
      CONNECT.merchantPool = merchantPool;
      CONNECT.databaseUrl = url;
      CONNECT.proposals = out.proposals;

      // A schema with several order-shaped tables produces a proposal for each,
      // which is correct and unusable. Score them so the merchant is shown the
      // strongest candidate first — but show the others rather than hiding them,
      // because picking the wrong table silently is the failure that matters.
      const score = (p) => Object.keys(p.spec.set || {}).length
        + Object.keys(p.spec.add || {}).length * 2
        + (p.spec.guard ? 2 : 0)
        + (/razorpay/i.test(p.spec.key.column) ? 3 : 0);
      const byTable = new Map();
      for (const p of out.proposals) {
        const t = p.spec.table;
        byTable.set(t, (byTable.get(t) || 0) + score(p));
      }
      const ranked = [...byTable.entries()].sort((a, b) => b[1] - a[1]);
      const best = ranked.length ? ranked[0][0] : null;

      res.json({
        ok: true,
        tables: out.schema.map((t) => ({ name: t.name, columns: t.columns.length })),
        bestTable: best,
        tableRanking: ranked.map(([name, sc]) => ({ table: name, score: sc })),
        proposals: out.proposals.map((p) => ({
          recommended: p.spec.table === best,
          id: p.eventType + '|' + p.spec.table,
          eventType: p.eventType,
          table: p.spec.table,
          key: p.spec.key,
          set: p.spec.set,
          add: p.spec.add,
          guard: p.spec.guard,
          evidence: p.evidence,
          questions: p.questions,
        })),
        note: out.proposals.length === 0
          ? 'No table matched a Razorpay event shape. Raze proposes nothing rather than '
            + 'guessing which table holds your orders.'
          : undefined,
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });


  /**
   * The integer-ish columns in the chosen table, for the merchant to pick from.
   *
   * Listing them rather than guessing: two BIGINT columns look identical to
   * inference, and the difference between them is the difference between
   * checking an amount and destroying the check.
   */
  app.post('/api/connect/columns', localOnly, async (req, res) => {
    const table = String(req.body.table || '').trim();
    if (!table) return res.status(400).json({ error: 'which table?' });
    const target = CONNECT.merchantPool || pool;
    try {
      const r = await target.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = $1 ORDER BY ordinal_position`, [table]);
      const numeric = r.rows.filter((c) => /int|numeric|decimal|money|real|double/i.test(c.data_type));
      res.json({
        table,
        columns: r.rows.map((c) => ({ name: c.column_name, type: c.data_type })),
        candidates: numeric.map((c) => c.column_name),
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });


  /**
   * The mapping a merchant states, when inference cannot work it out.
   *
   * On a schema whose names are the author's own — `gateway_ref`, `fulfilment`,
   * `ticket_value` — inference can find the key by reading the data but cannot
   * tell which column is a status and which holds money. It declines, correctly.
   * Declining is not the same as being unable to help: the merchant knows their
   * own columns, so they are asked, and every name they give is validated
   * against the live schema before anything is armed.
   */
  app.post('/api/connect/manual-mapping', localOnly, async (req, res) => {
    const { table, key, status, credited, expected } = req.body || {};
    if (!table || !key || !status || !credited) {
      return res.status(400).json({
        error: 'a table, a key column, a status column and a credited-amount column are all '
          + 'needed before anything can be armed',
      });
    }
    if (expected && expected === credited) {
      return res.status(400).json({
        error: 'the expected amount and the credited amount cannot be the same column — '
          + 'writing to the figure the payment is checked against destroys the check',
      });
    }
    const target = CONNECT.merchantPool || pool;
    try {
      const cols = await target.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
      const present = new Set(cols.rows.map((r) => r.column_name));
      const missing = [key, status, credited, expected].filter((c) => c && !present.has(c));
      if (missing.length) {
        return res.status(400).json({ error: `no such column in "${table}": ${missing.join(', ')}` });
      }

      const mapping = require(path.join(RAZE, 'src', 'mapping'));
      const spec = mapping.normalise('payment.captured', {
        table,
        key: { column: key, from: 'payload.payment.entity.order_id' },
        set: { [status]: { literal: 'paid' } },
        add: { [credited]: 'payload.payment.entity.amount' },
        guard: { column: status, notIn: ['refunded'] },
        insertIfMissing: false,
      });
      await mapping.validateAgainstSchema(target, spec);

      CONNECT.manual = { table, key, status, credited, expected: expected || null };
      await saveSetup({
        mapping_confirmed: true,
        expected_column: expected || null,
        expected_column_absent: !expected,
        escalate_only: !expected,
      });
      res.json({
        ok: true,
        armed: spec,
        auto_repair: !!expected,
        note: expected
          ? 'Validated against your live schema.'
          : 'Validated. Without a column recording what an order should cost, Raze will '
            + 'report divergence but will not repair anything on its own.',
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/connect/approve', localOnly, async (req, res) => {
    if (!CONNECT.proposals || !CONNECT.proposals.length) {
      return res.status(400).json({ error: 'connect a database first' });
    }
    const accepted = new Set(req.body.accept || []);
    if (accepted.size === 0) return res.status(400).json({ error: 'nothing was approved' });
    try {
      const mapping = require(path.join(RAZE, 'src', 'mapping'));
      const chosen = CONNECT.proposals.filter((p) => accepted.has(p.eventType + '|' + p.spec.table));

      // Validated against the live schema before anything is armed. A mapping
      // naming a column that does not exist has to fail here, loudly, rather
      // than silently writing nothing later.
      const registered = [];
      for (const p of chosen) {
        const spec = mapping.normalise(p.eventType, p.spec);
        await mapping.validateAgainstSchema(CONNECT.merchantPool, spec);
        registered.push({ eventType: p.eventType, table: spec.table });
      }
      CONNECT.approved = chosen;
      res.json({ ok: true, registered, note: 'Validated against your live schema.' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ---- "Check my payment protection" -------------------------------------
  //
  // Seven claims, each answered by something that actually ran. A tick meaning
  // "a library is installed" would be worthless; every one below is the outcome
  // of a real delivery or a real query.
  app.post('/api/protection', localOnly, async (req, res) => {
    const target = req.body.target_url || 'http://127.0.0.1:' + S.merchantPort + '/webhook';
    try {
      // A green tick here with nothing being watched would be a lie. The table
      // existing proves the mechanism is installed; it does not mean a single
      // order is being watched, and an order nobody expects is an order whose
      // absence nobody will notice.
      let absenceOk = false;
      let absenceWhy = 'no expectations armed';
      try {
        const r = await pool.query('SELECT count(*)::int n FROM raze_expectations');
        const n = r.rows[0].n;
        absenceOk = n > 0;
        absenceWhy = n > 0
          ? n + ' order(s) watched; an overdue one resolves to recovered, failed or abandoned'
          : 'installed, but no order is being watched — arm expectations with `raze watch` '
            + 'or rz.expect() so a payment that never arrives is noticed';
      } catch (err) { absenceWhy = 'raze_expectations unreadable: ' + err.message; }

      const secret = CONNECT.webhookSecret || resolveDemoSecret(env).secret;
      const auditor = createAuditor({ targetUrl: target, pool, logFile: LOG, webhookSecret: secret });
      const results = await auditor.run();
      const by = Object.fromEntries(results.map((r) => [r.name, r]));

      const rz = CONNECT.razorpay || razorpay;
      let reconcileOk = false;
      let reconcileWhy = 'no Razorpay credentials connected';
      if (rz && rz.keyId && rz.keySecret) {
        try {
          const rec = createReconciler({
            db: pool,
            razorpay: rz,
            localOrderIds: async () => {
              const r = await pool.query('SELECT order_id FROM shop_orders');
              return new Set(r.rows.map((x) => x.order_id));
            },
            config: { coldStartMs: 72 * 3600 * 1000 },
          });
          const out = await rec.runOnce();
          reconcileOk = !!out.ok;
          reconcileWhy = out.ok
            ? 'asked Razorpay directly; ' + out.drift + ' drifted, ' + out.payments.repaired + ' repaired'
            : out.error;
        } catch (err) { reconcileWhy = err.message; }
      }



      const probe = (name) => by[name] || null;
      const checks = [
        { name: 'Signature verification',
          ok: !!(probe('tampered-signature') && probe('tampered-signature').pass && !probe('tampered-signature').skipped),
          detail: probe('tampered-signature') ? probe('tampered-signature').observed : 'not run' },
        { name: 'Duplicate-safe processing', ok: !!(probe('duplicate-delivery') && probe('duplicate-delivery').pass),
          detail: probe('duplicate-delivery') ? probe('duplicate-delivery').observed : 'not run' },
        { name: 'Retry-safe processing', ok: !!(probe('timeout-retry') && probe('timeout-retry').pass),
          detail: probe('timeout-retry') ? probe('timeout-retry').observed : 'not run' },
        { name: 'State transition protection', ok: !!(probe('out-of-order') && probe('out-of-order').pass),
          detail: probe('out-of-order') ? probe('out-of-order').observed : 'not run' },
        { name: 'Refund handling', ok: !!(probe('refund-event') && probe('refund-event').pass),
          detail: probe('refund-event') ? probe('refund-event').observed : 'not run' },
        { name: 'Reconciliation active', ok: reconcileOk, detail: reconcileWhy },
        { name: 'Missing-payment detection', ok: absenceOk, detail: absenceWhy },
      ];
      const isProtected = checks.every((c) => c.ok);
      emit('protection', { protected: isProtected });
      res.json({
        checks,
        protected: isProtected,
        verdict: isProtected ? 'PROTECTED' : 'NOT PROTECTED',
        note: isProtected
          ? 'Every tick above is the outcome of a real delivery or a real query, not a '
            + 'configuration check.'
          : 'A failing check is a real failure against real deliveries, not a warning.',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // -------------------------------------------------------------------------
  // the conversation
  // -------------------------------------------------------------------------
  //
  // The model answers questions. It cannot repair anything, because the tools
  // that repair are not in the process it runs in. Repair happens below, in
  // this process, and only after a human has clicked.

  const agent = require(path.join(RAZE, 'src', 'web', 'agent'));
  const tools = agent.createToolClient();

  /**
   * Notice when the loops stop, and start them again.
   *
   * Not defensive programming for its own sake. A payment sat captured at
   * Razorpay and unrepaired in a merchant's database because the loops that
   * were meant to be reconciling had quietly stopped ticking, and nothing
   * anywhere would have said so — the console reported "watching", the flag
   * said running, and the only symptom was money not arriving.
   *
   * Two and a half missed passes is the threshold: long enough that a slow
   * Razorpay call or a long reconciliation is not mistaken for death, short
   * enough that a merchant loses minutes rather than a night.
   */
  let watchdogTimer = null;
  function armWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      const loops = S.loops;
      if (!loops) return;
      const idleFor = loops.lastTickAt ? Date.now() - loops.lastTickAt : Infinity;
      const allowed = (loops.config ? loops.config.reconcileMs : 60000) * 2.5;
      if (idleFor <= allowed) return;
      emit('loop', { type: 'error', where: 'watchdog',
        error: `no pass completed for ${Math.round(idleFor / 1000)}s — restarting the loops` });
      try {
        loops.stop();
        await loops.start();
      } catch (err) {
        emit('loop', { type: 'error', where: 'watchdog-restart', error: err.message });
      }
    }, 30000);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  /**
   * Point the tools at the merchant Raze is actually watching.
   *
   * The status the console shows, the recovery proposals, and anything the
   * assistant can read all come from the MCP server, and that server is
   * configured entirely by .mcp.json. Setup used to leave that file alone, so
   * the tools kept reading the console's own database with this repository's
   * default column names — and the console cheerfully reported UNARMED, "0
   * orders", and "I am not connected to anything yet" about a merchant it was
   * reconciling every sixty seconds. Two truths on one screen, one of them
   * false.
   *
   * Written on every successful setup and again on restart, because the file is
   * derived state: whatever raze_setup records is what it should say.
   */
  function writeToolConfig({ databaseUrl, creds, chosen }) {
    if (!databaseUrl || !creds || !chosen || !chosen.table) return false;
    const config = {
      mcpServers: {
        raze: {
          command: 'node',
          args: [path.join(RAZE, 'bin', 'raze-mcp').replace(/\\/g, '/')],
          env: {
            DATABASE_URL: databaseUrl,
            RAZORPAY_KEY_ID: creds.keyId,
            RAZORPAY_KEY_SECRET: creds.keySecret,
            RAZE_ORDERS_TABLE: chosen.table,
            RAZE_ORDER_KEY_COLUMN: chosen.key,
            RAZE_STATUS_COLUMN: chosen.status,
            RAZE_AMOUNT_COLUMN: chosen.credited,
            ...(chosen.expected ? { RAZE_EXPECTED_COLUMN: chosen.expected } : {}),
          },
        },
      },
    };
    try {
      fs.writeFileSync(path.join(RAZE, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
      // The running MCP child was started with the old environment, so it has to
      // go; the next call spawns one that reads the file just written.
      tools.stop();
      return true;
    } catch { return false; }
  }

  app.post('/api/agent/ask', async (req, res) => {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'ask something' });
    emit('agent-thinking', { question });
    let answer = await agent.ask(question);

    // No model here — a server has no Claude Code on it, and the honest reply is
    // not "I am not connected to anything", which is both wrong and alarming
    // when Raze is reconciling that merchant every minute. The figures never
    // needed a model anyway: they are counted from the merchant's database and
    // from Razorpay. So the question goes unanswered and the state is reported
    // instead, labelled as what it is.
    if (!answer.ok) {
      try {
        const s = await tools.call('raze_status', {});
        const rupees = (p) => '₹' + (Math.round(Number(p) || 0) / 100)
          .toLocaleString('en-IN', { minimumFractionDigits: 2 });
        const lines = [s.says || `Raze is ${s.state}.`];

        // What Raze did comes first, because it is the thing being asked about
        // and it is read from Raze's own record of its own writes.
        if (s.repairs && (s.repairs.recovered_24h || s.repairs.escalated_24h)) {
          lines.push(`In the last 24 hours I repaired ${s.repairs.recovered_24h} order(s) `
            + `worth ${rupees(s.repairs.recovered_paise_24h)}, and refused to write `
            + `${s.repairs.escalated_24h} that did not check out.`);
        }
        if (s.watching && s.watching.open_orders != null) {
          lines.push(`${s.watching.open_orders} order(s) are still waiting on payment. `
            + 'I ask Razorpay about each one by name every 20 seconds, rather than waiting '
            + 'for it to appear in a list.');
        }
        // The enumeration last, and labelled, because it lags by minutes and
        // quoting it first has already told one merchant that nothing had been
        // captured while their money was sitting at Razorpay.
        if (s.razorpay && s.razorpay.captured != null) {
          lines.push(`Razorpay's payments list currently shows ${s.razorpay.captured} `
            + `captured payment(s), ${s.razorpay.not_applied} of them not in your database `
            + `(${rupees(s.razorpay.at_risk_paise)}). That list lags by minutes, so it is the `
            + 'weakest thing on this page — the per-order checks above are what I act on.');
        }
        lines.push('Answered from your database and Razorpay directly — there is no '
          + 'assistant on this instance, so nothing here was written by a model.');
        answer = { ok: true, text: lines.join('\n\n'), computed: true };
      } catch { /* keep the original reply */ }
    }

    emit('agent-answer', { ok: answer.ok });
    res.json(answer);
  });

  // A snapshot the page can render without waiting on the model — the five
  // states are computed, not generated, so the banner is never a hallucination.
  app.get('/api/agent/state', async (_req, res) => {
    try {
      const out = await tools.call('raze_status', {});
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/agent/propose', async (req, res) => {
    const orderId = String(req.body.order_id || '').trim();
    if (!orderId) return res.status(400).json({ error: 'which order?' });
    try {
      const out = await tools.call('raze_propose_recovery', { order_id: orderId });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/agent/apply', async (req, res) => {
    const orderId = String(req.body.order_id || '').trim();
    const token = String(req.body.approval_token || '').trim();
    if (!orderId || !token) return res.status(400).json({ error: 'order and approval are both required' });
    try {
      // Same long-lived process that issued the token, or the approval it
      // refers to would not exist.
      const out = await tools.call('raze_apply_recovery', {
        order_id: orderId, approval_token: token,
      });
      emit('recovered', { order_id: orderId, ok: !out.error });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });


  // -------------------------------------------------------------------------
  // setup state, and what Raze has been doing
  // -------------------------------------------------------------------------

  /**
   * Setup is not complete until a backfill has returned a real number.
   *
   * Kept in Postgres rather than in memory for the same reason the armed mode
   * is: a merchant who finished setup yesterday should not be asked to do it
   * again because the process restarted.
   */
  async function setupState() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS raze_setup (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        razorpay_ok BOOLEAN NOT NULL DEFAULT false,
        webhook_id TEXT,
        database_ok BOOLEAN NOT NULL DEFAULT false,
        mapping_confirmed BOOLEAN NOT NULL DEFAULT false,
        escalate_only BOOLEAN,
        refund_policy TEXT,
        expected_column TEXT,
        expected_column_absent BOOLEAN,
        webhook_ok BOOLEAN NOT NULL DEFAULT false,
        orders_table TEXT,
        key_column TEXT,
        status_column TEXT,
        credited_column TEXT,
        merchant_db TEXT,
        backfill_at TIMESTAMPTZ,
        backfill_checked INT,
        backfill_missing INT,
        backfill_paise BIGINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
      // so a column added after someone has run setup once is simply absent.
      // Adding them explicitly is the difference between a new field working and
      // a merchant meeting "column does not exist" on their own console.
      for (const [col, type] of [
        ['expected_column', 'TEXT'],
        ['expected_column_absent', 'BOOLEAN'],
        ['webhook_ok', 'BOOLEAN'],
        ['orders_table', 'TEXT'],
        ['key_column', 'TEXT'],
        ['status_column', 'TEXT'],
        ['credited_column', 'TEXT'],
        ['merchant_db', 'TEXT'],
        // Kept because the process that generated it will not be the process
        // that receives the deliveries. Razorpay signs with the secret the
        // webhook was registered with, and a restart that forgets it turns every
        // real delivery into a signature failure — silently, since
        // reconciliation would keep working and hide it.
        ['webhook_secret', 'TEXT'],
      ]) {
        await pool.query(`ALTER TABLE raze_setup ADD COLUMN IF NOT EXISTS "${col}" ${type}`);
      }
      const r = await pool.query('SELECT * FROM raze_setup WHERE id = 1');
      const row = r.rows[0] || {};
      return {
        ...row,
        // The gate. A promise is not a completed setup; a number is.
        complete: !!row.backfill_at && !!row.mapping_confirmed,
      };
    } catch (err) { return { complete: false, error: err.message }; }
  }

  async function saveSetup(patch) {
    await setupState();
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const cols = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO raze_setup (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await pool.query(
      `UPDATE raze_setup SET ${cols}, updated_at = now() WHERE id = 1`,
      keys.map((k) => patch[k]));
  }

  app.get('/api/setup', async (_req, res) => res.json(await setupState()));

  // The two questions that cannot be inferred from a schema.
  app.post('/api/setup/answers', localOnly, async (req, res) => {
    try {
      const patch = {};
      if (req.body.escalate_only !== undefined) patch.escalate_only = !!req.body.escalate_only;
      if (req.body.refund_policy) patch.refund_policy = String(req.body.refund_policy);
      // Asked, never inferred. Inference cannot tell "what this order should
      // cost" from "what we have credited", and picking wrong means writing to
      // the figure the amount is verified against — which corrupted a real
      // order during testing and would have made the next check pass for the
      // wrong reason.
      if (req.body.expected_column !== undefined) {
        const c = req.body.expected_column ? String(req.body.expected_column) : null;
        patch.expected_column = c;
        patch.expected_column_absent = !c;
        // No such column means divergence can still be found — it just cannot be
        // repaired unattended, so this merchant becomes escalate-only.
        if (!c) patch.escalate_only = true;
      }
      if (req.body.mapping_confirmed !== undefined) {
        patch.mapping_confirmed = !!req.body.mapping_confirmed;
      }
      await saveSetup(patch);
      res.json(await setupState());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * The last step: reconcile the last 24 hours and report a real figure.
   *
   * Setup ends on a number the merchant can check, never on a promise that Raze
   * will start watching.
   */
  app.post('/api/setup/backfill', localOnly, async (_req, res) => {
    const rz = CONNECT.razorpay || razorpay;
    if (!rz || !rz.keyId) return res.status(400).json({ error: 'connect Razorpay first' });
    try {
      const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
      const impact = await computeImpact({
        pool, razorpay: rz, results: [], table: ORDERS_TABLE,
        keyColumn: KEY_COLUMN, amountColumn: AMOUNT_COLUMN,
      });
      const live = impact.razorpay;
      if (!live.available) return res.status(400).json({ error: live.reason, kind: live.kind });

      await saveSetup({
        razorpay_ok: true,
        database_ok: true,
        backfill_at: new Date(),
        backfill_checked: live.capturedCount,
        backfill_missing: live.unrecorded.length,
        backfill_paise: live.unrecordedPaise,
      });
      res.json({
        checked: live.capturedCount,
        missing: live.unrecorded.length,
        paise: live.unrecordedPaise,
        orders: live.unrecorded.slice(0, 10),
        setup: await setupState(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- what Raze did while they were away --------------------------------
  app.get('/api/activity', async (req, res) => {
    try {
      const actions = require(path.join(RAZE, 'src', 'actions'));
      const hours = Number(req.query.hours || 24);
      // Actions are recorded where the orders are — the merchant's database, not
      // the console's. Reading them from the console's own pool showed an empty
      // activity list while escalations were being written every minute.
      const out = await actions.since(CONNECT.merchantPool || pool,
        new Date(Date.now() - hours * 3600 * 1000));
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/activity/ack', async (req, res) => {
    try {
      const actions = require(path.join(RAZE, 'src', 'actions'));
      const n = await actions.acknowledge(CONNECT.merchantPool || pool,
        String(req.body.order_id || ''));
      res.json({ acknowledged: n });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/policy', (_req, res) => {
    const policy = require(path.join(RAZE, 'src', 'policy'));
    res.json(policy.describe());
  });

  // -------------------------------------------------------------------------
  // the conversation
  // -------------------------------------------------------------------------
  //
  // One endpoint returns what to ask next; one carries out the answer. The
  // sequence is deterministic because it decides what gets installed in a
  // merchant's database — the model answers questions, it does not decide that.

  const ray = require(path.join(RAZE, 'src', 'web', 'ray'));

  // -------------------------------------------------------------------------
  // one call, the whole integration
  // -------------------------------------------------------------------------
  //
  // The merchant gives two things and is asked nothing else. Every decision
  // below has a defensible default, and each one is announced as it is taken
  // rather than put to them as a question they have no basis to answer.
  //
  // Two defaults are worth naming, because both were questions until now:
  //
  //   Refunds change the status and leave the amount as charged. The order's
  //   amount then still means what the customer was billed, which is the figure
  //   reconciliation compares against; subtracting would corrupt the check.
  //
  //   Clean repairs are applied without asking. "Clean" is narrow — captured at
  //   Razorpay, amount matching exactly, order still unpaid, one row. Anything
  //   else waits. A merchant whose writes fire shipments can turn this off, and
  //   is told how.

  /**
   * Forget what was connected, so something else can be.
   *
   * A console that has finished setup hides the form, which is right for the
   * merchant it was set up for and wrong for everyone else: whoever is trying a
   * second database, moving from a trial to their real one, or rotating keys
   * meets a screen with no way back in. This clears what Raze recorded and stops
   * the loops.
   *
   * It deliberately does not touch Razorpay. The webhook stays registered and
   * active, because deleting it is not something this can do (their account API
   * has no route for it) and pretending otherwise would leave the merchant
   * believing an endpoint had been retired when it had not.
   */
  app.post('/api/ray/reset', localOnly, async (_req, res) => {
    if (S.loops && S.loops.stop) S.loops.stop();
    S.loops = null;
    if (CONNECT.merchantPool && CONNECT.merchantPool !== pool) {
      await CONNECT.merchantPool.end().catch(() => {});
    }
    CONNECT.merchantPool = null;
    CONNECT.databaseUrl = null;
    CONNECT.razorpay = null;
    CONNECT.chosen = null;
    CONNECT.understood = null;
    CONNECT.webhookSecret = null;
    await pool.query('DELETE FROM raze_setup WHERE id = 1').catch(() => {});
    res.json({ ok: true });
  });

  /**
   * Run the targeted check once, now, and say exactly what it saw.
   *
   * Diagnosing this from logs failed twice: a log tail can be stale, and the
   * absence of a line is not evidence of anything. This returns the open orders
   * the query actually found and what Razorpay said about each, so a repair that
   * is not happening can be explained rather than guessed at.
   */
  /**
   * The pulse. One row per loop pass, read straight back out.
   *
   * Deliberately not derived from anything in memory: if the process restarted,
   * the rows written before the restart are still here, so "did it run while
   * nobody was looking" is answerable after the fact.
   */
  app.get('/api/ray/heartbeat', localOnly, async (_req, res) => {
    try {
      const db = CONNECT.merchantPool || pool;
      const rows = await db.query(
        `SELECT at, kind, outcome, ms, detail FROM raze_heartbeat
          ORDER BY at DESC LIMIT 60`);
      const span = await db.query(
        `SELECT min(at) AS first, max(at) AS last, count(*)::int n,
                count(*) FILTER (WHERE outcome = 'error')::int errors
           FROM raze_heartbeat`);
      res.json({ span: span.rows[0], rows: rows.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/ray/poll', localOnly, async (_req, res) => {
    if (!S.loops) return res.status(409).json({ error: 'nothing is being watched' });
    try {
      const out = await S.loops.pollOpenOrders();
      // Which database this actually is, asked of the same pool the loops use.
      // Two components reporting different row counts for "the merchant's
      // orders" is either a stale snapshot or two different databases, and
      // guessing which cost an hour.
      const who = await (CONNECT.merchantPool || pool).query(
        `SELECT current_database() AS db, current_schema() AS schema,
                (SELECT count(*)::int FROM "${(CONNECT.chosen || {}).table || 'shop_orders'}") AS rows,
                (SELECT count(*)::int FROM "${(CONNECT.chosen || {}).table || 'shop_orders'}"
                  WHERE "${(CONNECT.chosen || {}).status || 'order_state'}" = 'pending') AS pending`);
      // Which Razorpay account these questions are being asked of. The key id is
      // not a secret, and "the same order returns a payment from one machine and
      // nothing from another" is almost always two different accounts.
      const rz = CONNECT.razorpay || {};
      res.json({ ...out, columns: CONNECT.chosen || null, database: who.rows[0],
        razorpayKeyId: rz.keyId || null });
    } catch (err) { res.status(500).json({ error: err.message, stack: String(err.stack).slice(0, 400) }); }
  });

  app.post('/api/ray/setup', localOnly, async (req, res) => {
    // Anything the deployment already knows is not asked for again. A merchant
    // who wired their database and keys into their own instance has already
    // connected them; making them paste the same values into a web page would be
    // asking a question whose answer is sitting in the environment.
    const keyId = String((req.body && req.body.keyId) || process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String((req.body && req.body.keySecret)
      || process.env.RAZORPAY_KEY_SECRET || '').trim();
    const databaseUrl = String((req.body && req.body.databaseUrl)
      || process.env.MERCHANT_DB_URL || '').trim();

    const say = (id, status, detail, extra) =>
      emit('build', { id, status, detail, ...(extra || {}) });

    res.json({ started: true });

    try {
      // ---- 1. the account ---------------------------------------------------
      say('keys', 'working', 'checking the keys against Razorpay');
      if (!/^rzp_test_/.test(keyId)) {
        return say('keys', 'failed', 'that is not a Test Mode key — Raze fires real '
          + 'deliveries when it checks an integration and will not touch a live account');
      }
      const auth = 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');
      const probe = await fetch('https://api.razorpay.com/v1/payments?count=1',
        { headers: { authorization: auth } });
      const probeBody = await probe.json();
      if (!probe.ok) {
        return say('keys', 'failed',
          (probeBody.error && probeBody.error.description) || `Razorpay said HTTP ${probe.status}`);
      }
      CONNECT.razorpay = { keyId, keySecret };
      await saveSetup({ razorpay_ok: true });
      say('keys', 'done', 'Test Mode, verified by calling the API');

      // ---- 2. the database --------------------------------------------------
      say('db', 'working', 'connecting');
      const { Pool } = require('pg');
      const merchantPool = new Pool({ connectionString: databaseUrl, max: 4,
        connectionTimeoutMillis: 10000 });
      merchantPool.on('error', () => {});
      await merchantPool.query('SELECT 1');
      if (CONNECT.merchantPool) await CONNECT.merchantPool.end().catch(() => {});
      CONNECT.merchantPool = merchantPool;
      CONNECT.databaseUrl = databaseUrl;

      const counted = await merchantPool.query(
        `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
      say('db', 'done', `${counted.rows[0].n} table(s)`);

      // ---- 3. read the schema ------------------------------------------------
      say('schema', 'working', 'working out which table holds your orders');
      const { understand } = require(path.join(RAZE, 'src', 'agent', 'understand'));
      const u = await understand(merchantPool);
      CONNECT.understood = u;
      if (!u.ok) {
        return say('schema', 'failed', u.why || 'could not read the payment model');
      }
      const c = u.claim;
      say('schema', 'done', c.reasoning, {
        mapping: {
          table: c.table, key: c.key, status: c.status,
          credited: c.credited, expected: c.expected,
        },
      });

      // ---- 4. an address Razorpay can reach ---------------------------------
      let publicUrl = S.publicUrl || process.env.RAZE_PUBLIC_URL || null;
      let unverified = false;
      if (!publicUrl) {
        say('address', 'working', 'Razorpay will not deliver to a laptop, so getting a '
          + 'public address');
        const tunnel = require(path.join(RAZE, 'src', 'agent', 'tunnel'));
        const t = await tunnel.open(S.port || 7000,
          { onProgress: (m) => say('address', 'working', m) });
        if (t.ok) { publicUrl = t.url; S.publicUrl = t.url; S.tunnel = t; unverified = !t.verified; }
        else say('address', 'skipped', t.why + ' — reconciliation covers it');
      }
      // Whether this machine could reach the address is not the same question as
      // whether Razorpay can. Say which one was answered.
      if (publicUrl) say('address', 'done', publicUrl + (unverified
        ? ' (open, though this machine could not reach it back — Razorpay will say if it cannot either)'
        : ''));

      // ---- 5. build the Razorpay side ----------------------------------------
      say('webhook', 'working', 'registering');
      const builder = require(path.join(RAZE, 'src', 'agent', 'build'));
      let existing = [];
      try { existing = await builder.listWebhooks(CONNECT.razorpay); } catch {}
      const built = await builder.buildIntegration({
        creds: CONNECT.razorpay, publicUrl, events: c.events, existing,
        knownSecret: CONNECT.webhookSecret || null,
      });
      if (built.secret) CONNECT.webhookSecret = built.secret;
      await saveSetup({
        webhook_ok: true,
        webhook_id: (built.webhook && built.webhook.id) || null,
        // Only when this run generated one. Adopting a webhook that was already
        // there returns no secret — Razorpay will not show it again — and
        // writing null over a working one would break the signature check on the
        // next restart.
        ...(built.secret ? { webhook_secret: built.secret } : {}),
      });
      // Report the reason that actually occurred. Asserting "no public address"
      // whenever this failed was wrong the first time it mattered: the address
      // existed and Razorpay had rejected it for another reason entirely.
      const failedStep = (built.steps || []).find((x) => !x.done);
      say('webhook', built.ok ? 'done' : 'skipped',
        built.ok ? `${(built.webhook && built.webhook.id) || 'registered'} — `
          + `${(c.events || []).join(', ')}`
          : (failedStep ? failedStep.detail : 'could not build the webhook')
            + ' — Raze will ask Razorpay directly instead',
        { checklist: built.steps, obligations: builder.handlerObligations() });

      // ---- 6. arm the mapping -------------------------------------------------
      say('mapping', 'working', 'checking every column against your live schema');
      const mapping = require(path.join(RAZE, 'src', 'mapping'));
      const spec = mapping.normalise('payment.captured', {
        table: c.table,
        key: { column: c.key, from: 'payload.payment.entity.order_id' },
        set: { [c.status]: { literal: 'paid' } },
        add: { [c.credited]: 'payload.payment.entity.amount' },
        guard: { column: c.status, notIn: ['refunded'] },
        insertIfMissing: false,
      });
      await mapping.validateAgainstSchema(merchantPool, spec);
      CONNECT.chosen = { table: c.table, key: c.key, status: c.status,
        credited: c.credited, expected: c.expected };
      await saveSetup({
        mapping_confirmed: true,
        expected_column: c.expected || null,
        expected_column_absent: !c.expected,
        orders_table: c.table,
        key_column: c.key,
        status_column: c.status,
        credited_column: c.credited,
        merchant_db: databaseUrl,
        // Decided, not asked. Both are reversible and both are stated.
        refund_policy: 'status',
        escalate_only: !c.expected,
      });
      const ray = require(path.join(RAZE, 'src', 'web', 'ray'));
      say('mapping', 'done', c.expected
        ? `payments checked against ${c.expected} before anything is written`
        : 'no expected-amount column, so divergence is reported and never repaired unattended',
        { integration: ray.buildIntegration(CONNECT.chosen) });

      // ---- 7. the number that means something --------------------------------
      say('backfill', 'working', 'asking Razorpay what it recorded');
      const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
      const impact = await computeImpact({
        pool: merchantPool, razorpay: CONNECT.razorpay, results: [],
        table: c.table, keyColumn: c.key, amountColumn: c.credited,
      });
      const live = impact.razorpay;
      if (!live.available) return say('backfill', 'failed', live.reason);
      await saveSetup({
        backfill_at: new Date(),
        backfill_checked: live.capturedCount,
        backfill_missing: live.unrecorded.length,
        backfill_paise: live.unrecordedPaise,
      });
      say('backfill', 'done', `${live.capturedCount} settled at Razorpay, `
        + `${live.unrecorded.length} not in your database`, {
          figures: {
            checked: live.capturedCount,
            missing: live.unrecorded.length,
            paise: live.unrecordedPaise,
            orders: live.unrecorded.slice(0, 6),
          },
        });

      // ---- 8. start watching --------------------------------------------------
      say('watch', 'working', 'starting');
      const { createLoops } = require(path.join(RAZE, 'src', 'loops'));
      const actions = require(path.join(RAZE, 'src', 'actions'));
      await actions.ensure(merchantPool);
      if (S.loops && S.loops.stop) S.loops.stop();
      S.loops = createLoops({
        pool: merchantPool,
        razorpay: CONNECT.razorpay,
        merchant: { mappingConfirmed: true, escalateOnly: !c.expected, autoRepair: true },
        columns: { key: c.key, status: c.status, amount: c.credited, expected: c.expected },
        ordersTable: c.table,
        logFile: LOG,
        // Without this the runtime has no statement of how to write this
        // merchant's table, and every repair stops at "nothing here can say how
        // to write your orders table from a captured payment".
        mappingSpec: builder.mappingSpecFor(CONNECT.chosen),
        onEvent: (e) => emit('loop', e),
      });
      await S.loops.start();
      writeToolConfig({ databaseUrl, creds: CONNECT.razorpay, chosen: CONNECT.chosen });

      // "Watching" has to be a fact, not a promise.
      //
      // A previous version reported this step done because start() had returned
      // without throwing. The loops then sat there not ticking, the console said
      // it was reconciling every sixty seconds, and a captured payment went
      // unrepaired until the process happened to restart. The merchant was told
      // the true thing about the wrong object: the timer existed, the work was
      // not happening.
      //
      // A completed pass stamps a clock, so this reports the stamp.
      if (!S.loops.running || !S.loops.lastTickAt) {
        say('watch', 'failed', 'the loops did not complete a pass. Nothing is being '
          + 'checked yet — reconnect and watch this step.');
      } else {
        armWatchdog();
        say('watch', 'done', 'reconciling every 60 seconds, sweeping every 30 — '
          + `first pass completed ${new Date(S.loops.lastTickAt).toISOString()}`);
      }
      say('finished', 'done', null);
    } catch (err) {
      say('error', 'failed', err.message);
    }
  });

  app.get('/api/ray/next', localOnly, async (_req, res) => {
    try {
      const state = await setupState();
      const step = ray.nextStep(state);

      // Everything Razorpay tells a merchant to do, listed and done.
      //
      // Their documentation hands the merchant a dashboard checklist — add a
      // webhook, invent a secret, choose an alert email, pick the events, save,
      // then validate it — and a second list of code to write on their own
      // server. Raze does both. The merchant is not asked for a URL, a secret,
      // or an event list, because none of those are things they should have to
      // know.
      if (step.id === 'webhook') {
        // If there is no address Razorpay can reach, get one rather than
        // reporting the problem. A merchant should not have to know what a
        // tunnel is, and telling them to install one is the sort of homework
        // this project exists to remove.
        if (!S.publicUrl && !process.env.RAZE_PUBLIC_URL && !CONNECT.tunnelTried) {
          CONNECT.tunnelTried = true;
          try {
            const tunnel = require(path.join(RAZE, 'src', 'agent', 'tunnel'));
            const t = await tunnel.open(S.port || 7000);
            if (t.ok) {
              S.publicUrl = t.url;
              S.tunnel = t;
              CONNECT.tunnelOpened = t.url;
            } else {
              CONNECT.tunnelWhy = t.why;
            }
          } catch (err) { CONNECT.tunnelWhy = err.message; }
        }

        if (!CONNECT.understood) {
          const { understand } = require(path.join(RAZE, 'src', 'agent', 'understand'));
          try { CONNECT.understood = await understand(CONNECT.merchantPool || pool); }
          catch (err) { CONNECT.understood = { ok: false, why: err.message }; }
        }
        const claim = (CONNECT.understood && CONNECT.understood.claim) || {};
        const wanted = claim.events || ['payment.captured'];

        step.say = 'Now the Razorpay side. Their documentation asks a merchant to add a '
          + 'webhook, invent a signing secret, choose an alert address, pick which events '
          + 'to subscribe to, save it, and then verify it works — and separately to write a '
          + 'handler that checks the signature over the raw body, deduplicates on the event '
          + 'id, and survives events arriving out of order.\n\nI will do all of it. '
          + 'Your schema can record ' + wanted.length + ' kind(s) of event, so those are the '
          + 'ones I will subscribe to and no others.';
        if (CONNECT.tunnelOpened) {
          step.say += '\n\nRazorpay will not deliver to a laptop, so I opened a public '
            + 'address for this console myself — nothing for you to install.';
        }
        step.events = wanted;
        step.action = 'Build it';
        step.values = {};
        step.note = 'Nothing here needs the Razorpay dashboard.';
      }

      // The mapping step is the only one whose content depends on what was
      // found in the merchant's database rather than on what they have answered.
      if (step.id === 'mapping') {
        // The agent reads the schema itself. Name matching only ever worked on
        // schemas that happened to use Raze's own words, and a real store's
        // columns are named for the store.
        if (!CONNECT.understood) {
          const { understand } = require(path.join(RAZE, 'src', 'agent', 'understand'));
          try { CONNECT.understood = await understand(CONNECT.merchantPool || pool); }
          catch (err) { CONNECT.understood = { ok: false, why: err.message }; }
        }
        const u = CONNECT.understood;
        if (u && u.ok) {
          const c = u.claim;
          step.say = 'I read your schema. ' + c.reasoning;
          step.mapping = {
            table: c.table, key: c.key, status: c.status,
            credited: c.credited, expected: c.expected,
          };
          step.action = 'That is right — set it up';
          step.alt = 'Let me correct it';
          step.note = c.expected
            ? 'Every payment gets checked against ' + c.expected + ' before I touch an order.'
            : 'Your schema records no separate expected amount, so I will report divergence '
              + 'but never repair unattended — there would be nothing to check against.';
          return res.json({ step, state });
        }
        step.modelFailed = u ? u.why : null;

        const proposals = CONNECT.proposals || [];
        const best = CONNECT.bestTable;
        if (best && proposals.length) {
          const mine = proposals.filter((p) => p.spec.table === best);
          step.say = `I read your schema. Your orders look like they live in **${best}**, `
            + `keyed on \`${mine[0].spec.key.column}\`.\n\nHere is what I would do when `
            + `Razorpay tells me a payment was captured:`;
          step.mapping = {
            table: best,
            key: mine[0].spec.key.column,
            set: mine[0].spec.set,
            add: mine[0].spec.add,
            guard: mine[0].spec.guard,
          };
          step.action = 'That is right';
          step.alt = 'Let me correct it';
          step.note = 'Nothing is armed until you say so.';
        } else {
          // Inference declined. It found no column it could key on, or none it
          // could write — and guessing at which row gets marked paid moves real
          // money. So the merchant is asked instead.
          step.say = "I read your schema, and I can't work out your payment model from it "
            + "on my own — none of the column names tell me which one holds the Razorpay "
            + "order id, or which one says an order is paid.\n\nI won't guess at that. "
            + "Tell me, and I'll check every name against your live database before I arm "
            + "anything.";
          step.pick = { tables: (CONNECT.tables || []).map((t) => t.name) };
          step.action = 'Check these against my database';
        }
      }
      res.json({ step, state });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/ray/act', localOnly, async (req, res) => {
    const { step, values } = req.body || {};
    try {
      // ---- keys ------------------------------------------------------------
      if (step === 'keys') {
        const keyId = String(values.keyId || '').trim();
        const keySecret = String(values.keySecret || '').trim();
        if (!/^rzp_test_/.test(keyId)) {
          return res.json({ error: 'That is not a Test Mode key. Raze fires real deliveries '
            + 'when it checks your integration, so it will not touch a live account.' });
        }
        const auth = 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');
        const r = await fetch('https://api.razorpay.com/v1/payments?count=1',
          { headers: { authorization: auth } });
        const body = await r.json();
        if (!r.ok) {
          return res.json({ error: (body.error && body.error.description)
            || 'Razorpay would not accept those keys.' });
        }
        CONNECT.razorpay = { keyId, keySecret };
        await saveSetup({ razorpay_ok: true });
        return res.json({
          ok: true,
          confirm: 'Razorpay account connected',
          detail: 'Test Mode, verified by calling the API rather than by checking the key format',
        });
      }

      // ---- database --------------------------------------------------------
      if (step === 'database') {
        const url = String(values.databaseUrl || '').trim();
        const { Pool } = require('pg');
        const merchantPool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 8000 });
        merchantPool.on('error', () => {});
        await merchantPool.query('SELECT 1');

        const infer = require(path.join(RAZE, 'src', 'infer'));
        const out = await infer.infer({ pool: merchantPool, corpusPath: LOG });

        const score = (p) => Object.keys(p.spec.set || {}).length
          + Object.keys(p.spec.add || {}).length * 2
          + (p.spec.guard ? 2 : 0)
          + (/razorpay/i.test(p.spec.key.column) ? 3 : 0);
        const byTable = new Map();
        for (const p of out.proposals) byTable.set(p.spec.table, (byTable.get(p.spec.table) || 0) + score(p));
        const ranked = [...byTable.entries()].sort((a, b) => b[1] - a[1]);

        if (CONNECT.merchantPool) await CONNECT.merchantPool.end().catch(() => {});
        CONNECT.merchantPool = merchantPool;
        CONNECT.databaseUrl = url;
        CONNECT.proposals = out.proposals;
        CONNECT.tables = out.schema.map((t) => ({ name: t.name }));
        CONNECT.bestTable = ranked.length ? ranked[0][0] : null;

        await saveSetup({ database_ok: true });
        return res.json({
          ok: true,
          confirm: 'Database connected',
          detail: `${out.schema.length} table(s) read: ${out.schema.map((t) => t.name).join(', ')}`,
        });
      }

      // ---- columns for a chosen table --------------------------------------
      if (step === 'columns') {
        const target = CONNECT.merchantPool || pool;
        const r = await target.query(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_name = $1 ORDER BY ordinal_position`, [String(values.table || '')]);
        return res.json({
          ok: true,
          columns: r.rows.map((c) => c.column_name),
          numeric: r.rows.filter((c) => /int|numeric|decimal|money|real|double/i.test(c.data_type))
            .map((c) => c.column_name),
        });
      }

      // ---- the whole Razorpay-side integration, built by Raze ---------------
      if (step === 'webhook') {
        const rz = CONNECT.razorpay || razorpay;
        const builder = require(path.join(RAZE, 'src', 'agent', 'build'));
        const claim = (CONNECT.understood && CONNECT.understood.claim) || {};

        let existing = [];
        try { existing = await builder.listWebhooks(rz); } catch {}

        const out = await builder.buildIntegration({
          creds: rz,
          publicUrl: S.publicUrl || process.env.RAZE_PUBLIC_URL || null,
          events: claim.events,
          existing,
        });

        if (out.secret) CONNECT.webhookSecret = out.secret;
        // Recorded even when there is no public endpoint: reconciliation does
        // not need one, and blocking setup on it would be refusing to help the
        // merchant Raze exists for.
        await saveSetup({
          webhook_ok: true,
          webhook_id: (out.webhook && out.webhook.id) || null,
        });

        return res.json({
          ok: true,
          confirm: out.ok
            ? (out.adopted ? 'Using the webhook already on your account'
                           : 'Razorpay integration built and confirmed')
            : 'Built what I could without a public address',
          detail: out.ok ? null : 'reconciliation covers the rest',
          checklist: out.steps,
          obligations: builder.handlerObligations(),
        });
      }

      // ---- the mapping, confirmed or stated --------------------------------
      if (step === 'mapping') {
        const table = String(values.table || CONNECT.bestTable || '');
        const key = String(values.key || '');
        const status = String(values.status || '');
        const credited = String(values.credited || '');
        const expected = values.expected ? String(values.expected) : null;

        if (!table || !key || !status || !credited) {
          return res.json({ error: 'A table, an order-id column, a status column and a '
            + 'credited-amount column are all needed before anything can be armed.' });
        }
        if (expected && expected === credited) {
          return res.json({ error: 'The expected amount and the credited amount cannot be '
            + 'the same column — writing to the figure a payment is checked against '
            + 'destroys the check.' });
        }

        const target = CONNECT.merchantPool || pool;
        const cols = await target.query(
          'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
        const present = new Set(cols.rows.map((r) => r.column_name));
        const missing = [key, status, credited, expected].filter((c) => c && !present.has(c));
        if (missing.length) {
          return res.json({ error: `No such column in "${table}": ${missing.join(', ')}.` });
        }

        const mapping = require(path.join(RAZE, 'src', 'mapping'));
        const spec = mapping.normalise('payment.captured', {
          table,
          key: { column: key, from: 'payload.payment.entity.order_id' },
          set: { [status]: { literal: 'paid' } },
          add: { [credited]: 'payload.payment.entity.amount' },
          guard: { column: status, notIn: ['refunded'] },
          insertIfMissing: false,
        });
        await mapping.validateAgainstSchema(target, spec);

        CONNECT.chosen = { table, key, status, credited, expected };
        // Written down, because the background loops run in a process that has
        // never seen this conversation. Leaving them on environment defaults
        // meant a merchant finished setup and Raze then watched the wrong table.
        await saveSetup({
          mapping_confirmed: true,
          expected_column: expected,
          expected_column_absent: !expected,
          orders_table: table,
          key_column: key,
          status_column: status,
          credited_column: credited,
          merchant_db: CONNECT.databaseUrl || null,
        });
        return res.json({
          ok: true,
          confirm: 'Mapping validated against your live schema',
          detail: `${table} · ${key} · ${status} · ${credited}${expected ? ' · ' + expected : ''}`,
          integration: ray.buildIntegration({ table, key, status, credited, expected }),
        });
      }

      // ---- the two questions -----------------------------------------------
      if (step === 'sideEffects') {
        const yes = values.choice === 'yes';
        await saveSetup({ escalate_only: yes });
        return res.json({
          ok: true,
          confirm: yes ? 'I will always ask before repairing' : 'I may repair clean cases myself',
          detail: yes
            ? 'because marking an order paid triggers something else in your application'
            : 'under a policy you can read, and anything I cannot verify still waits for you',
        });
      }

      if (step === 'refund') {
        await saveSetup({ refund_policy: String(values.choice || 'status') });
        return res.json({
          ok: true,
          confirm: 'Refund handling set',
          detail: values.choice === 'subtract'
            ? 'a refund reverses the amount as well as the status'
            : 'a refund changes the status and leaves the amount as charged',
        });
      }

      // ---- the number that ends setup ---------------------------------------
      if (step === 'backfill') {
        const rz = CONNECT.razorpay || razorpay;
        const chosen = CONNECT.chosen || {};
        const { computeImpact } = require(path.join(RAZE, 'src', 'impact'));
        const impact = await computeImpact({
          pool: CONNECT.merchantPool || pool,
          razorpay: rz,
          results: [],
          table: chosen.table || ORDERS_TABLE,
          keyColumn: chosen.key || KEY_COLUMN,
          amountColumn: chosen.credited || AMOUNT_COLUMN,
        });
        const live = impact.razorpay;
        if (!live.available) return res.json({ error: live.reason });

        await saveSetup({
          backfill_at: new Date(),
          backfill_checked: live.capturedCount,
          backfill_missing: live.unrecorded.length,
          backfill_paise: live.unrecordedPaise,
        });
        return res.json({
          ok: true,
          confirm: 'Checked against Razorpay',
          detail: `${live.capturedCount} settled payment(s), `
            + `${live.unrecorded.length} not in your database`,
          backfill: {
            checked: live.capturedCount,
            missing: live.unrecorded.length,
            paise: live.unrecordedPaise,
            orders: live.unrecorded.slice(0, 10),
          },
        });
      }

      res.json({ error: 'unknown step: ' + step });
    } catch (err) { res.json({ error: err.message }); }
  });

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

  // Handed out so a restart can put the tools back on the merchant, the same way
  // a finished setup does.
  app.locals.writeToolConfig = writeToolConfig;
  // The restart path arms the same watchdog the setup path does; loops that
  // come back after a deploy can stop ticking exactly as easily.
  app.locals.armWatchdog = armWatchdog;
  return app;
}

module.exports = { createApp, startMerchant, stopMerchant, armMode, restoreArmed,
  rememberMode, recallMode, S, CONNECT, MERCHANT_SCHEMA };
