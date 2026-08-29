'use strict';

/**
 * Declarative event mapping — the merchant stops writing webhook handlers.
 *
 * The runtime already guarantees that an event reaches business logic once, in
 * order, verified, inside a transaction. What it cannot guarantee is that the
 * business logic itself is any good. Running Raze against a real published
 * integration made that concrete: their handler threw on every delivery because
 * a Mongoose method had been removed, caught its own exception, and answered
 * 200. Raze kept the event and surfaced the error, but it could not make a
 * broken handler work.
 *
 * A mapping removes the handler. The merchant declares what an event means for
 * their data — which table, which key, which columns — and Raze compiles that to
 * parameterised SQL executed inside the same transaction as the dedupe write.
 *
 * There is no merchant code in the request path, so there is nothing to throw,
 * hang, forget to respond, or half-apply.
 *
 *   rz.map('payment.captured', {
 *     table: 'orders',
 *     key:   { column: 'order_id', from: 'payload.payment.entity.order_id' },
 *     set:   { status: 'paid' },
 *     add:   { credited_paise: 'payload.payment.entity.amount' },
 *     guard: { column: 'status', notIn: ['refunded'] },
 *   });
 *
 * SAFETY
 * Table and column names cannot be parameterised in SQL, so every identifier in
 * a mapping is validated against the database's own catalogue before any
 * statement is built. A mapping naming a table or column that does not exist is
 * rejected at registration, not at delivery time — a webhook arriving at 3am is
 * the wrong moment to discover a typo. Values are always bound parameters.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/** Read a dotted path out of the event. Returns undefined if any step is missing. */
function pluck(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function assertIdent(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`invalid ${what}: ${JSON.stringify(name)} — must match ${IDENT}`);
  }
  return name;
}

/**
 * Check the mapping against the live schema.
 *
 * Rejecting at registration is the whole point: a mapping that names a column
 * which does not exist is a deployment mistake, and it should fail when the
 * process starts rather than when a payment arrives.
 */
async function validateAgainstSchema(pool, spec) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [spec.table]
  );
  if (rows.length === 0) throw new Error(`mapping references unknown table "${spec.table}"`);
  const columns = new Set(rows.map((r) => r.column_name));

  const used = [
    spec.key.column,
    ...Object.keys(spec.set || {}),
    ...Object.keys(spec.add || {}),
    ...(spec.guard ? [spec.guard.column] : []),
  ];
  for (const c of used) {
    if (!columns.has(c)) {
      throw new Error(`mapping references unknown column "${spec.table}.${c}"`);
    }
  }
}

function normalise(eventType, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('a mapping spec is required');
  if (!raw.table) throw new Error('mapping needs a table');
  if (!raw.key || !raw.key.column || !raw.key.from) {
    throw new Error('mapping needs key: { column, from }');
  }

  const spec = {
    eventType,
    table: assertIdent(raw.table, 'table name'),
    key: {
      column: assertIdent(raw.key.column, 'key column'),
      from: String(raw.key.from),
    },
    set: {},
    add: {},
    guard: null,
    insertIfMissing: raw.insertIfMissing !== false,
  };

  for (const [col, source] of Object.entries(raw.set || {})) {
    spec.set[assertIdent(col, 'set column')] = source;
  }
  for (const [col, source] of Object.entries(raw.add || {})) {
    // Kept as given. Coercing to a string here would turn { literal: 1 } into
    // "[object Object]", which resolve() cannot read and compile() would then
    // skip — silently applying nothing.
    spec.add[assertIdent(col, 'add column')] = source;
  }
  if (raw.guard) {
    spec.guard = {
      column: assertIdent(raw.guard.column, 'guard column'),
      notIn: Array.isArray(raw.guard.notIn) ? raw.guard.notIn : [],
    };
  }
  if (Object.keys(spec.set).length === 0 && Object.keys(spec.add).length === 0) {
    throw new Error('mapping needs at least one of set or add');
  }
  return spec;
}

/**
 * Resolve a declared value against the event.
 *
 * A string that matches a path in the event is read from it; anything else is
 * treated as a literal. `{ literal: x }` forces the literal reading when a
 * constant would otherwise look like a path.
 */
function resolve(source, event) {
  if (source && typeof source === 'object' && 'literal' in source) return source.literal;
  if (typeof source === 'string') {
    const found = pluck(event, source);
    return found === undefined ? source : found;
  }
  return source;
}

/**
 * Compile a mapping and an event into one statement.
 *
 * The generated SQL is an upsert whose UPDATE branch is guarded, so applying it
 * is safe regardless of whether the row exists yet and regardless of the order
 * events arrive in. Identifiers were validated at registration; every value here
 * is a bound parameter.
 */
function compile(spec, event) {
  const keyValue = pluck(event, spec.key.from);
  if (keyValue === undefined || keyValue === null) {
    return { skip: `no value at ${spec.key.from}` };
  }

  const params = [keyValue];
  const setCols = [];
  const insertCols = [spec.key.column];
  const insertVals = ['$1'];

  for (const [col, source] of Object.entries(spec.set)) {
    params.push(resolve(source, event));
    const p = `$${params.length}`;
    setCols.push(`"${col}" = ${p}`);
    insertCols.push(col);
    insertVals.push(p);
  }

  for (const [col, source] of Object.entries(spec.add)) {
    const amount = Number(resolve(source, event));
    if (!Number.isFinite(amount)) {
      return { skip: `no numeric value for "${col}" from ${JSON.stringify(source)}` };
    }
    params.push(amount);
    const p = `$${params.length}`;
    setCols.push(`"${col}" = "${spec.table}"."${col}" + ${p}`);
    insertCols.push(col);
    insertVals.push(p);
  }

  let where = '';
  if (spec.guard && spec.guard.notIn.length) {
    params.push(spec.guard.notIn);
    where = ` WHERE "${spec.table}"."${spec.guard.column}" <> ALL($${params.length})`;
  }

  const cols = insertCols.map((c) => `"${c}"`).join(', ');
  const sql = spec.insertIfMissing
    ? `INSERT INTO "${spec.table}" (${cols}) VALUES (${insertVals.join(', ')})
       ON CONFLICT ("${spec.key.column}") DO UPDATE SET ${setCols.join(', ')}${where}`
    : `UPDATE "${spec.table}" SET ${setCols.join(', ')}
        WHERE "${spec.table}"."${spec.key.column}" = $1${where ? where.replace(' WHERE', ' AND') : ''}`;

  return { sql, params, keyValue };
}

/**
 * Attach mapping support to a runtime instance.
 *
 * Mappings are registered as ordinary handlers, so they inherit every guarantee
 * the runtime already provides: dedupe on event id, ordering, and one
 * transaction shared with the inbox write.
 */
function attach(rz, pool) {
  const registered = new Map();

  async function map(eventType, rawSpec) {
    const spec = normalise(eventType, rawSpec);
    await validateAgainstSchema(pool, spec);
    registered.set(eventType, spec);

    rz.on(eventType, async (event, tx) => {
      const stmt = compile(spec, event);
      if (stmt.skip) return; // nothing addressable in this event; not an error
      await tx.query(stmt.sql, stmt.params);
    });

    return spec;
  }

  return { map, registered, compile, normalise, pluck };
}

module.exports = { attach, compile, normalise, pluck, resolve, validateAgainstSchema };
