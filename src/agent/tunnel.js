'use strict';

/**
 * Giving Raze an address Razorpay can reach.
 *
 * Razorpay refuses localhost at save time, so a console running on someone's
 * laptop has nowhere for deliveries to go. A merchant should not have to know
 * that, install anything, or sign up for a tunnelling service to find out.
 *
 * So Raze fetches cloudflared itself — a single binary, no account, no
 * configuration — opens a temporary public address, and registers that. It is a
 * development convenience and is described as one: a merchant running Raze on
 * their own server already has an address, and none of this happens.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * Persist. The address dies with the process, which is correct for something a
 * merchant is trying out on a laptop. Raze notices its own webhook has gone
 * stale and says so rather than reporting a URL that stopped existing.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAZE = path.join(__dirname, '..', '..');
const BIN_DIR = path.join(RAZE, '.raze-bin');

const RELEASES = {
  win32: { x64: 'cloudflared-windows-amd64.exe', arm64: 'cloudflared-windows-arm64.exe' },
  darwin: { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-arm64.tgz' },
  linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64' },
};

function onPath() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which',
    ['cloudflared'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split('\n')[0].trim();
  return null;
}

function localBinary() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const p = path.join(BIN_DIR, name);
  return fs.existsSync(p) ? p : null;
}

/**
 * Fetch the binary if it is not already here.
 *
 * macOS ships as a tarball rather than a bare binary, and unpacking one without
 * a dependency is more trouble than it is worth — so that platform is told to
 * install it rather than left with a broken download.
 */
async function ensure({ onProgress = () => {} } = {}) {
  const existing = localBinary() || onPath();
  if (existing) return { ok: true, path: existing, downloaded: false };

  const asset = (RELEASES[process.platform] || {})[process.arch];
  if (!asset) {
    return { ok: false, why: `no cloudflared build for ${process.platform}/${process.arch}` };
  }
  if (asset.endsWith('.tgz')) {
    return {
      ok: false,
      why: 'on macOS cloudflared ships as an archive — `brew install cloudflared` once, and '
        + 'Raze will use it from there',
    };
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  onProgress('fetching cloudflared');

  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, why: `could not download cloudflared (HTTP ${res.status})` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    return { ok: true, path: dest, downloaded: true, bytes: buf.length };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

/**
 * Open a public address pointing at a local port.
 *
 * Resolves once cloudflared has printed the address it was given. It prints to
 * stderr, which is easy to miss and the reason an earlier version of this sat
 * waiting for output that had already arrived somewhere else.
 */
function open(port, { timeoutMs = 150000, onProgress = () => {} } = {}) {
  return new Promise(async (resolve) => {
    const bin = await ensure({ onProgress });
    if (!bin.ok) return resolve({ ok: false, why: bin.why });

    onProgress('opening a public address');
    const child = spawn(bin.path, [
      'tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    // cloudflared prints in several chunks; without this every chunk starts its
    // own wait against the same address.
    let waiting = false;
    let url = null;
    let registered = false;
    const finish = (out) => { if (!settled) { settled = true; resolve(out); } };

    /**
     * An address cloudflared has printed is not yet an address that answers.
     * Razorpay validates the URL when it registers a webhook, and handing it one
     * before the edge is carrying traffic fails with "no such host" — so this
     * waits for two things in order.
     *
     * The authority is cloudflared's own "Registered tunnel connection" line:
     * that is the edge saying it will now route to this process. A local HTTP
     * probe is only a confirmation on top of it, and deliberately not a veto —
     * this machine's resolver is not the resolver Razorpay uses, and an earlier
     * version of this threw away perfectly good tunnels because a local lookup
     * had not caught up. When the probe does not come through, the address is
     * still returned, marked unverified, and the caller says so.
     */
    const wait = async () => {
      waiting = true;
      onProgress('waiting for the address to resolve');
      for (let i = 0; i < 15 && !registered; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!registered) {
        child.kill();
        return finish({ ok: false, why: 'cloudflared never registered a connection' });
      }
      for (let i = 0; i < 20; i++) {
        try {
          const probe = await fetch(url + '/health');
          if (probe.ok) return finish({ ok: true, url, verified: true, stop: () => child.kill(), child });
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      finish({ ok: true, url, verified: false, stop: () => child.kill(), child });
    };

    const look = (chunk) => {
      const text = String(chunk);
      if (/Registered tunnel connection/i.test(text)) registered = true;
      if (settled) return;
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !url) url = m[0];
      if (url && !waiting) wait();
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);

    child.on('error', (e) => finish({ ok: false, why: e.message }));
    child.on('exit', (code) => finish({ ok: false, why: `cloudflared exited (${code})` }));

    setTimeout(() => {
      if (!settled) { child.kill(); finish({ ok: false, why: 'cloudflared did not report an address' }); }
    }, timeoutMs);
  });
}

module.exports = { ensure, open, BIN_DIR };
