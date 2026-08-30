'use strict';

/**
 * Test credentials, and what to do when there are none.
 *
 * A fresh clone has no .env. The README tells a reader to run the offline suite
 * first, so that suite has to work on a machine that has never seen a Razorpay
 * key — and it has to do so without quietly turning off the thing it is testing.
 *
 * The bundled deliveries are real captured bytes. Their signatures were produced
 * with a webhook secret that is not in this repository and never will be, so
 * offline those signatures cannot be verified. The answer is not to skip
 * signature verification — that is the single most important check in Layer 1 —
 * but to re-sign the same bytes with a test-only secret. The raw-byte handling,
 * the HMAC comparison, and the rejection of forged and truncated bodies are all
 * exercised for real either way. The one claim that needs the real secret is
 * "these exact bytes were signed by Razorpay", which is a provenance claim about
 * the corpus, not a code path in Raze.
 *
 * With RAZORPAY_WEBHOOK_SECRET present, the captured signatures are used as-is
 * and that provenance claim is tested too.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

/** Both files are optional; a missing one is not an error. */
function loadEnv() {
  const out = {};
  for (const p of [path.join(__dirname, '..', '.env'), path.join(ROOT, 'probe-server', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0 && !line.trim().startsWith('#')) {
          const k = line.slice(0, i).trim();
          if (!(k in out)) out[k] = line.slice(i + 1).trim();
        }
      }
    } catch {}
  }
  return { ...out, ...process.env };
}

const TEST_SECRET = 'raze-offline-test-secret';

function signing(env) {
  const real = env.RAZORPAY_WEBHOOK_SECRET || null;
  const secret = real || TEST_SECRET;
  const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
  return {
    secret,
    real: !!real,
    sign,
    /** The signature to send for these exact bytes. */
    forBytes(body, captured) {
      return real ? captured : sign(body);
    },
    /** The signature to send for a captured delivery. */
    of(delivery) {
      return real ? delivery.signature : sign(delivery.body);
    },
    banner() {
      return real
        ? '  signatures: real captured Razorpay signatures (RAZORPAY_WEBHOOK_SECRET found)'
        : '  signatures: no credentials on this machine — the same captured bytes,\n' +
          '              re-signed with a test secret. Verification is still real.';
    },
  };
}

module.exports = { loadEnv, signing, ROOT, TEST_SECRET };
