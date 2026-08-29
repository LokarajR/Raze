'use strict';

/**
 * Mapping inference for MongoDB merchants.
 *
 * The Postgres version reads information_schema, which is authoritative: every
 * column and type is declared. Mongo has no such declaration, so the shape has
 * to be sampled from documents that actually exist.
 *
 * That difference matters and is surfaced rather than hidden. A field seen in
 * 3 of 200 sampled documents is reported with that ratio attached, because a
 * field present in a fraction of documents is a much weaker basis for a mapping
 * than a NOT NULL column. Where Postgres inference can be certain a column
 * exists, this can only report how often it was observed.
 *
 * Everything else is the same discipline: it proposes, it never applies, and it
 * refuses to guess when nothing identifies a Razorpay object.
 */

const fs = require('fs');

const SAMPLE_SIZE = Number(process.env.RAZE_MONGO_SAMPLE || 200);

/** Fields that identify a Razorpay object, and the event path they come from. */
const KEY_HINTS = [
  { field: /^order_?id$/i, path: 'payload.payment.entity.order_id', why: 'names the Razorpay order' },
  { field: /^razorpay_?order_?id$/i, path: 'payload.payment.entity.order_id', why: 'names the Razorpay order' },
  { field: /^payment_?id$/i, path: 'payload.payment.entity.id', why: 'names the Razorpay payment' },
  { field: /^razorpay_?payment_?id$/i, path: 'payload.payment.entity.id', why: 'names the Razorpay payment' },
  { field: /^refund_?id$/i, path: 'payload.refund.entity.id', why: 'names the Razorpay refund' },
  { field: /^_id$/i, path: 'payload.payment.entity.order_id', why: '_id holding the Razorpay order id' },
];

const AMOUNT_HINTS = [/^amount(_paise)?$/i, /^credited(_paise)?$/i, /^total(_paise|_amount)?$/i, /^value$/i];
const STATUS_HINTS = [/^status$/i, /^state$/i, /^payment_?status$/i, /^order_?status$/i];
const COUNT_HINTS = [/^credit_?count$/i, /^attempts?$/i, /^applied_?count$/i];

const STATUS_FOR_EVENT = {
  'payment.authorized': 'authorized',
  'payment.captured': 'paid',
  'order.paid': 'paid',
  'payment.failed': 'failed',
  'refund.created': 'refunded',
};

const GUARD_FOR_EVENT = {
  'payment.authorized': ['paid', 'refunded'],
  'payment.captured': ['refunded'],
  'order.paid': ['refunded'],
  'payment.failed': ['paid', 'refunded'],
};

/** Field paths present in the captured events, per event type. */
function eventShapes(corpusPath) {
  const shapes = new Map();
  for (const line of fs.readFileSync(corpusPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.event_type || !row.raw_body_b64 || shapes.has(row.event_type)) continue;
    let body;
    try { body = JSON.parse(Buffer.from(row.raw_body_b64, 'base64').toString('utf8')); } catch { continue; }
    const paths = new Set();
    (function walk(o, prefix) {
      for (const [k, v] of Object.entries(o || {})) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
        else paths.add(p);
      }
    })(body, '');
    shapes.set(row.event_type, paths);
  }
  return shapes;
}

/**
 * Sample a collection and report which top-level fields appear, how often, and
 * what type they usually hold.
 */
async function sampleCollection(db, name, sampleSize = SAMPLE_SIZE) {
  const docs = await db.collection(name).find({}).limit(sampleSize).toArray();
  const fields = new Map();
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      if (k.startsWith('_raze_')) continue;
      if (!fields.has(k)) fields.set(k, { name: k, seen: 0, types: new Map() });
      const f = fields.get(k);
      f.seen++;
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      f.types.set(t, (f.types.get(t) || 0) + 1);
    }
  }
  for (const f of fields.values()) {
    f.ratio = docs.length ? f.seen / docs.length : 0;
    f.type = [...f.types.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return { name, sampled: docs.length, fields: [...fields.values()] };
}

const matches = (n, pats) => pats.some((p) => p.test(n));

function proposeFor(collection, eventType, shape) {
  const evidence = [];
  const questions = [];

  let key = null;
  for (const hint of KEY_HINTS) {
    const f = collection.fields.find((x) => hint.field.test(x.name) && (x.type === 'string' || x.name === '_id'));
    if (!f || !shape.has(hint.path)) continue;
    key = { field: f.name, from: hint.path };
    evidence.push(
      `key: "${collection.name}.${f.name}" (${f.type}) <- ${hint.path}, ${hint.why}` +
      ` — seen in ${f.seen}/${collection.sampled} sampled documents`
    );
    if (f.ratio < 0.9) {
      questions.push(
        `"${f.name}" appears in only ${(f.ratio * 100).toFixed(0)}% of sampled documents; ` +
        `confirm every order really carries it`
      );
    }
    break;
  }
  if (!key) return null;

  const set = {};
  const inc = {};

  const statusField = collection.fields.find((f) => matches(f.name, STATUS_HINTS) && f.type === 'string');
  if (statusField && STATUS_FOR_EVENT[eventType]) {
    set[statusField.name] = { literal: STATUS_FOR_EVENT[eventType] };
    evidence.push(`set: "${statusField.name}" = '${STATUS_FOR_EVENT[eventType]}' for ${eventType}`);
  }

  if (eventType === 'payment.captured') {
    const amountField = collection.fields.find((f) => matches(f.name, AMOUNT_HINTS) && f.type === 'number');
    if (amountField && shape.has('payload.payment.entity.amount')) {
      inc[amountField.name] = 'payload.payment.entity.amount';
      evidence.push(`inc: "${amountField.name}" += payload.payment.entity.amount`);
      questions.push(
        `Razorpay sends amounts in paise; confirm "${amountField.name}" is stored in paise ` +
        `and not rupees before trusting this`
      );
    }
    const countField = collection.fields.find((f) => matches(f.name, COUNT_HINTS) && f.type === 'number');
    if (countField) {
      inc[countField.name] = { literal: 1 };
      evidence.push(`inc: "${countField.name}" += 1 per applied capture`);
    }
  }

  if (Object.keys(set).length === 0 && Object.keys(inc).length === 0) return null;

  const guardStates = GUARD_FOR_EVENT[eventType];
  const guard = statusField && guardStates ? { field: statusField.name, notIn: guardStates } : null;
  if (guard) evidence.push(`guard: refuse when "${statusField.name}" is already ${guardStates.join(' or ')}`);

  if (eventType === 'refund.created' && Object.keys(inc).length === 0) {
    questions.push('a refund sets the status but reverses no amount — decide whether it should');
  }
  if (collection.sampled === 0) {
    questions.push('this collection is empty, so the mapping is based on field names alone');
  }

  return {
    eventType,
    spec: { collection: collection.name, key, set, inc, guard, upsert: true },
    evidence,
    questions,
  };
}

async function infer({ db, corpusPath, eventTypes, sampleSize }) {
  const shapes = eventShapes(corpusPath);
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.') && !n.startsWith('raze_'));

  const collections = [];
  for (const n of names) collections.push(await sampleCollection(db, n, sampleSize));

  const types = eventTypes && eventTypes.length ? eventTypes : [...shapes.keys()];
  const proposals = [];
  for (const c of collections) {
    for (const t of types) {
      const shape = shapes.get(t);
      if (!shape) continue;
      const p = proposeFor(c, t, shape);
      if (p) proposals.push(p);
    }
  }
  return { collections, proposals };
}

function render(proposals) {
  const out = [`'use strict';`, '', '/**', ' * Raze MongoDB mapping — PROPOSED, NOT CONFIRMED.', ' *',
    ' * Generated by `raze infer` from documents sampled out of your own collections',
    ' * and the field paths present in real captured Razorpay deliveries.',
    ' *',
    ' * Mongo declares no schema, so this was inferred from documents that happen to',
    ' * exist. Where a field was missing from some of them, the ratio is noted — a',
    ' * field present in a fraction of documents is a weak basis for a mapping.',
    ' *',
    ' * Read it, correct anything that does not match what these events mean for your',
    ' * business, and commit it.',
    ' */', '', 'module.exports = function mappings(rz) {'];

  for (const p of proposals) {
    out.push('');
    for (const e of p.evidence) out.push(`  // ${e}`);
    for (const q of p.questions) out.push(`  // QUESTION: ${q}`);
    const spec = JSON.stringify(p.spec, null, 2).split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');
    out.push(`  rz.map(${JSON.stringify(p.eventType)}, ${spec});`);
  }
  out.push('};', '');
  return out.join('\n');
}

module.exports = { infer, render, sampleCollection, eventShapes, proposeFor, SAMPLE_SIZE };
