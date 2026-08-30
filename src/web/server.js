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

  const localOnly = (_req, res, next) => {
    if (S.publicUrl) {
      return res.status(403).json({
        error: 'Connecting a real merchant runs locally, not on the public deployment. '
          + 'Clone the repository and run `npm run web`. This instance stays the public '
          + 'webhook receiver.',
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

  app.post('/api/agent/ask', async (req, res) => {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'ask something' });
    emit('agent-thinking', { question });
    const answer = await agent.ask(question);
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
      const out = await actions.since(pool, new Date(Date.now() - hours * 3600 * 1000));
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/activity/ack', async (req, res) => {
    try {
      const actions = require(path.join(RAZE, 'src', 'actions'));
      const n = await actions.acknowledge(pool, String(req.body.order_id || ''));
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

  app.get('/api/ray/next', localOnly, async (_req, res) => {
    try {
      const state = await setupState();
      const step = ray.nextStep(state);

      // Where Razorpay should deliver. The merchant is never asked for a URL:
      // Raze knows its own endpoint, and if one is already registered against
      // this account it adopts that rather than adding a duplicate.
      if (step.id === 'webhook') {
        const rz = CONNECT.razorpay || razorpay;
        const auth = 'Basic ' + Buffer.from(rz.keyId + ':' + rz.keySecret).toString('base64');
        let existing = [];
        try {
          const r = await fetch('https://api.razorpay.com/v1/webhooks',
            { headers: { authorization: auth } });
          existing = ((await r.json()).items || []).filter((w) => w.active);
        } catch {}
        const mine = existing.find((w) => String(w.url).endsWith('/webhook'));
        const publicUrl = S.publicUrl || process.env.RAZE_PUBLIC_URL || null;

        if (mine) {
          step.say = 'You already have a webhook pointing at `' + mine.url + '`, so I will '
            + 'use that rather than adding another. Nothing for you to do here.';
          step.action = 'Use it';
          step.values = { adopt: mine.id };
        } else if (publicUrl) {
          step.say = 'Razorpay needs somewhere to send payment events. I will register `'
            + publicUrl + '/webhook` against your account, generate the signing secret '
            + 'myself, and read the registration back to confirm it exists.';
          step.action = 'Set it up';
          step.values = {};
        } else {
          step.say = "Razorpay needs a public HTTPS address to deliver to, and I am running "
            + "on your machine where it cannot reach me. That is not blocking: I recover "
            + "payments by asking Razorpay what it recorded, which is what catches anything "
            + "a webhook would have missed anyway.";
          step.action = 'Continue without one';
          step.values = { skip: true };
        }
        step.note = 'You do not need to open the Razorpay dashboard.';
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

      // ---- where Razorpay delivers, arranged by Raze ------------------------
      if (step === 'webhook') {
        const rz = CONNECT.razorpay || razorpay;
        const auth = 'Basic ' + Buffer.from(rz.keyId + ':' + rz.keySecret).toString('base64');

        if (values.adopt) {
          await saveSetup({ webhook_ok: true, webhook_id: String(values.adopt) });
          return res.json({ ok: true, confirm: 'Using the webhook already on your account',
            detail: 'no duplicate registered' });
        }
        if (values.skip) {
          await saveSetup({ webhook_ok: true });
          return res.json({ ok: true, confirm: 'Continuing without a webhook',
            detail: 'I will ask Razorpay directly rather than waiting to be told' });
        }

        const publicUrl = S.publicUrl || process.env.RAZE_PUBLIC_URL;
        const secret = crypto.randomBytes(24).toString('hex');
        const r = await fetch('https://api.razorpay.com/v1/webhooks', {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            url: publicUrl + '/webhook', secret,
            events: { 'payment.authorized': true, 'payment.captured': true,
              'payment.failed': true, 'order.paid': true, 'refund.created': true },
          }),
        });
        const body = await r.json();
        if (!r.ok) {
          return res.json({ error: (body.error && body.error.description) || 'HTTP ' + r.status });
        }
        const back = await fetch('https://api.razorpay.com/v1/webhooks',
          { headers: { authorization: auth } });
        const live = ((await back.json()).items || []).some((w) => w.id === body.id && w.active);
        CONNECT.webhookSecret = secret;
        await saveSetup({ webhook_ok: true, webhook_id: body.id });
        return res.json({
          ok: true,
          confirm: live ? 'Webhook registered and confirmed by Razorpay' : 'Webhook registered',
          detail: body.url + ' — five events, secret generated here and never shown',
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
        await saveSetup({
          mapping_confirmed: true,
          expected_column: expected,
          expected_column_absent: !expected,
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

  return app;
}

module.exports = { createApp, startMerchant, stopMerchant, armMode, restoreArmed,
  rememberMode, recallMode, S, MERCHANT_SCHEMA };
