'use strict';

/**
 * Working out a merchant's payment model from their schema.
 *
 * Name matching handles schemas that happen to use the words Raze expects, and
 * falls over on `gateway_order_id` / `order_state` / `amount_settled_paise`
 * — which is what a real store's columns look like. A model reads those the way
 * a person would.
 *
 * THE DIVISION THAT MAKES THIS SAFE
 *
 * The model proposes; deterministic code disposes. It sees column names, types,
 * and a few sample values, and returns which column it believes is which. Every
 * claim it makes is then checked against the live database: the columns must
 * exist, the types must be right, the key column's values must actually look
 * like Razorpay order ids, and the expected-amount column must not be the same
 * one money is credited to. Anything that fails a check is dropped, and if what
 * survives is not enough to build a mapping, the merchant is asked.
 *
 * So a wrong answer from the model cannot arm a wrong mapping. The worst it can
 * do is fail a check and cost the merchant a question.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const RAZE = path.join(__dirname, '..', '..');

/** Where the Claude binary actually is; the PATH entry is a shim on Windows. */
function claudeBinary() {
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai',
      'claude-code', 'bin', 'claude.exe'));
  }
  candidates.push(path.join(process.env.HOME || '', '.local', 'bin', 'claude'));
  candidates.push('/usr/local/bin/claude');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return { cmd: c, shell: false }; } catch {}
  }
  return { cmd: 'claude', shell: true };
}

/**
 * What the model is shown.
 *
 * Column names, types, and up to three sample values per textual column. Sample
 * values are what let it tell an order reference from a customer reference, and
 * three is enough to see a format without hauling a merchant's data through a
 * prompt.
 */
async function describeSchema(pool, { maxTables = 12, samples = 3 } = {}) {
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`);

  const tables = new Map();
  for (const r of cols.rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name).push({ name: r.column_name, type: r.data_type });
  }

  const out = [];
  for (const [name, columns] of [...tables].slice(0, maxTables)) {
    let rowCount = null;
    try {
      const c = await pool.query(`SELECT count(*)::int n FROM "${name}"`);
      rowCount = c.rows[0].n;
    } catch {}

    const described = [];
    for (const col of columns) {
      const entry = { name: col.name, type: col.type };
      if (/char|text|uuid/i.test(col.type)) {
        try {
          const s = await pool.query(
            `SELECT DISTINCT "${col.name}" AS v FROM "${name}"
              WHERE "${col.name}" IS NOT NULL LIMIT ${samples}`);
          entry.examples = s.rows.map((r) => String(r.v).slice(0, 40));
        } catch {}
      }
      described.push(entry);
    }
    out.push({ table: name, rows: rowCount, columns: described });
  }
  return out;
}

const PROMPT = `You are reading a merchant's PostgreSQL schema to work out how their orders
relate to Razorpay payments. Razorpay order ids look like "order_ABC123xyz".

Identify, if they exist:

  table      the table holding customer orders, one row per order
  key        the column holding the Razorpay order id for that order
  status     the column saying whether the order is paid
  credited   the column money is added to when a payment settles
  expected   the column recording what the order SHOULD cost, if different
             from credited

The distinction between "credited" and "expected" matters more than anything
else here. One records what has been received; the other what was owed. If a
schema has only one money column, there is no "expected" — say null rather than
reusing the credited column. Guessing wrong there would make a payment verify
against a figure the payment itself wrote.

Return ONLY a JSON object, no prose, no code fence:

{"table":"...","key":"...","status":"...","credited":"...","expected":"..."|null,
 "confidence":"high"|"medium"|"low",
 "reasoning":"one or two sentences a shop owner would understand"}

If no table here holds orders, return {"table":null,"reasoning":"..."}.

Schema:
`;

function askModel(payload, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const bin = claudeBinary();
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(bin.cmd, [
      '-p', PROMPT + JSON.stringify(payload, null, 1),
      '--output-format', 'json',
    ], { cwd: RAZE, env, stdio: ['ignore', 'pipe', 'pipe'], shell: bin.shell });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ error: 'took too long' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const line = out.trim().split('\n').filter(Boolean).pop();
        const wrapper = JSON.parse(line);
        const text = String(wrapper.result || '').trim()
          .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        resolve(JSON.parse(text));
      } catch {
        resolve({ error: 'could not read the answer. ' + (err.split('\n')[0] || '').slice(0, 120) });
      }
    });
  });
}

/**
 * Check every claim against the database before any of it is believed.
 *
 * This is the half that makes a model safe to use here. Each check corresponds
 * to a way a confident wrong answer would cost a merchant money.
 */
async function verify(pool, claim) {
  const problems = [];
  if (!claim || !claim.table) return { ok: false, problems: ['no orders table was identified'] };

  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name = $1`, [claim.table]);
  if (cols.rowCount === 0) return { ok: false, problems: [`no table named "${claim.table}"`] };

  const types = new Map(cols.rows.map((r) => [r.column_name, r.data_type]));
  const need = ['key', 'status', 'credited'];
  for (const field of need) {
    const col = claim[field];
    if (!col) { problems.push(`no ${field} column was identified`); continue; }
    if (!types.has(col)) { problems.push(`"${col}" is not a column of ${claim.table}`); continue; }
  }

  // Money columns must hold numbers, or the mapping cannot add to them.
  for (const field of ['credited', 'expected']) {
    const col = claim[field];
    if (col && types.has(col) && !/int|numeric|decimal|money|real|double/i.test(types.get(col))) {
      problems.push(`"${col}" is ${types.get(col)}, which cannot hold an amount`);
    }
  }

  // The one mistake that would corrupt the check itself.
  if (claim.expected && claim.expected === claim.credited) {
    problems.push('the expected amount and the credited amount are the same column');
  }

  // The key must actually carry Razorpay order ids where it is populated. A
  // column that never does is not the key, whatever it is called.
  if (claim.key && types.has(claim.key)) {
    try {
      const s = await pool.query(
        `SELECT "${claim.key}" AS v FROM "${claim.table}"
          WHERE "${claim.key}" IS NOT NULL LIMIT 20`);
      if (s.rowCount > 0) {
        const looks = s.rows.filter((r) => /^order_[A-Za-z0-9]{8,}$/.test(String(r.v))).length;
        if (looks / s.rowCount < 0.8) {
          problems.push(`"${claim.key}" does not hold Razorpay order ids `
            + `(${looks} of ${s.rowCount} sampled values match)`);
        }
      }
      // Empty is fine: a merchant who has never been paid has an empty column,
      // and refusing them would be refusing the case Raze exists for.
    } catch (err) { problems.push(`could not read "${claim.key}": ${err.message}`); }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Read the schema, ask, check, and report what survived.
 */
async function understand(pool) {
  const schema = await describeSchema(pool);
  if (!schema.length) return { ok: false, why: 'this database has no tables' };

  const claim = await askModel({ tables: schema });
  if (claim.error) return { ok: false, why: claim.error, schema };
  if (!claim.table) {
    return { ok: false, why: claim.reasoning || 'no table here holds orders', schema };
  }

  const checked = await verify(pool, claim);
  return {
    ok: checked.ok,
    claim,
    problems: checked.problems,
    schema,
    why: checked.ok ? null : checked.problems.join('; '),
  };
}

module.exports = { understand, describeSchema, verify, askModel };
