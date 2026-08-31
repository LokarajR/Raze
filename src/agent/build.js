'use strict';

/**
 * Everything Razorpay tells a merchant to do, done by Raze instead.
 *
 * Razorpay's own documentation hands the merchant two lists. One is dashboard
 * work: add a webhook, give it a URL, invent a secret, choose an alert email,
 * pick the active events, save it, then validate and test it before production.
 * The other is code they must write on their own server: verify an HMAC-SHA256
 * signature over the RAW body, deduplicate on x-razorpay-event-id, tolerate
 * events arriving out of order, and answer 2xx within five seconds.
 *
 * Every item on both lists is handled here or by the runtime. The merchant
 * connects a database and supplies keys. Nothing else is asked of them.
 *
 * WHAT THIS WILL NOT DO
 *
 * Invent a public address. Razorpay refuses localhost at save time, and a
 * process on someone's laptop has no address Razorpay can reach. When there is
 * none, this says so and the reconciler carries the work instead — which is the
 * mechanism that catches missed deliveries anyway.
 */

const crypto = require('crypto');

const ALL_EVENTS = ['payment.authorized', 'payment.captured', 'payment.failed',
  'order.paid', 'refund.created'];

const api = (creds) => ({
  auth: 'Basic ' + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64'),
});

async function listWebhooks(creds) {
  const r = await fetch('https://api.razorpay.com/v1/webhooks',
    { headers: { authorization: api(creds).auth } });
  const body = await r.json();
  if (!r.ok) throw new Error((body.error && body.error.description) || `HTTP ${r.status}`);
  return body.items || [];
}

/**
 * Build the merchant's Razorpay-side integration.
 *
 * Returns a checklist rather than a boolean, because "it worked" is not what a
 * merchant needs to see. They need to know which of the things they were told to
 * do have actually been done, and how each was confirmed.
 */
async function buildIntegration({ creds, publicUrl, events, alertEmail, existing, knownSecret }) {
  const steps = [];
  const add = (what, done, detail) => steps.push({ what, done, detail });

  const wanted = (events && events.length ? events : ['payment.captured'])
    .filter((e) => ALL_EVENTS.includes(e));

  // ---- 1. an endpoint to deliver to --------------------------------------
  if (!publicUrl) {
    add('An endpoint Razorpay can reach', false,
      'Razorpay refuses localhost, and there is no public address for this instance. '
      + 'Reconciliation covers the gap: it asks Razorpay what it recorded rather than '
      + 'waiting to be told, which is what catches missed deliveries in any case.');
    return { ok: false, steps, webhook: null };
  }
  const url = publicUrl.replace(/\/+$/, '') + '/webhook';
  add('An endpoint Razorpay can reach', true, url);

  // ---- 2. say what is stale, because it cannot be removed -----------------
  //
  // A temporary address dies with the process that opened it, so a machine that
  // has run Raze twice leaves a webhook pointing at nothing.
  //
  // Raze cannot clean that up, and the reason is worth recording rather than
  // discovering twice: the account-level webhook API is create and list only.
  // DELETE /v1/webhooks/{id} and PATCH /v1/webhooks/{id} both answer
  //
  //     404 {"message":"no Route matched with those values"}
  //
  // which reads like the webhook is missing when in fact the verb is. Editing
  // and removing webhooks exist only on the partner route, under an account id a
  // merchant using their own keys does not have.
  //
  // So this reports the stale entries instead of silently leaving them, and says
  // what happens next — measured, not assumed: Razorpay retries a failing
  // endpoint 16 times across 22.76 hours and then deactivates it on its own.
  // The right fix is upstream of all of it, and is the reason a permanent
  // address beats a temporary one: register once, adopt it forever after.
  const stale = (existing || []).filter((w) => w.active && w.url !== url
    && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\//i.test(w.url || ''));
  if (stale.length) {
    add('Older temporary addresses on this account', false,
      `${stale.map((w) => w.id).join(', ')} — Razorpay's account API has no route to remove `
      + 'a webhook, so these stay until Razorpay deactivates them itself after sustained '
      + 'failure. Give Raze a permanent address and this stops happening.');
  }

  // ---- 3. reuse rather than duplicate ------------------------------------
  const already = (existing || []).find((w) => w.url === url && w.active);
  if (already) {
    const have = Object.keys(already.events || {}).filter((k) => already.events[k]);
    const missing = wanted.filter((e) => !have.includes(e));
    add('A webhook registered against your account', true,
      `${already.id} — already present, not duplicated`);
    if (missing.length) {
      // Editing rather than adding: two webhooks on one URL means every event
      // arrives twice, which is a problem Raze would then have to absorb.
      const r = await fetch(`https://api.razorpay.com/v1/webhooks/${already.id}`, {
        method: 'PATCH',
        headers: { authorization: api(creds).auth, 'content-type': 'application/json' },
        body: JSON.stringify({ url, events: Object.fromEntries(wanted.map((e) => [e, true])) }),
      });
      const body = await r.json();
      add('The events your schema can record', r.ok,
        r.ok ? `added ${missing.join(', ')}`
             : (body.error && body.error.description) || `HTTP ${r.status}`);
    } else {
      add('The events your schema can record', true, have.join(', '));
    }
    // Adopting is right — a second webhook on one URL delivers everything twice
    // — but it has a cost worth stating rather than discovering. Razorpay shows
    // a signing secret once, at creation. If this instance was not the one that
    // created this webhook and did not keep the secret, it cannot verify what
    // Razorpay signs, and an unverified delivery is not acted on: reconciliation
    // handles those orders a minute later instead. Saying so beats a console
    // that looks connected and quietly uses only half its machinery.
    add('Able to verify what Razorpay sends', !!knownSecret,
      knownSecret
        ? 'the signing secret from this webhook\'s registration is on file'
        : 'this webhook was registered by another run and Razorpay shows a secret only '
          + 'once, so deliveries here cannot be checked and are left to reconciliation. '
          + 'Delete it in the dashboard and Raze will register a fresh one it can verify.');

    return { ok: true, steps, webhook: already, secret: null, adopted: true,
      verifiable: !!knownSecret };
  }

  // ---- 4. the secret ------------------------------------------------------
  // Generated here. A merchant choosing their own picks a weak one, and a
  // merchant who has to remember one has a secret written down somewhere.
  const secret = crypto.randomBytes(24).toString('hex');
  add('A signing secret', true, '24 random bytes, generated here and never displayed');

  // ---- 5. registration ----------------------------------------------------
  const payload = {
    url,
    secret,
    events: Object.fromEntries(wanted.map((e) => [e, true])),
  };
  if (alertEmail) payload.alert_email = alertEmail;

  const r = await fetch('https://api.razorpay.com/v1/webhooks', {
    method: 'POST',
    headers: { authorization: api(creds).auth, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json();
  if (!r.ok) {
    add('Registered with Razorpay', false,
      (body.error && body.error.description) || `HTTP ${r.status}`);
    return { ok: false, steps, webhook: null };
  }
  add('Registered with Razorpay', true, `${body.id}`);
  add('Subscribed to the events your schema can record', true, wanted.join(', '));
  if (alertEmail) add('An alert address for delivery failures', true, alertEmail);

  // ---- 6. read it back ----------------------------------------------------
  // A registration the provider has not confirmed is not a registration.
  const back = await listWebhooks(creds);
  const live = back.find((w) => w.id === body.id);
  add('Confirmed by reading it back from Razorpay', !!(live && live.active),
    live ? `active, ${Object.keys(live.events || {}).filter((k) => live.events[k]).length} event(s)`
         : 'Razorpay did not return it');

  return { ok: !!(live && live.active), steps, webhook: body, secret };
}

/**
 * The handler requirements Razorpay puts on the merchant, and where each is met.
 *
 * Taken from their documentation rather than from memory, and worth stating
 * plainly: this is the work a merchant would otherwise write, test and own.
 */
function handlerObligations() {
  return [
    {
      what: 'Verify the HMAC-SHA256 signature over the RAW request body',
      detail: 'Razorpay: "ensure that the webhook body passed as an argument is the raw '
        + 'webhook request body. Do not parse or cast." Raze reads the body as bytes before '
        + 'anything touches it, and compares in constant time.',
    },
    {
      what: 'Deduplicate on x-razorpay-event-id',
      detail: 'Razorpay: "identify the duplicate webhooks using the x-razorpay-event-id '
        + 'header." Raze stores it under a uniqueness constraint, so a repeat is rejected by '
        + 'the database rather than by a check that can race.',
    },
    {
      what: 'Tolerate events arriving out of order',
      detail: 'Razorpay: "The above order may not be followed at all times." Raze ranks each '
        + 'event type and refuses a transition that would move an order backwards.',
    },
    {
      what: 'Answer 2xx within five seconds',
      detail: 'Raze answers as soon as the delivery is durably stored, before any business '
        + 'logic runs — so a slow handler cannot cause the timeout that produces a duplicate.',
    },
    {
      what: 'Survive a delivery that never arrives',
      detail: 'Not in the checklist, and the one that costs the most: Razorpay gives up after '
        + '16 attempts across 22.76 hours, measured. Raze asks the API what it recorded rather '
        + 'than waiting to be told.',
    },
  ];
}

module.exports = { buildIntegration, handlerObligations, listWebhooks, ALL_EVENTS };

/**
 * The mapping the runtime writes with, built from the columns setup chose.
 *
 * Setup was already constructing this to validate the merchant's schema, then
 * throwing it away — so the loops were created without one and every repair
 * stopped at "nothing here can say how to write your orders table from a
 * captured payment", which read as a mapping the merchant had not confirmed
 * when in fact it was a mapping nobody had handed over.
 *
 * Kept here so setup and restart build the identical thing; two copies of this
 * would eventually disagree, and the one that disagreed would be the one
 * writing to a merchant's database.
 */
function mappingSpecFor(chosen) {
  if (!chosen || !chosen.table || !chosen.key || !chosen.status || !chosen.credited) return null;
  const mapping = require('../mapping');
  return mapping.normalise('payment.captured', {
    table: chosen.table,
    key: { column: chosen.key, from: 'payload.payment.entity.order_id' },
    set: { [chosen.status]: { literal: 'paid' } },
    add: { [chosen.credited]: 'payload.payment.entity.amount' },
    // A refunded order is not a paid one, and moving it back would be a repair
    // that loses the merchant money rather than finding it.
    guard: { column: chosen.status, notIn: ['refunded'] },
    // Raze repairs rows that exist. Inventing an order from a payment would be
    // inventing a customer.
    insertIfMissing: false,
  });
}

module.exports.mappingSpecFor = mappingSpecFor;
