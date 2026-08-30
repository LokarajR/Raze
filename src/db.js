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
const net = require('net');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const PGDATA = path.join(ROOT, '.pgdata');
const PREFERRED_PORT = Number(process.env.RAZE_PG_PORT || 55432);

let embedded = null;
let reusedExternal = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is a process with this pid running? EPERM means yes, owned by someone else. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

/** Can something accept a connection on this port right now? */
function listening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    // Never let a probe keep the process alive. Postgres does not complete the
    // close on its side, so a probe socket sits in FIN_WAIT_2 and holds the
    // event loop until the OS times it out — which made `raze demo` print its
    // whole report and then hang instead of exiting.
    sock.unref();
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

/** The postmaster this data directory believes it owns: { pid, port } or null. */
function recordedPostmaster() {
  try {
    const lines = fs.readFileSync(path.join(PGDATA, 'postmaster.pid'), 'utf8').split('\n');
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    if (!pid || !port) return null;
    return { pid, port };
  } catch { return null; }
}

/** First port from `start` that nothing is listening on. */
async function freePort(start) {
  for (let p = start; p < start + 40; p++) {
    if (!(await listening(p))) return p;
  }
  throw new Error(`no free port in ${start}..${start + 39} for the embedded postgres`);
}

/**
 * Postgres processes started from THIS checkout that are still alive.
 *
 * A run that was interrupted — Ctrl-C, a killed test, a crash — can leave a
 * postgres child behind. The postmaster is gone, so postmaster.pid is gone too
 * and nothing looks wrong, but the orphan still holds the shared memory segment
 * and the next start dies with "pre-existing shared memory block is still in
 * use". That is the second-run failure a reader hits after their first run.
 *
 * Matching on the binary path keeps this narrow: only postgres processes
 * launched from this checkout's own node_modules are ever considered, so a
 * system postgres, or another checkout's, is never touched.
 */
function ownPostgresPids() {
  const mine = path.join(ROOT, 'node_modules', '@embedded-postgres').toLowerCase();
  const norm = (s) => s.replace(/\//g, '\\').toLowerCase();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
        "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
        { encoding: 'utf8', timeout: 20000 });
      return (out.stdout || '').split('\n')
        .map((l) => l.trim().split('|'))
        .filter((r) => r.length === 2 && norm(r[1]).includes(norm(mine)))
        .map((r) => Number(r[0]))
        .filter(Boolean);
    }
    const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 20000 });
    return (out.stdout || '').split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m) => m && m[2].toLowerCase().includes(mine))
      .map((m) => Number(m[1]));
  } catch { return []; }
}

/** Stop orphans from this checkout. Returns how many were signalled. */
function killOwnPostgres() {
  const pids = ownPostgresPids();
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 20000 });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {}
  }
  return pids.length;
}

/**
 * Start the embedded server.
 *
 * Three situations have to be told apart, and getting them wrong is what makes a
 * second machine — or a second checkout on one machine — fail:
 *
 *   this checkout's server is already running   reuse it; do not touch its data
 *                                               directory and do not stop it on
 *                                               exit, because we did not start it
 *   another checkout holds the preferred port   move to the next free port; the
 *                                               data directories are separate, so
 *                                               only the port ever collided
 *   a killed run left a stale lock file         remove it, but only after
 *                                               confirming the pid is dead
 *
 * The old code deleted postmaster.pid on any failure, which meant a live server
 * could have its lock file removed underneath it.
 */
async function startEmbedded({ attempts = 4 } = {}) {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default || mod;

  // Already ours and already up.
  const rec = recordedPostmaster();
  if (rec && alive(rec.pid) && (await listening(rec.port))) {
    reusedExternal = true;
    return `postgres://raze:raze@127.0.0.1:${rec.port}/postgres`;
  }

  // Dead owner: the lock file is genuinely stale and safe to clear.
  if (rec && !alive(rec.pid)) {
    try { fs.unlinkSync(path.join(PGDATA, 'postmaster.pid')); } catch {}
  }

  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    // Recomputed per attempt: another process may have taken the port meanwhile.
    const port = process.env.RAZE_PG_PORT
      ? PREFERRED_PORT
      : await freePort(PREFERRED_PORT);

    embedded = new EmbeddedPostgres({
      databaseDir: PGDATA,
      user: 'raze',
      password: 'raze',
      port,
      persistent: true,
    });
    try {
      if (!fs.existsSync(PGDATA)) await embedded.initialise();
      await embedded.start();
      return `postgres://raze:raze@127.0.0.1:${port}/postgres`;
    } catch (err) {
      lastErr = err;
      embedded = null;
      // Only ever clear a lock file whose owner is gone. A shared-memory race
      // leaves no owner; a running server does, and must be left alone.
      const r = recordedPostmaster();
      if (r && !alive(r.pid)) {
        try { fs.unlinkSync(path.join(PGDATA, 'postmaster.pid')); } catch {}
      }
      // An orphan from an interrupted run holds the shared memory segment and
      // will hold it forever. Nothing else can clear it, and it belongs to this
      // checkout, so stopping it is ours to do.
      if (/shared memory|already in use|lock file/i.test(String(lastErr && lastErr.message))
          || lastErr === undefined || (lastErr && !lastErr.message)) {
        if (killOwnPostgres() > 0) await sleep(1200);
      }
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw new Error(
    `embedded postgres failed to start after ${attempts} attempts: ${lastErr && lastErr.message}\n` +
    'Set DATABASE_URL to use your own postgres, or RAZE_PG_PORT to pick the port.'
  );
}

async function connect() {
  const url = process.env.DATABASE_URL || (await startEmbedded());
  const pool = new Pool({ connectionString: url, max: 8 });

  // An idle client losing its connection emits 'error' on the pool. Unhandled,
  // that is an uncaught exception and the process dies — so a database restart,
  // a network blip or a failover would take down the very daemon that is
  // supposed to guarantee nothing is lost. The pool discards the broken client
  // and hands out a fresh one; the next query reconnects. Logged, not fatal.
  pool.on('error', (err) => {
    console.error(`postgres connection dropped: ${err.message} (pool will reconnect)`);
  });

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
  // A server we merely found running belongs to another process; stopping it
  // would break whoever started it.
  if (embedded && !reusedExternal) {
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
