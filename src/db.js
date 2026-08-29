'use strict';

/**
 * Database access.
 *
 * Two ways to get a Postgres:
 *
 *   DATABASE_URL set   -> connect to it (docker compose, Railway, a judge's own)
 *   nothing set        -> start an embedded PostgreSQL under raze/.pgdata
 *
 * The embedded path exists so `raze demo` runs on a machine with no Docker, no
 * admin rights and no database installed. It is real PostgreSQL — same binaries,
 * same wire protocol, BYTEA, JSONB and FOR UPDATE SKIP LOCKED all behave
 * identically. It is not a substitute or an emulation.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const PGDATA = path.join(ROOT, '.pgdata');
const EMBEDDED_PORT = Number(process.env.RAZE_PG_PORT || 55432);

let embedded = null;

async function startEmbedded() {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default || mod;
  embedded = new EmbeddedPostgres({
    databaseDir: PGDATA,
    user: 'raze',
    password: 'raze',
    port: EMBEDDED_PORT,
    persistent: true,
  });
  if (!fs.existsSync(PGDATA)) await embedded.initialise();
  await embedded.start();
  return `postgres://raze:raze@127.0.0.1:${EMBEDDED_PORT}/postgres`;
}

async function connect() {
  const url = process.env.DATABASE_URL || (await startEmbedded());
  const pool = new Pool({ connectionString: url, max: 8 });
  // Fail fast and clearly rather than surfacing a socket error mid-transaction.
  await pool.query('SELECT 1');
  return { pool, url, embedded: !process.env.DATABASE_URL };
}

async function migrate(pool) {
  const dir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return files;
}

async function shutdown(pool) {
  if (pool) await pool.end().catch(() => {});
  if (embedded) await embedded.stop().catch(() => {});
  embedded = null;
}

/**
 * Run fn inside a transaction, handing it the client. Commits on return,
 * rolls back on throw. Every business-state write in Raze goes through this.
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { connect, migrate, shutdown, withTransaction, PGDATA };
