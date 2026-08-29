#!/usr/bin/env node
'use strict';

/**
 * Suite runner.
 *
 * Starts one embedded PostgreSQL, hands its URL to every test file through
 * DATABASE_URL, then stops it once at the end.
 *
 * Running the four files directly also works, but each one would start and stop
 * its own server against the same data directory. Consecutive starts can collide
 * — the previous postmaster has exited without yet releasing its shared memory
 * block — which fails a suite for reasons that have nothing to do with the code
 * under test. One server for the whole run removes the race rather than retrying
 * through it.
 *
 * Honours an existing DATABASE_URL, so CI or a docker compose Postgres is used
 * as-is.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { connect, shutdown } = require('../src/db');

const FILES = [
  'layer1.test.js',
  'layer2.test.js',
  'layer3.test.js',
  'layer4.test.js',
  'layer5.test.js',
  'layer6.test.js',
];

// Layers 2 and 3 talk to the live Razorpay API; layers 1 and 4 need only the
// captured corpus.
const OFFLINE_ONLY = new Set(['layer1.test.js', 'layer4.test.js', 'layer5.test.js', 'layer6.test.js']);

async function main() {
  const offline = process.argv.includes('--offline');
  const files = FILES.filter((f) => !offline || OFFLINE_ONLY.has(f));

  const external = !!process.env.DATABASE_URL;
  let pool = null;
  let url = process.env.DATABASE_URL;

  if (!external) {
    const conn = await connect();
    pool = conn.pool;
    url = conn.url;
    console.log(`\nsuite: one embedded postgres for ${files.length} file(s)\n`);
  } else {
    console.log(`\nsuite: using DATABASE_URL for ${files.length} file(s)\n`);
  }

  const results = [];
  for (const f of files) {
    const res = spawnSync(process.execPath, [path.join(__dirname, f)], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    });
    results.push({ file: f, code: res.status });
    if (res.status !== 0) break; // a failing layer makes later layers unreadable
  }

  if (!external) await shutdown(pool);

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${'='.repeat(52)}`);
  for (const r of results) {
    console.log(`  ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.file}`);
  }
  const skipped = files.length - results.length;
  if (skipped > 0) console.log(`  ${skipped} file(s) not run after the failure above`);
  console.log(`${'='.repeat(52)}\n`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nsuite runner failed: ${err.message}\n`);
  process.exit(1);
});
