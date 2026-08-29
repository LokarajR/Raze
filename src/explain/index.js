'use strict';

/**
 * Optional LLM explanation layer.
 *
 * The LLM explains findings the deterministic engine has already confirmed. It
 * never discovers, never decides, never gates. Every other raze command runs
 * with no API key; this one is the single exception, and it degrades to a
 * built-in explanation rather than failing.
 */

const FINDINGS = {
  'duplicate-delivery': {
    what: 'The same event was applied to business state more than once.',
    why: 'Razorpay retries a failed delivery with a byte-identical body and an unchanged '
       + 'x-razorpay-event-id. Measured across four runs, the first retry lands 0.23s after '
       + 'the original for payment events.',
    fix: 'Record every event id you have applied and make the handler a no-op on a repeat. '
       + 'Commit that record in the same transaction as the business write, or a crash '
       + 'between the two reintroduces the bug.',
  },
  'timeout-retry': {
    what: 'A slow handler received a duplicate it did not cause, and applied it.',
    why: 'An endpoint that processes synchronously and answers after Razorpay\'s timeout is '
       + 'sent a retry. Acknowledging before processing is what prevents it.',
    fix: 'Respond 200 as soon as the event is durably stored, then process asynchronously.',
  },
  'tampered-signature': {
    what: 'A payload with an invalid signature was accepted and changed business state.',
    why: 'Without HMAC verification over the raw body, anyone who learns the endpoint URL '
       + 'can move money in your database.',
    fix: 'Verify HMAC-SHA256 of the exact received bytes against your webhook secret before '
       + 'parsing. Reserializing parsed JSON changes the bytes and breaks verification.',
  },
  'out-of-order': {
    what: 'Order state moved backwards.',
    why: 'Razorpay does not guarantee ordering, and retries interleave events further.',
    fix: 'Rank the event types and refuse transitions that would lower a subject\'s rank.',
  },
  'refund-event': {
    what: 'A refund did not produce the correct final state.',
    why: 'refund.created carries both the refund and payment entities; the order id is on '
       + 'the payment. Refunds also skip the instant retry, arriving ~6-9s later.',
    fix: 'Read the order from payload.payment.entity.order_id, and dedupe refunds exactly '
       + 'as you dedupe payments.',
  },
};

async function explain(finding, env) {
  const known = FINDINGS[finding];
  if (!known) {
    return `Unknown finding: ${finding}\nKnown: ${Object.keys(FINDINGS).join(', ')}`;
  }

  const base = `${finding}\n\n  What happened\n    ${known.what}\n\n  Why\n    ${known.why}\n\n  Fix\n    ${known.fix}`;

  const key = env.ANTHROPIC_API_KEY;
  if (!key) return `${base}\n\n  (set ANTHROPIC_API_KEY for a tailored explanation)`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `A deterministic webhook-correctness engine confirmed this finding in a `
            + `Razorpay integration. Explain it to the engineer who has to fix it, in under `
            + `150 words. Do not speculate beyond what is stated.\n\n${base}`,
        }],
      }),
    });
    if (!res.ok) return `${base}\n\n  (LLM unavailable: HTTP ${res.status})`;
    const body = await res.json();
    const text = body.content?.map((c) => c.text).join('') || '';
    return text ? `${finding}\n\n${text}` : base;
  } catch (err) {
    return `${base}\n\n  (LLM unavailable: ${err.message})`;
  }
}

module.exports = { explain, FINDINGS };
