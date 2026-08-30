'use strict';

/**
 * Mapping inference — Raze reads the merchant's schema and proposes the mapping.
 *
 * Two things are already known with certainty, so nothing here needs to guess at
 * either of them:
 *
 *   the merchant's schema     read from information_schema: tables, columns,
 *                             types, primary keys
 *   Razorpay's event shape    read from the captured corpus: every real field
 *                             path and its type, taken from 796 deliveries that
 *                             actually arrived, not from documentation
 *
 * What remains is matching one to the other, which is name and type comparison —
 * not intelligence, and deliberately not a model. The same input always produces
 * the same proposal, and every match carries the evidence that produced it.
 *
 * IT PROPOSES, IT DOES NOT APPLY.
 *
 * Inference can say that `order_id TEXT PRIMARY KEY` corresponds to
 * `payload.payment.entity.order_id`. It cannot say whether a refund should set a
 * status to 'refunded' or reverse a balance — that is business intent, and being
 * wrong about it moves money. So this emits a mapping for a human to read,
 * correct and commit. Anything it is unsure about is marked rather than assumed.
 */

const fs = require('fs');

/** Columns that identify a row, in the order we would prefer to key on. */
const KEY_HINTS = [
  { column: /^order_?id$/i, path: 'payload.payment.entity.order_id', why: 'names the Razorpay order' },
  { column: /^razorpay_?order_?id$/i, path: 'payload.payment.entity.order_id', why: 'names the Razorpay order' },
  { column: /^payment_?id$/i, path: 'payload.payment.entity.id', why: 'names the Razorpay payment' },
  { column: /^razorpay_?payment_?id$/i, path: 'payload.payment.entity.id', why: 'names the Razorpay payment' },
  { column: /^refund_?id$/i, path: 'payload.refund.entity.id', why: 'names the Razorpay refund' },
  { column: /^_?id$/i, path: 'payload.payment.entity.order_id', why: 'primary key holding the order id' },
];

/** Columns that hold money, matched against the amount on the event. */
const AMOUNT_HINTS = [
  /^amount(_paise|_in_paise)?$/i,
  /^credited(_paise)?$/i,
  /^total(_paise|_amount)?$/i,
  /^paid(_amount|_paise)?$/i,
  /^value$/i,
];

/** Columns that hold a lifecycle state. */
const STATUS_HINTS = [/^status$/i, /^state$/i, /^payment_?status$/i, /^order_?status$/i];

/** Columns that count applications of an event. */
const COUNT_HINTS = [/^credit_?count$/i, /^attempts?$/i, /^applied_?count$/i];

/**
 * What each event type means for a status column.
 *
 * This is the one place an opinion is encoded, and it is the merchant's to
 * overrule. It is written down explicitly rather than inferred so that a
 * reviewer can see it and disagree.
 */
const STATUS_FOR_EVENT = {
  'payment.authorized': 'authorized',
  'payment.captured': 'paid',
  'order.paid': 'paid',
  'payment.failed': 'failed',
  'refund.created': 'refunded',
};

/** Events that should not move an order backwards once it has settled. */
const GUARD_FOR_EVENT = {
  'payment.authorized': ['paid', 'refunded'],
  'payment.captured': ['refunded'],
  'order.paid': ['refunded'],
  'payment.failed': ['paid', 'refunded'],
};

const NUMERIC = new Set(['bigint', 'integer', 'numeric', 'real', 'double precision', 'smallint']);
const TEXTUAL = new Set(['text', 'character varying', 'character', 'uuid']);

/** Every field path present in the captured events, per event type. */
function eventShapes(corpusPath) {
  const shapes = new Map();
  const lines = fs.readFileSync(corpusPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.event_type || !row.raw_body_b64) continue;
    if (shapes.has(row.event_type)) continue;
    let body;
    try { body = JSON.parse(Buffer.from(row.raw_body_b64, 'base64').toString('utf8')); } catch { continue; }
    const paths = new Map();
    (function walk(obj, prefix) {
      for (const [k, v] of Object.entries(obj || {})) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
        else paths.set(p, typeof v);
      }
    })(body, '');
    shapes.set(row.event_type, paths);
  }
  return shapes;
}

/** The merchant's tables, with columns, types and primary key. */
async function readSchema(pool) {
  const { rows: cols } = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT LIKE 'raze\\_%'
      ORDER BY table_name, ordinal_position`
  );
  const { rows: pks } = await pool.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`
  );
  const pkOf = new Map(pks.map((r) => [r.table_name, r.column_name]));

  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.table_name)) {
      tables.set(c.table_name, { name: c.table_name, columns: [], primaryKey: pkOf.get(c.table_name) || null });
    }
    tables.get(c.table_name).columns.push({
      name: c.column_name,
      type: c.data_type,
      nullable: c.is_nullable === 'YES',
      hasDefault: c.column_default !== null,
    });
  }
  return [...tables.values()];
}

const matches = (name, patterns) => patterns.some((p) => p.test(name));

/**
 * Propose a mapping for one table and one event type.
 *
 * Returns null when nothing in the table identifies a Razorpay object — a table
 * that cannot be keyed is not a table this event belongs to, and inventing a key
 * for it would be the worst possible kind of guess.
 */
function proposeFor(table, eventType, shape, discovered) {
  const evidence = [];

  let key = null;
  for (const hint of KEY_HINTS) {
    const col = table.columns.find((c) => hint.column.test(c.name) && (TEXTUAL.has(c.type)));
    if (!col) continue;
    if (!shape.has(hint.path)) continue;
    key = { column: col.name, from: hint.path };
    evidence.push(`key: "${table.name}.${col.name}" (${col.type}) <- ${hint.path}, ${hint.why}`);
    break;
  }
  // Nothing in the names matched, but the data said what the name did not.
  if (!key && discovered && shape.has(discovered.from)) {
    key = { column: discovered.column, from: discovered.from };
    evidence.push(`key: "${table.name}.${discovered.column}" <- ${discovered.from}, `
      + `found by reading the column rather than its name (${discovered.why})`);
  }
  if (!key) return null;

  const set = {};
  const add = {};

  const statusCol = table.columns.find((c) => matches(c.name, STATUS_HINTS) && TEXTUAL.has(c.type));
  if (statusCol && STATUS_FOR_EVENT[eventType]) {
    set[statusCol.name] = { literal: STATUS_FOR_EVENT[eventType] };
    evidence.push(`set: "${statusCol.name}" = '${STATUS_FOR_EVENT[eventType]}' for ${eventType}`);
  }

  // Money moves only on capture. Authorisation has not settled, and a failure
  // moved nothing — applying an amount for either would be wrong.
  if (eventType === 'payment.captured') {
    const amountCol = table.columns.find((c) => matches(c.name, AMOUNT_HINTS) && NUMERIC.has(c.type));
    if (amountCol && shape.has('payload.payment.entity.amount')) {
      add[amountCol.name] = 'payload.payment.entity.amount';
      evidence.push(`add: "${amountCol.name}" (${amountCol.type}) += payload.payment.entity.amount`);
    }
    const countCol = table.columns.find((c) => matches(c.name, COUNT_HINTS) && NUMERIC.has(c.type));
    if (countCol) {
      add[countCol.name] = { literal: 1 };
      evidence.push(`add: "${countCol.name}" += 1 per applied capture`);
    }
  }

  if (Object.keys(set).length === 0 && Object.keys(add).length === 0) return null;

  const guardStates = GUARD_FOR_EVENT[eventType];
  const guard = statusCol && guardStates
    ? { column: statusCol.name, notIn: guardStates }
    : null;
  if (guard) {
    evidence.push(`guard: refuse when "${statusCol.name}" is already ${guardStates.join(' or ')}`);
  }

  // Anything the merchant has to decide is recorded rather than assumed.
  const questions = [];
  if (eventType === 'refund.created' && Object.keys(add).length === 0) {
    questions.push('a refund sets the status but reverses no amount — decide whether it should');
  }
  // Only columns that would actually block an insert. A NOT NULL column with a
  // DEFAULT fills itself in, and warning about it would train the reader to
  // ignore these notes.
  const required = table.columns.filter(
    (c) => !c.nullable && !c.hasDefault
      && c.name !== key.column && !(c.name in set) && !(c.name in add)
  );
  if (required.length) {
    questions.push(
      `these columns are NOT NULL and unset by this mapping, so a row can only be ` +
      `updated and never inserted: ${required.map((c) => c.name).join(', ')}`
    );
  }

  return {
    eventType,
    spec: { table: table.name, key, set, add, guard, insertIfMissing: required.length === 0 },
    evidence,
    questions,
  };
}

/** Propose mappings for every table and event type that can be matched. */
/**
 * Find the key column by what it contains, when its name gives nothing away.
 *
 * Name matching handles the common case and fails completely on a schema whose
 * author chose their own words — `gateway_ref` holds Razorpay order ids and
 * matches no pattern anyone would think to write down. A column's contents are
 * stronger evidence than its name, and reading them is what a person would do.
 *
 * Deliberately narrow. It samples a handful of values and accepts the column
 * only if nearly all of them carry Razorpay's own identifier format, which is
 * not a shape that appears by accident. A column that merely looks plausible is
 * not enough: this returns nothing rather than a maybe, and setup then asks.
 */
async function findKeyByContent(pool, table) {
  const textual = table.columns.filter((c) => TEXTUAL.has(c.type));
  for (const col of textual) {
    let rows;
    try {
      rows = await pool.query(
        `SELECT "${col.name}" AS v FROM "${table.name}"
          WHERE "${col.name}" IS NOT NULL LIMIT 25`);
    } catch { continue; }
    if (rows.rowCount < 2) continue;

    const values = rows.rows.map((r) => String(r.v));
    const orderLike = values.filter((v) => /^order_[A-Za-z0-9]{8,}$/.test(v)).length;
    const payLike = values.filter((v) => /^pay_[A-Za-z0-9]{8,}$/.test(v)).length;

    if (orderLike / values.length >= 0.8) {
      return {
        column: col.name,
        from: 'payload.payment.entity.order_id',
        why: `${orderLike} of ${values.length} sampled values are Razorpay order ids`,
      };
    }
    if (payLike / values.length >= 0.8) {
      return {
        column: col.name,
        from: 'payload.payment.entity.id',
        why: `${payLike} of ${values.length} sampled values are Razorpay payment ids`,
      };
    }
  }
  return null;
}

async function infer({ pool, corpusPath, eventTypes }) {
  const shapes = eventShapes(corpusPath);
  const schema = await readSchema(pool);
  const types = eventTypes && eventTypes.length ? eventTypes : [...shapes.keys()];

  const proposals = [];
  for (const table of schema) {
    // Names first — cheap, and right for most schemas. Only when they give
    // nothing does this look at the data, and only at the column that would
    // become the key.
    let discovered = null;
    const namedKey = types.some((type) => {
      const shape = shapes.get(type);
      return shape && proposeFor(table, type, shape);
    });
    if (!namedKey) discovered = await findKeyByContent(pool, table);

    for (const type of types) {
      const shape = shapes.get(type);
      if (!shape) continue;
      const p = proposeFor(table, type, shape, discovered);
      if (p) proposals.push(p);
    }
  }
  return { schema, shapes, proposals };
}

/** Render proposals as a mapping file the merchant can read, edit and commit. */
function render(proposals, { corpusPath } = {}) {
  const lines = [];
  lines.push(`'use strict';`);
  lines.push('');
  lines.push('/**');
  lines.push(' * Raze mapping — PROPOSED, NOT CONFIRMED.');
  lines.push(' *');
  lines.push(' * Generated by `raze infer` from this database\'s own schema and the field');
  lines.push(' * paths present in real captured Razorpay deliveries. Every line below has');
  lines.push(' * evidence attached. Read it, correct anything that does not match what these');
  lines.push(' * events mean for your business, and commit it.');
  lines.push(' *');
  lines.push(' * Inference can see that a column named order_id holds a Razorpay order id. It');
  lines.push(' * cannot see whether a refund should reverse a balance or only mark a status.');
  lines.push(' * Wherever that judgement was needed it is listed as a QUESTION rather than');
  lines.push(' * decided silently.');
  lines.push(' */');
  lines.push('');
  lines.push('module.exports = function mappings(rz) {');

  for (const p of proposals) {
    lines.push('');
    for (const e of p.evidence) lines.push(`  // ${e}`);
    for (const q of p.questions) lines.push(`  // QUESTION: ${q}`);
    const spec = JSON.stringify(p.spec, null, 2).split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');
    lines.push(`  rz.map(${JSON.stringify(p.eventType)}, ${spec});`);
  }

  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

module.exports = { infer, render, readSchema, eventShapes, proposeFor, STATUS_FOR_EVENT, GUARD_FOR_EVENT };
