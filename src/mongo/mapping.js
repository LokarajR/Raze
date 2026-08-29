'use strict';

/**
 * Declarative mappings for MongoDB merchants.
 *
 * Every real published Razorpay integration we audited stores its data in
 * MongoDB, so a Postgres-only mapping layer does not apply to the merchants that
 * most need one.
 *
 * HOW THE GUARANTEE DIFFERS, AND WHY IT IS STILL SOUND
 *
 * With Postgres, Raze's dedupe write and the business write commit in one
 * transaction. That is not available here: the inbox lives in Postgres and the
 * business data lives in Mongo, and no transaction spans both. Claiming
 * otherwise would be a lie.
 *
 * Instead the idempotency guard travels inside the update itself. Every mapped
 * document carries the list of event ids already applied to it, and the filter
 * requires the incoming event id to be absent from that list. MongoDB applies a
 * single-document update atomically, so:
 *
 *   first delivery    filter matches, effect applied, event id recorded
 *   every retry       filter does not match, nothing happens
 *   crash between the Mongo write and the inbox update
 *                     the event is retried, the filter does not match, the
 *                     effect is not repeated — the retry is a no-op, which is
 *                     exactly what it should be
 *
 * So the business-state transition is exactly-once per document without any
 * cross-store transaction. What is lost relative to Postgres is that the
 * merchant's own writes cannot be enrolled in Raze's transaction — a merchant
 * doing additional work of their own must make that work idempotent themselves.
 */

const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const APPLIED = '_raze_applied';

function assertField(name, what) {
  if (typeof name !== 'string' || !FIELD.test(name) || name.startsWith('$')) {
    throw new Error(`invalid ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Read a dotted path out of the event. */
function pluck(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function resolve(source, event) {
  if (source && typeof source === 'object' && 'literal' in source) return source.literal;
  if (typeof source === 'string') {
    const found = pluck(event, source);
    return found === undefined ? source : found;
  }
  return source;
}

function normalise(eventType, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('a mapping spec is required');
  if (!raw.collection) throw new Error('mapping needs a collection');
  if (!raw.key || !raw.key.field || !raw.key.from) {
    throw new Error('mapping needs key: { field, from }');
  }

  const spec = {
    eventType,
    collection: assertField(raw.collection, 'collection name'),
    key: { field: assertField(raw.key.field, 'key field'), from: String(raw.key.from) },
    set: {},
    inc: {},
    guard: null,
    upsert: raw.upsert !== false,
  };

  for (const [f, source] of Object.entries(raw.set || {})) {
    spec.set[assertField(f, 'set field')] = source;
  }
  for (const [f, source] of Object.entries(raw.inc || {})) {
    spec.inc[assertField(f, 'inc field')] = source;
  }
  if (raw.guard) {
    spec.guard = {
      field: assertField(raw.guard.field, 'guard field'),
      notIn: Array.isArray(raw.guard.notIn) ? raw.guard.notIn : [],
    };
  }
  if (Object.keys(spec.set).length === 0 && Object.keys(spec.inc).length === 0) {
    throw new Error('mapping needs at least one of set or inc');
  }
  return spec;
}

/**
 * Compile a mapping, an event and its id into a single updateOne.
 *
 * The event id in the filter is what makes this safe to run any number of times.
 */
function compile(spec, event, eventId) {
  const keyValue = pluck(event, spec.key.from);
  if (keyValue === undefined || keyValue === null) {
    return { skip: `no value at ${spec.key.from}` };
  }
  if (!eventId) return { skip: 'no event id — cannot apply idempotently' };

  const filter = {
    [spec.key.field]: keyValue,
    [APPLIED]: { $ne: eventId },
  };
  if (spec.guard && spec.guard.notIn.length) {
    filter[spec.guard.field] = { $nin: spec.guard.notIn };
  }

  const $set = {};
  for (const [f, source] of Object.entries(spec.set)) {
    $set[f] = resolve(source, event);
  }

  const $inc = {};
  for (const [f, source] of Object.entries(spec.inc)) {
    const n = Number(resolve(source, event));
    if (!Number.isFinite(n)) {
      return { skip: `no numeric value for "${f}" from ${JSON.stringify(source)}` };
    }
    $inc[f] = n;
  }

  const update = { $addToSet: { [APPLIED]: eventId } };
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($inc).length) update.$inc = $inc;

  // On upsert the key must be set on the new document. It cannot also appear in
  // $set, so it goes in $setOnInsert.
  if (spec.upsert) update.$setOnInsert = { [spec.key.field]: keyValue };

  return { collection: spec.collection, filter, update, upsert: spec.upsert, keyValue };
}

/**
 * Confirm the collection exists before accepting a mapping.
 *
 * Mongo will happily create a collection on first write, which means a typo
 * silently produces a second, wrong collection rather than an error. Requiring
 * it to exist turns that into a startup failure.
 */
async function validateAgainstDatabase(db, spec) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  if (!names.includes(spec.collection)) {
    throw new Error(
      `mapping references unknown collection "${spec.collection}" ` +
      `(found: ${names.join(', ') || 'none'})`
    );
  }
}

/**
 * Attach Mongo mapping support to a runtime.
 *
 * Registered as ordinary handlers, so dedupe on event id, ordering and retry
 * all still apply. The difference is only where the effect lands.
 */
function attach(rz, db, { validate = true } = {}) {
  const registered = new Map();

  async function map(eventType, rawSpec) {
    const spec = normalise(eventType, rawSpec);
    if (validate) await validateAgainstDatabase(db, spec);
    registered.set(eventType, spec);

    rz.on(eventType, async (event, tx, meta) => {
      const stmt = compile(spec, event, meta && meta.eventId);
      if (stmt.skip) return;
      await db.collection(stmt.collection).updateOne(stmt.filter, stmt.update, { upsert: stmt.upsert });
    });

    return spec;
  }

  return { map, registered, compile, normalise };
}

module.exports = { attach, compile, normalise, pluck, resolve, validateAgainstDatabase, APPLIED };
