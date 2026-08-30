'use strict';

/**
 * The webhook secret a local demonstration should use.
 *
 * The runtime refuses to start without a secret, because a runtime that accepts
 * unverified deliveries is worse than no runtime at all. That is right for a
 * merchant, but it made `raze demo` unrunnable on a machine with no Razorpay
 * account — and the demo drives merchants it starts itself, so there is nothing
 * to be gained by leaving them unconfigured.
 *
 * When no secret is configured, a demo-only one is used. Every party in the
 * demonstration is local and gets the same value: the merchants Raze starts, and
 * the auditor that signs the probes. Signature verification is fully exercised —
 * the tampered-signature probe runs rather than being skipped — which is more
 * than the previous behaviour, not less.
 *
 * This is never a fallback for a real merchant. `raze up` and `raze protect`
 * take the merchant's own secret and fail loudly without it.
 */

const DEMO_SECRET = 'raze-demo-secret-not-for-production';

function resolveDemoSecret(env) {
  const real = (env && env.RAZORPAY_WEBHOOK_SECRET) || null;
  return {
    secret: real || DEMO_SECRET,
    real: !!real,
    note: real
      ? 'webhook secret: from your configuration'
      : 'webhook secret: none configured — using a demo-only secret shared by the\n'
        + '                local merchants and the auditor, so signature checks still run',
  };
}

module.exports = { resolveDemoSecret, DEMO_SECRET };
