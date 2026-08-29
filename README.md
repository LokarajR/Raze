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

## The measurement this is built on

Razorpay's documentation says retries happen "on an exponential backoff schedule
over 24 hours" and never publishes the schedule. Four runs against a live probe
recorded it. **796 deliveries, one continuous server process, zero restarts,
signatures verified on every one.** The corpus ships in `measurement/` and is what
every probe replays.

### The four runs

| Run | First delivery (UTC) | Last delivery (UTC) | Deliveries | Events | Purpose |
|---|---|---|---|---|---|
| **1** | `2026-08-27T14:03:39.686Z` | `2026-08-28T12:50:45.077Z` | 189 | 3 | Baseline. Payment lifecycle only. |
| **2** | `2026-08-28T13:30:03.195Z` | `2026-08-29T12:24:08.296Z` | 311 | 5 | Reproduction, plus refunds and failures |
| **3** | `2026-08-29T04:00:07.953Z` | `2026-08-29T09:45:09.550Z` | 271 | 5 | Morning slot — tests time-of-day dependence |
| **4** | `2026-08-29T12:35:08.864Z` | `2026-08-29T12:38:19.508Z` | 25 | 1 | Fourth `payment.failed` sample |

Run 3 closed on **exactly the same 231-delivery count** as Run 2, with a per-mode
table identical in every cell but one. The schedule is deterministic, not jittered,
and shows no time-of-day dependence.

### One retry ladder, end to end

Run 1, `mode-500`, `payment.captured`, event `TUouniJth9WtQ2`. Every row is a real
HTTP request that arrived from Razorpay's infrastructure:

| # | Arrived (UTC) | Since first | Gap from previous |
|---:|---|---:|---:|
| 0 | `2026-08-27T14:03:40.378Z` | 0.00s | — |
| 1 | `2026-08-27T14:03:40.612Z` | **0.23s** | 0.23s |
| 2 | `2026-08-27T14:03:46.457Z` | 6.08s | 5.84s |
| 3 | `2026-08-27T14:03:59.506Z` | 19.13s | 13.05s |
| 4 | `2026-08-27T14:04:19.924Z` | 39.55s | 20.42s |
| 5 | `2026-08-27T14:05:02.671Z` | 1.37m | 42.75s |
| 6 | `2026-08-27T14:06:24.890Z` | 2.74m | 82.22s |
| 7 | `2026-08-27T14:09:06.432Z` | 5.43m | 161.54s |
| 8 | `2026-08-27T14:14:30.872Z` | 10.84m | 324.44s |
| 9 | `2026-08-27T14:25:13.788Z` | 21.56m | 642.92s |
| 10 | `2026-08-27T14:46:36.878Z` | 42.94m | 1283.09s |
| 11 | `2026-08-27T15:29:20.262Z` | 1.43h | 2563.38s |
| 12 | `2026-08-27T16:54:47.624Z` | 2.85h | 5127.36s |
| 13 | `2026-08-27T19:45:28.435Z` | 5.70h | 10240.81s |
| 14 | `2026-08-28T01:26:48.945Z` | 11.39h | 20480.51s |
| 15 | `2026-08-28T12:49:33.389Z` | **22.76h** | 40964.44s |
| — | *never arrived* | *45.5h* | **ladder ended** |

Sixteen deliveries. Fourteen doublings, ratio 2.00 from the fifth gap onward. The
predicted seventeenth attempt at +45.5h never came, and was 45 minutes overdue on a
schedule that had held to ±5 seconds across every prior step.

**The stopping rule is the window, not an attempt count.** Doubling continues until
the next step would fall outside 24 hours, then stops. 22.76h is simply where the
fourteenth doubling lands before that cap.

Two runs a day apart agreed on the 11.4-hour step to within **five seconds** — a
0.01% divergence. This schedule is not merely unjittered; it is clocked.

### What each finding forces in the code

| Finding | Consequence in Raze |
|---|---|
| First retry at **0.23s** for payment events | The runtime answers 200 *before* processing. A synchronous handler is guaranteed a duplicate. |
| **16 deliveries** over **22.76h**, 14 doublings | The retry-storm case is real, not hypothetical. |
| Undelivered after 22.8h is **never delivered** | Waiting is not a recovery strategy. Reconciliation is mandatory. |
| Sustained failure **disables the endpoint entirely** | Delivery never resumes without human action, so a deadline is the only remaining signal. |
| Refunds and failures skip the instant retry, **~6–9s** | Refund handling cannot be tuned to payment timing. |

The endpoint deactivation was observed directly: at `2026-08-29T12:08Z` Razorpay
disabled all four failing probe endpoints within 40 seconds of each other and
emailed a notice for each. Two of them still received a delivery ~14 minutes after
their stated "final attempt".

Full write-up, including three claims that were published and later overturned by
more data: `measurement/RESULTS.md`.

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

## The repair agent

`raze fix` reads a merchant's real source, gets real findings from the probes,
generates a patch, applies it, restarts the service, and re-runs the probes to
prove the patch worked.

```
raze fix                     repair examples/merchant-legacy in place
raze fix --file path/to.js   repair your own handler
raze fix --restore           put the original back
```

### The division of labour is the whole design

| | Who decides | How |
|---|---|---|
| What is broken | **the probes** | deterministic, reading business state from Postgres |
| The patch | the model | written at run time from the real source and the observed failures |
| Whether it is fixed | **the probes** | the same probes, re-run against the restarted service |

The model never discovers a problem, never decides whether something counts as a
finding, and never declares success. **A patch that does not make the probes pass
is a failed patch** — the agent restores the original file and reports failure.
There is no fix database, no template, and no canned diff.

Two guards sit between the model and your code: the reply is only accepted if it
parses under `node --check`, and only if it keeps the file's exports and shape.

### A real run

`examples/merchant-legacy/server.js` is an ordinary handler — it parses correctly,
uses transactions, returns sensible status codes. It is not a strawman. Against
real replayed Razorpay traffic it fails every probe:

```
BEFORE
  FIND  Duplicate delivery       credit_count=2, credited=200 paise
  FIND  Refund event             status=paid, credited=100 paise (was 100)
  FIND  Tampered signature       ACCEPTED — credited 100 paise on a forged signature
  FIND  Out-of-order delivery    final status=authorized
  FIND  Timeout-induced retry    single delivery credited 100, with retries credited 300
  0/5 pass, 5 finding(s) — UNSAFE TO SHIP

  round 1: generating a patch from the real source and the real findings...
  round 1: patch applied (5946 bytes). Re-running the probes.
  round 1: 5 finding(s) -> 0

AFTER
  ok  Duplicate delivery       credit_count=1, credited=100 paise
  ok  Refund event             status=refunded, credited=0 paise (was 100)
  ok  Tampered signature       rejected with HTTP 400
  ok  Out-of-order delivery    final status=paid
  ok  Timeout-induced retry    single delivery credited 100, with retries credited 100
  5/5 PASS
```

The patch was not a template. Told it could only use tables the file already
touches, it could not add a dedupe table — so it made the writes idempotent in
SQL instead:

```sql
credited_paise = shop_orders.credited_paise + EXCLUDED.credited_paise,
credit_count   = shop_orders.credit_count + 1
WHERE shop_orders.credit_count = 0      -- a second delivery matches nothing
```

and added HMAC verification with `timingSafeEqual`, plus an ordering guard
(`WHERE status NOT IN ('paid','refunded')`).

### Where the patch comes from

Three interchangeable providers, since the probes — not the model — decide
whether a patch worked:

| Provider | Needs | Notes |
|---|---|---|
| `claude` | the Claude Code CLI on PATH | **default.** Runs on an existing subscription, no API credits |
| `api` | `ANTHROPIC_API_KEY` with credit | direct Anthropic API |
| `ollama` | ollama installed | fully local and offline |

Pin one with `RAZE_PROVIDER`. If `ANTHROPIC_API_KEY` is set but empty of credit
the CLI will prefer it and fail, so the agent strips that variable when invoking
the CLI.

Every other raze command is deterministic and needs none of this.

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
