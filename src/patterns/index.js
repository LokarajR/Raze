'use strict';

/**
 * Known defect patterns, detected and repaired deterministically.
 *
 * Razorpay integrations are not written from first principles. Everyone reads
 * the same documentation, copies the same examples, and arrives at a small
 * number of shapes — which means their defects arrive in a small number of
 * shapes too. Four independently written public repositories were audited for
 * this project and every defect found in them came from the set below.
 *
 * That makes a model unnecessary for the common cases. A pattern that can be
 * recognised can be repaired by transformation, and the result is deterministic,
 * repeatable, and explainable in a way a generated patch is not: "this matches
 * the signature-over-reserialised-JSON pattern, here is the line, here is why it
 * is wrong, here is the edit."
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * It only knows what it knows. Code matching no pattern is reported as
 * unrecognised rather than guessed at, and that is when a model is worth
 * reaching for. Detection is deliberately conservative: a pattern that might
 * match is not a match, because a wrong automated edit to payment code is worse
 * than no edit.
 *
 * Every repair is verified by the same probes that found the failure. A pattern
 * repair earns no more trust than a generated one — it is just cheaper, faster
 * and explainable.
 */

/**
 * Strip comments before matching.
 *
 * Detection driven by prose is detection that fires on documentation. Raze's own
 * mapping module was flagged as an unsafe webhook handler because a doc comment
 * mentions payload.payment.entity and the generated SQL contains INSERT — it
 * receives no requests at all. Comments are removed first so a pattern matches
 * code or nothing.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(new RegExp('(^|[^:])//[^' + String.fromCharCode(92) + 'n]*', 'g'), '$1 ');
}

/**
 * Does this file actually receive HTTP requests?
 *
 * Mentioning Razorpay's payload shape is not the same as handling a delivery. A
 * compiler, a type definition or a test fixture can name the same paths without
 * ever being reachable from the network.
 */
function servesARoute(code) {
  return /(app|router)\s*\.\s*(post|use|all)\s*\(/.test(code)
    || /export\s+(async\s+)?function\s+(POST|handler)/.test(code)
    || /module\.exports\s*=\s*(async\s*)?(function\s*)?\(\s*req/.test(code)
    || /(async\s+)?function\s+\w*(handler|webhook|verify|paymentSuccess)\w*\s*\(\s*req/i.test(code)
    || /exports\.\w+\s*=\s*(async\s*)?\(\s*req/.test(code);
}

function receivesRequests(code) {
  return /req\.(body|headers|rawBody)|request\.(body|headers)|req\s*,\s*res|headers\.get\s*\(/.test(code);
}

/**
 * Signature verified over re-serialised JSON rather than the raw bytes.
 *
 * Observed in 2 of 4 audited repositories. Razorpay signs the exact bytes it
 * sent; JSON.parse followed by JSON.stringify can reorder keys and change
 * whitespace, so verification passes only by luck and fails whenever the
 * round-trip is not byte-identical. It usually works in testing, which is what
 * makes it dangerous.
 */
const reserialisedSignature = {
  id: 'signature-over-reserialised-json',
  title: 'Signature verified over re-serialised JSON',
  why:
    'Razorpay signs the raw request body. JSON.stringify(req.body) re-serialises '
    + 'a parsed object, which can reorder keys and change whitespace, so the HMAC '
    + 'is computed over different bytes than were signed.',
  fixes: ['tampered-signature'],

  detect(source) {
    // The shape that matters: a stringify of the parsed body feeding an HMAC or
    // a Razorpay validate helper.
    const re = /JSON\.stringify\(\s*req\.body\s*\)/g;
    const hits = [...source.matchAll(re)];
    if (hits.length === 0) return null;

    const usesHmac = /createHmac\s*\(|validateWebhookSignature\s*\(/.test(source);
    if (!usesHmac) return null;

    const line = source.slice(0, hits[0].index).split('\n').length;
    return {
      matches: hits.length,
      line,
      evidence: `JSON.stringify(req.body) on line ${line}, feeding a signature check`,
    };
  },

  /**
   * Repair requires the raw bytes to be available. Express only keeps them if
   * asked, so the fix is two edits: capture them, then verify against them.
   */
  repair(source) {
    let out = source;
    const notes = [];

    const hasRaw = /req\.rawBody/.test(out);
    if (!hasRaw) {
      // express.json({ verify }) is the least invasive way to keep the bytes.
      const jsonMount = /express\.json\(\s*\)/;
      if (jsonMount.test(out)) {
        out = out.replace(jsonMount,
          'express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })');
        notes.push('captured the raw body via express.json({ verify })');
      } else {
        return { error: 'raw body is not captured and no express.json() mount was found to add it to' };
      }
    }

    const before = out;
    out = out.replace(/JSON\.stringify\(\s*req\.body\s*\)/g, 'req.rawBody');
    if (out === before) return { error: 'the stringify call could not be rewritten' };
    notes.push('verified the signature over the raw bytes instead of re-serialised JSON');

    return { source: out, notes };
  },
};

/**
 * A handler that answers only one event type.
 *
 * Observed in 1 of 4. Every other event leaves the request hanging with no
 * response at all, so Razorpay times out and retries — forever, for events the
 * merchant never intended to handle. The retry ladder measured here is 16
 * deliveries over 22.76 hours per event.
 */
const missingResponse = {
  id: 'no-response-for-unhandled-events',
  title: 'No response for events the handler does not recognise',
  why:
    'A request with no response is not a rejection, it is a timeout. Razorpay '
    + 'retries it on the full ladder — 16 deliveries over 22.76 hours as measured '
    + 'here — for an event the merchant never meant to process.',
  fixes: [],

  detect(source) {
    // A single event-type guard wrapping every response in the handler.
    const guard = /if\s*\(\s*(?:req\.body|event)\.event\s*==?=\s*['"][a-z_.]+['"]\s*\)/;
    const m = source.match(guard);
    if (!m) return null;

    const after = source.slice(m.index);
    const responses = (after.match(/res\.(status|json|send)\s*\(/g) || []).length;
    const hasElse = /}\s*else\s*{/.test(after.slice(0, 800));
    if (responses === 0 || hasElse) return null;

    const line = source.slice(0, m.index).split('\n').length;
    return {
      line,
      evidence: `every response sits inside the event-type check on line ${line}, with no else branch`,
    };
  },

  repair() {
    // Where the missing response belongs depends on the handler's structure, and
    // guessing wrong means answering 200 to something that was never processed —
    // which tells Razorpay to stop retrying. Reported, not automated.
    return {
      error: 'needs a human: where the fallback response belongs depends on the handler, '
        + 'and answering 200 to an unprocessed event tells Razorpay to stop retrying',
    };
  },
};

/**
 * Removed Mongoose API.
 *
 * Observed in 1 of 4, and the reason a real payment was lost in this project's
 * own demo. Model.update() was removed in Mongoose 7. The handler throws, its
 * own catch answers res.send(err), and Express sends that as 200 — so Razorpay
 * records a successful delivery for a payment that was never written.
 */
const removedMongooseUpdate = {
  id: 'removed-mongoose-update',
  title: 'Model.update() was removed in Mongoose 7',
  why:
    'The call throws, the handler catches its own exception and answers with the '
    + 'error object, and Express sends that as 200. Razorpay reads a success, stops '
    + 'retrying, and the payment is gone with nothing in the logs to say so.',
  fixes: [],

  detect(source) {
    const re = /(\w+)\.update\s*\(\s*\{/g;
    const hits = [...source.matchAll(re)].filter((m) => /model|Model|schema/i.test(m[1]));
    if (hits.length === 0) return null;
    const line = source.slice(0, hits[0].index).split('\n').length;
    return {
      matches: hits.length,
      line,
      evidence: `${hits[0][1]}.update(...) on line ${line} — removed in Mongoose 7`,
    };
  },

  repair(source) {
    // updateOne is the direct replacement and takes the same first two arguments.
    const before = source;
    const out = source.replace(/(\b\w*[Mm]odel\w*)\.update\s*\(/g, '$1.updateOne(');
    if (out === before) return { error: 'no replaceable update() call was found' };
    return { source: out, notes: ['replaced Model.update() with Model.updateOne()'] };
  },
};

/**
 * Request-scoped data held in a module-level variable.
 *
 * Observed in 1 of 4. The value is set by one request and read by another, so
 * under any concurrency it is either stale or null. In the audited repository it
 * was nulled in a finally block before the webhook could ever read it, which
 * made the handler incapable of recording a payment at all.
 */
const moduleScopedRequestState = {
  id: 'module-scoped-request-state',
  title: 'Request data kept in a module-level variable',
  why:
    'A value set by one request and read by another is stale under any '
    + 'concurrency. Webhooks arrive independently of the checkout that set it, so '
    + 'it is routinely null when the handler needs it.',
  fixes: [],

  detect(source) {
    const decl = /^\s*let\s+(\w*(?:id|Id|_id)\w*)\s*;\s*$/m;
    const m = source.match(decl);
    if (!m) return null;
    const name = m[1];
    const assigned = new RegExp(`(?<![\\w.])${name}\\s*=\\s*[^=]`).test(source);
    const read = new RegExp(`[\\{,]\\s*${name}\\s*[,\\}]|\\b${name}\\b\\s*[,)]`).test(source);
    if (!assigned || !read) return null;
    const line = source.slice(0, m.index).split('\n').length;
    return { line, name, evidence: `"${name}" declared at module scope on line ${line}, assigned in one request and read in another` };
  },

  repair() {
    return {
      error: 'needs a human: the value has to come from the event or a lookup, and only '
        + 'the merchant knows which',
    };
  },
};

/**
 * No signature verification anywhere in a webhook handler.
 *
 * The most consequential absence. Without it, anyone who learns the endpoint URL
 * can move money in the merchant's database, and nothing in their logs will look
 * unusual.
 *
 * Detection only. Inserting verification means knowing where the handler begins,
 * which secret it should use and what it should answer on failure — and a wrong
 * guess either rejects real payments or accepts forged ones.
 */
const noSignatureVerification = {
  id: 'no-signature-verification',
  title: 'Webhook signature is never verified',
  why:
    'Razorpay signs every delivery. A handler that does not check the signature '
    + 'will accept any payload from anyone who knows the URL.',
  fixes: ['tampered-signature'],

  detect(source) {
    if (!receivesRequests(source) || !servesARoute(source)) return null;
    const isWebhookHandler = /x-razorpay-event-id|payload\.payment\.entity|payload\.order\.entity/.test(source);
    if (!isWebhookHandler) return null;
    const verifies = /createHmac\s*\(|validateWebhookSignature\s*\(|timingSafeEqual\s*\(/.test(source);
    if (verifies) return null;
    return {
      evidence: 'the file reads Razorpay webhook payloads but never computes or compares an HMAC',
    };
  },

  repair() {
    return {
      error: 'needs a human: which secret to use and what to answer on failure are '
        + 'decisions, and guessing wrong either rejects real payments or accepts forged ones',
    };
  },
};

/**
 * No dedupe on the event id.
 *
 * Present in all four audited repositories, and the defect the measurement was
 * built to characterise: a retry carries the same event id and the same bytes,
 * and the first one arrives 0.23 seconds later.
 *
 * Detection only. Deduplication has to be durable and committed with the
 * business write, which is a structural change to the handler rather than a
 * substitution — it is what the runtime and the declarative mappings exist to
 * provide.
 */
const noIdempotency = {
  id: 'no-idempotency-on-event-id',
  title: 'The event id is never used to deduplicate',
  why:
    'A retried delivery carries an unchanged x-razorpay-event-id and a '
    + 'byte-identical body, and the first retry was measured arriving 0.23s after '
    + 'the original. A handler that does not record which ids it has applied will '
    + 'apply the same effect again.',
  fixes: ['duplicate-delivery', 'timeout-retry', 'retry-storm'],

  detect(source) {
    // Recognise a Razorpay webhook handler by any of its real shapes, not just
    // the Express/JavaScript one. TypeScript and Next.js handlers read the same
    // signature header and the same event, written differently.
    if (!receivesRequests(source) || !servesARoute(source)) return null;
    const isHandler =
      /x-razorpay-signature/i.test(source)
      || /validateWebhookSignature/.test(source)
      || /payload\.(payment|order|refund)\.entity/.test(source);
    if (!isHandler) return null;

    // The defect is not "no dedupe". It is no dedupe AND a write that is not
    // safe to repeat. A handler that only sets values — status = 'paid' — is
    // idempotent by construction, and flagging it would make this detector
    // noise. Only accumulating or creating writes are unsafe on a retry.
    const nonIdempotent = [
      /create\s*\(/,                       // ORM row creation
      /insertOne\s*\(|insertMany\s*\(/, // Mongo insert
      /new\s+\w+\s*\([^)]*\)[\s\S]{0,80}\.save\s*\(/, // new Model(...).save()
      /\$inc\s*:/,                            // Mongo increment
      /\$push\s*:/,                           // Mongo array append
      /\+=\s*[\w.]+/,                         // in-code accumulation
      /\w+\s*=\s*\w+\.\w+\s*\+\s*/,        // balance = balance + amount
      /SET[\s\S]{0,120}=[\s\S]{0,40}\+/i,     // SQL accumulate
      /INSERT\s+INTO(?![\s\S]{0,200}ON\s+CONFLICT)/i, // insert with no upsert
    ];
    const unsafe = nonIdempotent.find((re) => re.test(source));
    if (!unsafe) return null;

    // Any durable use of the event id counts as an attempt to deduplicate.
    const usesEventId = /x-razorpay-event-id|razorpay_event_id|eventId|event_id/i.test(source);
    const dedupes = usesEventId
      && /(seen|processed|applied|dedup|exists|already|findOne|findUnique|SELECT)/i.test(source);
    if (dedupes) return null;

    return {
      evidence: usesEventId
        ? 'writes that are unsafe to repeat, and the event id is read but never used to check whether this event was already applied'
        : 'writes that are unsafe to repeat, and x-razorpay-event-id is never read at all',
    };
  },

  repair() {
    return {
      error: 'needs the runtime: durable dedupe has to commit with the business write, '
        + 'which is what raze protect and declarative mappings provide',
    };
  },
};

const PATTERNS = [
  noSignatureVerification,
  noIdempotency,
  reserialisedSignature,
  removedMongooseUpdate,
  missingResponse,
  moduleScopedRequestState,
];

/** Every pattern that matches this source. */
function scan(source) {
  const code = stripComments(source);
  const found = [];
  for (const p of PATTERNS) {
    let hit = null;
    try { hit = p.detect(code); } catch { hit = null; }
    if (hit) found.push({ pattern: p, ...hit, repairable: typeof p.repair === 'function' });
  }
  return found;
}

/**
 * Apply every repairable pattern in order.
 *
 * Returns the new source plus a record of what was changed and what was
 * recognised but left alone, so nothing is repaired silently.
 */
function repairAll(source) {
  let current = source;
  const applied = [];
  const skipped = [];

  for (const p of PATTERNS) {
    let hit = null;
    try { hit = p.detect(stripComments(current)); } catch { hit = null; }
    if (!hit) continue;

    const result = p.repair(current);
    if (result && result.source) {
      current = result.source;
      applied.push({ id: p.id, title: p.title, evidence: hit.evidence, notes: result.notes || [] });
    } else {
      skipped.push({ id: p.id, title: p.title, evidence: hit.evidence, reason: (result && result.error) || 'not repairable' });
    }
  }

  return { source: current, applied, skipped, changed: current !== source };
}

module.exports = { PATTERNS, scan, repairAll, stripComments, receivesRequests, servesARoute };
