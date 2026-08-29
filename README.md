# Raze

Raze keeps merchant business state correct when Razorpay webhook delivery is
duplicated, delayed, rejected, or absent.

It is not a testing tool. It is a correctness layer that sits between Razorpay's
event delivery and the merchant's business state.

```
npm install
npx raze demo --sever-delivery
```

If you have a database and nothing else — no webhook, no handler, no secret:

```
npx raze setup --url https://your-host/webhook   # reads your schema, proposes the
                                                 # mapping, registers the webhook
npx raze watch --table orders --key order_id     # notice payments that never arrive
npx raze protect                                 # run it
```

You write no webhook code. `--dry-run` shows every action first and changes
nothing.

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

### Where the patch comes from, and how well each does

Three interchangeable providers, because the probes — not the model — decide
whether a patch worked.

| Provider | Needs | Measured on the same 5-finding repair |
|---|---|---|
| `claude` | Claude Code CLI on PATH | **5 findings → 0**, one round. Runs on an existing subscription, no API credits. |
| `ollama` | ollama + a local model | `qwen2.5-coder:7b`: **5 → 3**, then plateaued. Fully offline. |
| `api` | `ANTHROPIC_API_KEY` with credit | direct Anthropic API |

A local 7B does real work here and does not finish the job. Both failing runs
restored the original file and exited non-zero — no false success.

Local models are asked for **one edit at a time**, as a search/replace block
applied deterministically here, not a whole-file rewrite. Asking a 3B for the
complete file was measured failing three rounds running: it returned the source
almost unchanged, because reproducing 120 lines without drifting is a different
skill from seeing the bug.

Model choice counts free RAM **and** GPU VRAM, and prefers a model ollama already
holds resident. Pin one with `RAZE_PROVIDER`.

## Commands

### Getting started

```
raze setup --url URL        build the integration: read your schema, propose the
                            mapping, generate a secret, register the webhook with
                            Razorpay, read it back to confirm. --dry-run first.
raze infer [--out FILE]     read your schema and propose the mapping, nothing else
raze init                   run migrations, verify configuration
raze gate                   run the reconciliation gate and record the outcome
```

### Running

```
raze protect                runtime + ledger + reconciliation
raze watch --table T --key C
                            arm expectations from your orders table, so a payment
                            that never arrives is noticed without you writing code
raze reconcile              one reconciliation pass now
raze ledger [--sweep]       expectations; --sweep classifies the overdue ones
raze status                 protection state
```

### Looking at it

```
raze audit [--target ...]   the five probes against real captured deliveries
raze insights               what Raze has learned from your own traffic
raze demo [--sever-delivery]
raze fix [--file PATH]      repair a handler in place (the only command that
                            generates code; --restore undoes it)
raze explain <finding>      explanation of a confirmed finding
```

**Everything except `fix` and `explain` is deterministic and needs no model.**

## Two ways to write the merchant side

### Declare it — no handler at all

The merchant says what an event means for their data. Raze compiles it to
parameterised SQL and runs it inside the same transaction as the dedupe write.

```js
rz.map('payment.captured', {
  table: 'orders',
  key:   { column: 'order_id', from: 'payload.payment.entity.order_id' },
  set:   { status: { literal: 'paid' } },
  add:   { credited_paise: 'payload.payment.entity.amount' },
  guard: { column: 'status', notIn: ['refunded'] },
});
```

No route, no signature check, no dedupe, no ordering logic, no transaction
handling, no error path. There is no merchant function in the request path, so
there is nothing to throw, hang, forget to respond, or half-apply.

Every identifier is validated against the database catalogue at registration, not
at delivery time — a webhook arriving at 3am is the wrong moment to discover a
typo. Values are always bound parameters.

`raze infer` writes this file for you by reading your schema. It proposes and
never applies: it can see that a column named `order_id` holds a Razorpay order
id, but not whether a refund should reverse a balance. Anything requiring that
judgement is emitted as a QUESTION.

### MongoDB

Same idea, different store:

```js
rz.map('payment.captured', {
  collection: 'orders',
  key:   { field: 'razorpay_order_id', from: 'payload.payment.entity.order_id' },
  set:   { payment_status: { literal: 'paid' } },
  inc:   { amount_paise: 'payload.payment.entity.amount' },
  guard: { field: 'payment_status', notIn: ['refunded'] },
});
```

**The guarantee here is different and the difference is not hidden.** With
Postgres, Raze's dedupe write and the business write commit in one transaction.
That is impossible across two stores, so the idempotency guard travels inside the
update instead: each document records the event ids applied to it, and the filter
requires the incoming one to be absent. MongoDB applies a single-document update
atomically, so a retry matches nothing and does nothing — including after a crash
between the Mongo write and the inbox update.

What is genuinely lost: your own additional writes cannot join Raze's
transaction, so you must make those idempotent yourself.

Inference is also weaker here and says so. Postgres declares every column; Mongo
declares nothing, so the shape is sampled from documents that exist and a field
seen in 3 of 200 is reported with that ratio attached.

### Or keep your handler

```js
rz.on('payment.captured', async (event, tx, meta) => {
  // Business logic only. Dedupe, signature and ordering already handled.
  // meta carries the delivery as it arrived: event id, headers, raw body.
  await tx.query('UPDATE orders SET status = $1 WHERE id = $2',
    ['paid', event.payload.payment.entity.order_id]);
});
```

## What Raze learns while it runs

The retry ladder was not read from documentation, it was measured. `raze insights`
applies the same method continuously to your own traffic.

| Learned from | Used for |
|---|---|
| Every delivery's arrival, per event type | your account's real first-retry delay, flagged when it diverges from the measured baseline |
| Every handler run | p50/p95/p99 latency and failure rate, with the most common error named |
| Resolved expectations | the p99 of real fulfilments — which is what a deadline should be. Fifteen minutes is a guess. |
| Reconciliation runs | how often delivery misses something |

Statistics, not a model. Every question here has an exact answer available from
the record, and a recommendation you can act on ("p99 of 4,312 observations")
beats an inference you cannot inspect.

Two rules the tests enforce: **every figure carries its sample count**, and below
twenty observations it reports insufficient data instead of a finding. And an
observation that cannot be written is swallowed — diagnostics must never break a
payment.

It does not promise there will be no failures. Nothing can. It notices a handler
drifting toward the latency that earns duplicate deliveries, an account whose
retry timing has changed, or reconciliation that keeps finding drift, before
those become incidents.

## Proof against code we did not write

```
npm run demo:public
```

Clones a real published Razorpay integration at run time, replays the genuine
16-attempt ladder at it, and reads the result out of that project's own MongoDB.
Their code is never vendored — those repositories carry no licence, so they are
fetched like a fixture and nothing from them is committed here.

```
as published   16 deliveries, all answered 200, nothing written.
               Model.update() was removed in modern mongoose, so their handler
               throws, catches its own exception and answers res.send(err) —
               which Express sends as 200. Razorpay reads that as delivered and
               stops retrying. The payment is gone and their logs show no failure.

behind Raze    the same 16 deliveries deduplicated to one event, the raw bytes
               stored, the real error surfaced, the event still held and retried.
               Their handler is just as broken; the payment is recoverable
               instead of lost.
```

Four public integrations were audited this way. Every one has a real defect: one
has no webhook handler at all and relies entirely on the browser callback; one
depends on a module-level variable that its own code nulls before the webhook can
use it; one verifies signatures over re-serialised JSON rather than the raw
bytes; one extends a subscription by 30 days per delivery with no idempotency —
480 days for a single payment on the measured ladder.

None of them was written carelessly. That is the argument for this project.

## Tests

```
npm test              59 assertions across seven layers
npm run test:offline  the layers that need no network
```

| Layer | Covers |
|---|---|
| 1 | runtime: dedupe, signature, ordering, rollback, backoff, raw-body fidelity |
| 2 | ledger: recovered / failed / abandoned, on three real Razorpay subjects |
| 3 | reconciliation: live API, drift detection, idempotent repair |
| 4 | audit: broken caught, control clean and stable, protected passes |
| 5 | declarative mappings with no merchant handler |
| 6 | learning, sample-count discipline, and never breaking a payment |
| 7 | MongoDB mappings and inference |

Layers 2 and 3 call the live Razorpay API. Layer 2 creates a real order and
deliberately never pays it — the abandonment case cannot be faked without losing
the point.

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
├── bin/raze                    CLI
├── src/
│   ├── runtime/                Layer 1 — protected runtime
│   ├── reconcile/              Layer 3 — reconciliation daemon
│   ├── ledger/                 Layer 2 — expectation ledger
│   ├── audit/                  Layer 4 — the five probes
│   ├── mapping/                declarative mappings, Postgres
│   ├── mongo/                  declarative mappings and inference, MongoDB
│   ├── infer/                  read a schema, propose a mapping
│   ├── learn/                  observe, then compute over what was observed
│   ├── agent/                  repair agent: providers, extraction, local models
│   ├── db.js                   Postgres, embedded or DATABASE_URL
│   └── demo.js                 scripted demonstration
├── migrations/
├── examples/
│   ├── demo-merchant/          one codebase, three integrations
│   ├── merchant-legacy/        an ordinary handler, the repair agent's target
│   └── public-merchant/        real published integrations, cloned at run time
├── gate/                       the §1 gate and its recorded results
├── test/                       layer1..layer7, real API and real Postgres
└── measurement/                the 796-delivery study this is built on
```

## Honest limitations

- **`raze fix` is not reliable.** Three runs against the same file: two full
  repairs, one patch that broke the merchant outright. It is a demonstration, not
  a guarantee, and the verifier is what makes it safe to run at all.
- **A local model does not finish the job.** A 7B fixed two of five defects and
  stopped. Use the Claude Code CLI provider if you want it completed.
- **MongoDB has no shared transaction with the inbox.** The idempotency guard is
  inside the update instead, which is sound for Raze's own writes but does not
  extend to yours.
- **Inference proposes, never applies.** On an unfamiliar schema it proposes
  nothing rather than guessing — a wrong guess about which row gets marked paid
  moves real money.
- **`raze watch` polls.** An order created and paid inside one interval is armed
  late. Calling `rz.expect()` in your own transaction is stronger.
- **Reconciliation cannot outrun an unavailable API.** A run that could not
  complete is recorded as failed, never as clean.
- **`raze audit` measures the integration in front of it.** It says nothing about
  code paths no probe exercises.
- **`raze setup` has been exercised in `--dry-run` only.** The webhook
  registration path is written and unverified against a live account.
