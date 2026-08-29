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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the embedded server, retrying on a startup race.
 *
 * Consecutive processes using the same data directory — the four test files run
 * back to back, for instance — can collide: the previous postmaster has exited
 * but has not yet released its shared memory block, and the new one dies with
 * "pre-existing shared memory block is still in use". That is transient, so it is
 * worth retrying rather than failing a whole suite on it.
 */
async function startEmbedded({ attempts = 4 } = {}) {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default || mod;

  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    embedded = new EmbeddedPostgres({
      databaseDir: PGDATA,
      user: 'raze',
      password: 'raze',
      port: EMBEDDED_PORT,
      persistent: true,
    });
    try {
      if (!fs.existsSync(PGDATA)) await embedded.initialise();
      await embedded.start();
      return `postgres://raze:raze@127.0.0.1:${EMBEDDED_PORT}/postgres`;
    } catch (err) {
      lastErr = err;
      embedded = null;
      // A stale lock file from a killed process blocks every subsequent start.
      try { fs.unlinkSync(path.join(PGDATA, 'postmaster.pid')); } catch {}
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw new Error(
    `embedded postgres failed to start after ${attempts} attempts: ${lastErr && lastErr.message}
` +
    'If another raze process is running, stop it — or set DATABASE_URL to use your own postgres.'
  );
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
  if (embedded) {
    await embedded.stop().catch(() => {});
    // Give the postmaster time to release its shared memory block before the
    // next process in the same suite tries to bind the same data directory.
    await sleep(700);
  }
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
