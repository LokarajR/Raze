# Raze

Raze keeps merchant business state correct when Razorpay webhook delivery is
duplicated, delayed, rejected, or absent.

It is not a testing tool. It is a correctness layer that sits between Razorpay's
event delivery and the merchant's business state.

```
npm install
npx raze demo --sever-delivery
```

## Three mechanisms

| Mechanism | Question it answers | What it catches |
|---|---|---|
| **Protected runtime** | Did we process this event correctly? | Duplicates, forged signatures, out-of-order events, timeout-induced retries |
| **Reconciliation** | Did Razorpay record something we don't know about? | Lost or undelivered webhooks |
| **Expectation Ledger** | Was something supposed to happen that didn't? | Absence — no payment exists to reconcile against |

The third is the one a payments API cannot answer on its own. Reconciliation asks
"what did Razorpay record?" If the customer never paid, there is nothing to
enumerate and no amount of scanning will surface it. Only a deadline detects
absence.

## What is guaranteed, precisely

Raze provides **exactly-once business-state transition within Raze's
transactional boundary**. The dedupe write and the merchant handler's writes
commit in one Postgres transaction, so a crash between them rolls back both and
the event is retried cleanly.

External side effects — email, shipping APIs, WhatsApp — are **outside** that
boundary. For those Raze provides an outbox with idempotency keys: at-least-once
delivery with idempotent execution, not exactly-once execution.

Recovery from a missed delivery is **eventual, subject to Razorpay API
availability and a correct state mapping**. The reconciliation gate (§1) verifies
that mapping before anything else is built.

Every claim here is **proven against five measured failure modes**, listed below.

## Nothing is simulated

Every webhook Raze processes arrived over the network from Razorpay, or is a
byte-exact replay of one that did. Every reconciliation queries the real Razorpay
API. There is no mock server, no hand-authored payload, no fabricated timestamp.

The fixture corpus is 796 real deliveries captured during a three-day measurement
of Razorpay's actual retry behaviour — see `measurement/RESULTS.md`. Signature
verification is on throughout, which is what proves the bytes are authentic: a
constructed payload cannot produce a valid HMAC.

Two things are deliberately constructed, and both say so in their output:

- the tampered-signature probe replaces the signature header — that *is* the probe
- reconciliation reconstructs events from real API responses, marked
  `source='reconcile'` with a `recon_` event id, so a repaired event can never be
  mistaken for a delivered one

The `--sever-delivery` demo severs **Raze's own intake**. Razorpay delivery is
unaffected. It is never described as Razorpay disabling the endpoint — that is a
different behaviour, which the measurement observed separately.

## What the measurement established

These numbers drive real decisions in the code, not just documentation.

| Finding | Consequence in Raze |
|---|---|
| First retry arrives **0.23s** after the original for payment events | The runtime answers 200 before processing. A synchronous handler is guaranteed a duplicate. |
| Retries continue for **22.76 hours**, 14 doublings, up to **16 deliveries** | The retry-storm case is real, not hypothetical. |
| Anything undelivered after 22.8h is **never delivered** | Waiting is not a recovery strategy. Reconciliation is mandatory, not optional. |
| Sustained failure **disables the endpoint entirely** | Delivery never resumes without human action, so the ledger's deadline is the only signal left. |
| Refunds and failures skip the instant retry, arriving at **~6–9s** | Refund handling cannot be tuned to payment timing. |

## The five probes

`raze audit` replays real captured deliveries and reads business state **directly
from Postgres**. There is no `/test-state` endpoint — instrumentation added for a
test would be a form of simulation.

| Probe | Assertion |
|---|---|
| Duplicate delivery | One event → exactly one business-state transition |
| Tampered signature | Rejected with non-2xx, zero state change |
| Out-of-order events | Final state valid, no regression |
| Timeout-induced retry | Same final state as a single delivery |
| Refund event | Correct state mutation |

**The control case is mandatory.** Auditing a correct integration must produce
zero findings, every time, and the test suite asserts exactly that. A detector
that fires on correct code is worse than no detector.

## Merchant API

```js
const raze = require('raze');

const rz = raze.create({
  db: pool,                        // pg Pool
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  razorpay: { keyId, keySecret },
});

rz.on('payment.captured', async (event, tx) => {
  // Business logic only. Runs inside a transaction.
  // Dedupe, signature and ordering are already handled.
  await tx.query('UPDATE orders SET status = $1 WHERE id = $2',
    ['paid', event.payload.payment.entity.order_id]);
});

app.use('/webhooks/razorpay', express.raw({ type: () => true }), rz.middleware());
```

Register an expectation inside your own transaction, so an order cannot exist
without the expectation that it will be paid:

```js
await rz.expect({ subjectType: 'order', subjectId: order.id,
                  event: 'payment.captured', within: '15m' }, tx);
```

## Commands

```
raze gate                   run the reconciliation gate, write results
raze init                   run migrations, verify config
raze audit [--target ...]   run the five probes  (broken|correct|protected|URL)
raze protect                install runtime, arm ledger, start reconciliation
raze reconcile              run one reconciliation pass now
raze ledger [--sweep]       show expectations; --sweep classifies overdue ones
raze status                 show protection state
raze demo [--sever-delivery]
raze explain <finding>      LLM explanation — the only command needing an API key
```

**Every command except `explain` runs with no LLM API key.** The LLM explains
findings the deterministic engine has already confirmed. It never discovers,
never decides, never gates.

## Two modes

**Demo mode** — works immediately against the bundled merchant and the captured
delivery corpus. `docker compose up -d`, or nothing at all: with no
`DATABASE_URL`, Raze starts a real embedded PostgreSQL under `raze/.pgdata`. No
Razorpay account needed for the audit probes.

**Real mode** — supply your own Test Mode keys in `.env`, deploy the webhook
endpoint publicly, configure the webhook in your own dashboard, create real
payments.

> Clone the repository, connect a Razorpay Test Mode account, configure a public
> webhook endpoint, and Raze runs the same protection and reconciliation workflow
> against real Razorpay transactions.

Webhooks require a publicly reachable URL on port 80 or 443 — localhost is
rejected at save time. Railway, Render and Fly.io all work; see `QUICKSTART.md`.
Avoid ngrok for a live demo: a tunnel dropping mid-pitch is indistinguishable
from the product failing.

## Layout

```
raze/
├── bin/raze                  CLI
├── src/
│   ├── runtime/              Layer 1 — protected runtime
│   ├── reconcile/            Layer 3 — reconciliation daemon
│   ├── ledger/               Layer 2 — expectation ledger
│   ├── audit/                Layer 4 — the five probes
│   ├── explain/              optional LLM explanation
│   ├── db.js                 Postgres, embedded or DATABASE_URL
│   └── demo.js               scripted demonstration
├── migrations/
├── examples/demo-merchant/   one codebase, three integrations
├── gate/                     §1 gate + its recorded results
├── test/                     layer1..layer4, real API and real Postgres
└── measurement/              the 796-delivery study this is built on
```

## Honest limitations

- The reconciliation mapping depends on `order_id` being present on enumerated
  payments. The gate verified this holds; `gate/RECONCILE_GATE_RESULTS.md`
  records the evidence. If it ever stops holding, the fallback is to persist
  `payment_id` at order creation.
- Recovery cannot outrun an unavailable Razorpay API. A reconciliation run that
  could not complete is recorded as failed, never as clean — a window that was
  not covered is not the same as a window with no drift.
- The ledger cannot classify a subject Razorpay will not answer for. Those
  expectations stay open rather than being guessed at.
- `raze audit` measures the integration in front of it. It says nothing about
  code paths no probe exercises.
