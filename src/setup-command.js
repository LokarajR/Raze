'use strict';

/**
 * `raze setup` — build the whole integration for a merchant who has none.
 *
 * The starting point this assumes is a merchant with a database and nothing
 * else: no webhook endpoint, no handler, no webhook registered with Razorpay, no
 * secret. Everything between that and a working, protected integration is
 * automatable, and this does it in one pass:
 *
 *   1. check the database is reachable and install Raze's own tables
 *   2. read the merchant's schema and propose the event mapping
 *   3. generate a webhook secret
 *   4. register the webhook with Razorpay, subscribed to the five events that
 *      matter, pointed at the endpoint Raze serves
 *   5. read the registration back from Razorpay and confirm it
 *   6. write the configuration
 *
 * WHAT IT WILL NOT DO WITHOUT BEING TOLD
 *
 * Registering a webhook changes the merchant's Razorpay account, so it needs an
 * explicit --url and will not invent one. Run with --dry-run to see every action
 * first. An existing webhook for the same URL is updated rather than duplicated,
 * and nothing is ever deleted.
 *
 * The mapping is still proposed rather than applied: inference can see that a
 * column holds an order id, but not whether a refund should reverse a balance.
 * Setup writes the file and tells the merchant to read it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** The events an integration needs to stay correct. */
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
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = (parsed.error && parsed.error.description) || `HTTP ${res.status}`;
    const err = new Error(`Razorpay ${method} ${endpoint}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

module.exports = async function cmdSetup({ env, flag, has, LOG, RAZE, deps }) {
  const { connect, migrate, shutdown } = deps;
  const { infer, render } = require(path.join(RAZE, 'src', 'infer'));

  const url = flag('url', null);
  const dryRun = has('dry-run');
  const mappingOut = String(flag('mapping', path.join(process.cwd(), 'raze.mapping.js')));
  const envOut = String(flag('env-out', path.join(RAZE, '.env')));

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    console.error('\n  Razorpay Test Mode credentials are needed to register a webhook.');
    console.error('  Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or copy .env.example to .env.\n');
    process.exit(1);
  }
  if (!url && !dryRun) {
    console.error('\n  raze setup needs the public URL your endpoint will be reachable at:');
    console.error('    raze setup --url https://your-host/webhook');
    console.error('');
    console.error('  Razorpay rejects localhost when saving a webhook, so this has to be a');
    console.error('  public HTTPS address. See the README for deploying to Railway, Render or Fly.');
    console.error('  Add --dry-run to see every action without changing anything.\n');
    process.exit(1);
  }

  console.log('');
  console.log(`  raze setup${dryRun ? '   (dry run — nothing will be changed)' : ''}`);
  console.log('');

  // -- 1. database ---------------------------------------------------------
  const { pool, url: dbUrl, embedded } = await connect();
  const migrations = await migrate(pool);
  console.log(`  1. database`);
  console.log(`     ${embedded ? 'embedded postgres (raze/.pgdata)' : dbUrl.replace(/:[^:@]*@/, ':***@')}`);
  console.log(`     migrations applied: ${migrations.join(', ')}`);

  // -- 2. mapping ----------------------------------------------------------
  console.log('');
  console.log('  2. reading your schema');
  const { schema, proposals } = await infer({ pool, corpusPath: LOG });
  console.log(`     ${schema.length} table(s) found, ${proposals.length} mapping(s) proposed`);
  for (const p of proposals) {
    console.log(`       ${p.eventType.padEnd(20)} -> ${p.spec.table}`);
  }
  if (proposals.length === 0) {
    console.log('       nothing matched. A table needs a column naming a Razorpay object');
    console.log('       (order_id, payment_id, refund_id) before an event can map to it.');
    console.log('       You can still write raze.mapping.js by hand — it is six lines per event.');
  }

  const questions = proposals.flatMap((p) => p.questions.map((q) => `${p.eventType}: ${q}`));

  // -- 3. secret -----------------------------------------------------------
  console.log('');
  console.log('  3. webhook secret');
  let secret = env.RAZORPAY_WEBHOOK_SECRET;
  let generated = false;
  if (secret) {
    console.log('     reusing the secret already configured');
  } else {
    secret = crypto.randomBytes(24).toString('base64url');
    generated = true;
    console.log('     generated a new one (24 random bytes)');
  }

  // -- 4. register ---------------------------------------------------------
  console.log('');
  console.log('  4. registering with Razorpay');
  const existing = await rzp(env, 'GET', '/webhooks');
  const already = (existing.items || []).find((w) => w.url === url);

  const payload = {
    url,
    secret,
    events: EVENTS,
  };

  let webhook = null;
  if (dryRun) {
    console.log(`     would ${already ? `update webhook ${already.id}` : 'create a webhook'} for ${url || '<no --url given>'}`);
    console.log(`     events: ${EVENTS.join(', ')}`);
  } else if (already) {
    webhook = await rzp(env, 'PUT', `/webhooks/${already.id}`, payload);
    console.log(`     updated existing webhook ${webhook.id} (same URL, not duplicated)`);
  } else {
    webhook = await rzp(env, 'POST', '/webhooks', payload);
    console.log(`     created webhook ${webhook.id}`);
  }

  // -- 5. verify -----------------------------------------------------------
  if (!dryRun) {
    console.log('');
    console.log('  5. reading it back from Razorpay');
    const check = await rzp(env, 'GET', '/webhooks');
    const found = (check.items || []).find((w) => w.id === webhook.id);
    if (!found) {
      console.log('     WARNING: the webhook was not found when read back. Check the dashboard.');
    } else {
      const subscribed = Object.entries(found.events || {}).filter(([, on]) => on).map(([e]) => e);
      const missing = EVENTS.filter((e) => !subscribed.includes(e));
      console.log(`     ${found.url}`);
      console.log(`     active: ${found.active}`);
      console.log(`     events: ${subscribed.join(', ')}`);
      if (missing.length) console.log(`     WARNING: not subscribed to ${missing.join(', ')}`);
    }
  }

  // -- 6. write configuration ---------------------------------------------
  console.log('');
  console.log('  6. configuration');
  if (proposals.length > 0) {
    if (dryRun) {
      console.log(`     would write the mapping to ${mappingOut}`);
    } else {
      fs.writeFileSync(mappingOut, render(proposals, { corpusPath: LOG }));
      console.log(`     mapping written to ${mappingOut}`);
    }
  }
  if (generated && !dryRun) {
    // Appended rather than rewritten: a .env usually holds more than we know about.
    fs.appendFileSync(envOut, `\nRAZORPAY_WEBHOOK_SECRET=${secret}\n`);
    console.log(`     secret appended to ${envOut}`);
  } else if (generated && dryRun) {
    console.log(`     would append the generated secret to ${envOut}`);
  }

  // -- what is left for a human -------------------------------------------
  console.log('');
  console.log('  What still needs you');
  console.log('');
  if (questions.length) {
    console.log('    The mapping has questions only you can answer:');
    for (const q of questions) console.log(`      - ${q}`);
    console.log('');
  }
  console.log('    1. read the mapping and correct anything that does not match what');
  console.log('       these events mean for your business. Nothing has been applied.');
  console.log('    2. arm expectations when you create an order, so an absent payment');
  console.log('       is noticed:  raze watch --table <orders> --key <order_id_column>');
  console.log('    3. start it:    raze protect');
  console.log('');

  await shutdown(pool);
};

module.exports.EVENTS = EVENTS;
