# Raze

**A merchant's order says pending. Razorpay has the money. Nothing in either
system will ever notice.**

Raze is the layer that notices. It reads a merchant's database, works out how
their orders relate to Razorpay payments, builds the Razorpay-side integration
for them, and from then on keeps the two in agreement — repairing what it can
prove and refusing everything else by name.

The merchant connects a database and supplies keys. They are asked nothing else,
and their own code does not change by one character.

---

## Contents

1. [The problem, as it actually happens](#1-the-problem-as-it-actually-happens)
2. [What Raze does](#2-what-raze-does)
3. [What it refuses to do](#3-what-it-refuses-to-do)
4. [The research this is built on](#4-the-research-this-is-built-on)
5. [What we got wrong, and how we found out](#5-what-we-got-wrong-and-how-we-found-out)
6. [How it works](#6-how-it-works)
7. [Run it](#7-run-it)
8. [The demo: lose a payment, watch it come back](#8-the-demo-lose-a-payment-watch-it-come-back)
9. [Evidence you can re-run](#9-evidence-you-can-re-run)
10. [Why this is not "ask an AI to fix the handler"](#10-why-this-is-not-ask-an-ai-to-fix-the-handler)
11. [Honest limitations](#11-honest-limitations)
12. [Commands and layout](#12-commands-and-layout)

---

## 1. The problem, as it actually happens

A shop creates a Razorpay order, opens Checkout, and marks the order paid when
the customer's browser comes back and says the payment succeeded.

That is what a first integration looks like. It is the path the quickstart shows,
and it works every single time you test it — because you never close the tab.

A customer on a train does. Their card is charged. Razorpay has the money. The
shop's database still says `pending`, and it will say `pending` forever, because
nothing in that program will ever ask again. The order is not shipped and the
customer's money is gone.

Razorpay's answer is webhooks, and their documentation then hands the merchant a
second job:

| What Razorpay requires of the merchant | What happens if they get it wrong |
|---|---|
| Verify HMAC-SHA256 over the **raw** body — "do not parse or cast" | Forged deliveries are accepted, or genuine ones rejected |
| Deduplicate on `x-razorpay-event-id` | The same payment is credited twice |
| Tolerate events arriving out of order — "the above order may not be followed at all times" | A refunded order flips back to paid |
| Answer 2xx within five seconds | A timeout produces a retry, which produces a duplicate |
| *(not on their list)* Survive a delivery that never arrives | The money is simply lost |

Most shops do not do all five. Some do none.

This repository contains a shop with exactly this bug — `storefront/`. Nothing in
it is sabotaged. There is no flag that breaks it, no injected failure, and
nothing about Razorpay is simulated: it creates real Test Mode orders against the
real API. It is written the ordinary way, and the ordinary way loses money.

---

## 2. What Raze does

Given a database URL and a Razorpay key pair, and nothing else:

**1 — Reads the schema.** Decides which table holds orders, which column carries
the Razorpay order id, which says whether an order is paid, which money column
records what is *owed*, and which records what was *received*.

**2 — Verifies every one of those claims against the live database** before
believing any of it. The columns must exist. The money columns must be numeric.
The key column's values must actually look like Razorpay order ids. The
expected-amount column must not be the same one money is credited to. Anything
that fails a check is dropped.

**3 — Builds the Razorpay side.** Generates a signing secret, registers the
webhook, subscribes to only the events this merchant's schema can actually
record, then reads the registration back from Razorpay to confirm it. A
registration the provider has not confirmed is not a registration.

**4 — Backfills.** Asks Razorpay what it already recorded and reports what the
merchant's database never applied — a real number, before anything is repaired.

**5 — Watches**, on three independent timers:

```
reconcile   every 60s   ask Razorpay what it recorded, compare, act
poll        every 20s   ask about each open order by name
sweep       every 30s   resolve deadlines that have passed
```

Meanwhile the five merchant obligations are met **outside the merchant's
codebase**: the signature is checked over raw bytes before anything parses them;
the event id is stored under a uniqueness constraint, so a duplicate is rejected
by the database rather than by a check that can race; event types are ranked so a
transition cannot move an order backwards; the delivery is acknowledged as soon
as it is durably stored, before any business logic runs; and reconciliation asks
Razorpay what it recorded rather than waiting to be told.

### The one judgement it will not guess

One money column records **what was owed**. Another records **what arrived**. A
payment is applied only after it agrees with the first.

Get those two backwards and every payment verifies against a figure it wrote
itself — which is worse than no checking at all, because it produces a system
that is confidently wrong. When a schema does not clearly distinguish them, Raze
reports divergence and never repairs unattended.

---

## 3. What it refuses to do

Anyone can write something that marks orders paid. The question is what it does
when it should **not** write.

| Situation | Rule | What happens |
|---|---|---|
| Razorpay has a payment, no matching order exists | `no-matching-order` | Refused. Creating the row would invent a customer. |
| Payment is refunded, not captured | `payment-not-captured` | Refused. |
| Amount disagrees with what the order was owed | `amount-mismatch` | Refused, both figures quoted in rupees. |
| Order is already settled | `order-already-paid` | Refused. Applying again would credit twice. |
| The key would touch more than one row | `would-touch-multiple-rows` | Refused. A repair that touches several rows is not a repair. |
| No column records what was owed | `amount-not-verifiable` | Reported, never repaired unattended. |
| The merchant's writes trigger shipping | `merchant-has-side-effects` | Never auto-repaired. |
| Mapping not confirmed | `mapping-not-confirmed` | Refused. |

Every rule fails toward escalation. And a repair is not reported as done until
Raze has **read the row back out of the merchant's own table** — an exception not
being thrown proves nothing, and a queue accepting a row proves a row exists, not
that money landed where the merchant can see it.

---

## 4. The research this is built on

Everything above is a consequence of something we measured against live Razorpay
infrastructure. None of it is assumed.

Razorpay's documentation says retries happen "on an exponential backoff schedule
over 24 hours" and never publishes the schedule. We recorded it.

**796 real deliveries. Four runs. One continuous server process, zero restarts.
Signatures verified on every single one.** The corpus ships in `measurement/` and
every test in this repository replays it.

### Method

Five endpoints were deployed behind one public host, each replying differently:

```
mode-200    replies 200          the control
mode-400    replies 400          "malformed request"
mode-500    replies 500          server error
mode-slow   sleeps 8s, then 200  slower than the 5s limit
mode-drop   destroys the socket  no reply at all
```

Real Razorpay Test Mode payments were then driven through Checkout, so every
delivery below is a genuine HTTP request that arrived from Razorpay's
infrastructure carrying a valid signature.

| Run | First delivery (UTC) | Last delivery (UTC) | Deliveries | Events | Purpose |
|---|---|---|---|---|---|
| 1 | `2026-08-27T14:03:39Z` | `2026-08-28T12:50:45Z` | 189 | 3 | Baseline, payment lifecycle only |
| 2 | `2026-08-28T13:30:03Z` | `2026-08-29T12:24:08Z` | 311 | 5 | Reproduction, plus refunds and failures |
| 3 | `2026-08-29T04:00:07Z` | `2026-08-29T09:45:09Z` | 271 | 5 | Morning slot — tests time-of-day dependence |
| 4 | `2026-08-29T12:35:08Z` | `2026-08-29T12:38:19Z` | 25 | 1 | Fourth `payment.failed` sample |

Run 3 closed on **exactly the same 231-delivery count** as Run 2, with a per-mode
table identical in every cell but one.

### One retry ladder, end to end

Run 1, `mode-500`, `payment.captured`, event `TUouniJth9WtQ2`:

| # | Since first delivery | Gap from previous |
|---:|---:|---:|
| 1 | **0.23s** | 0.23s |
| 2 | 6.08s | 5.84s |
| 3 | 19.13s | 13.05s |
| 4 | 39.55s | 20.42s |
| 5 | 1.37m | 42.75s |
| 6 | 2.74m | 82.22s |
| 7 | 5.43m | 161.54s |
| 8 | 10.84m | 324.44s |
| 9 | 21.56m | 642.92s |
| 10 | 42.94m | 1283.09s |
| 11 | 1.43h | 2563.38s |
| 12 | 2.85h | 5127.36s |
| 13 | 5.70h | 10240.81s |
| 14 | 11.39h | 20480.51s |
| 15 | **22.76h** | 40964.44s |
| — | *never arrived* | **ladder ended** |

Sixteen deliveries. Fourteen doublings, ratio 2.00 from the fifth gap onward. The
predicted seventeenth attempt at +45.5h never came, and was 45 minutes overdue on
a schedule that had held to ±5 seconds at every prior step.

**The stopping rule is the window, not an attempt count.** Doubling continues
until the next step would fall outside 24 hours, then stops. 22.76h is simply
where the fourteenth doubling lands before that cap.

Two runs a day apart agreed on the 11.4-hour step **to within five seconds** — a
0.01% divergence. This schedule is not merely unjittered; it is clocked.

### Six findings, and the line of code each one forces

| Finding | Consequence |
|---|---|
| **First retry at 0.23s** for payment-lifecycle events | The runtime answers 200 *before* processing. A synchronous handler is not likely to get a duplicate — it is guaranteed one. |
| **16 deliveries over 22.76h**, 14 doublings | The retry storm is real, not hypothetical. Deduplication must survive it. |
| **Nothing after 22.8h is ever delivered** | Waiting is not a recovery strategy. Reconciliation is mandatory, not a nicety. |
| **Sustained failure disables the endpoint entirely** — observed directly, reproduced twice | Delivery never resumes without human action, so a deadline is the only remaining signal. A merchant whose endpoint was switched off is not told by their own system. |
| **HTTP 400 is retried** on the same curve as 500 | Rejecting malformed webhooks with a 400 earns another ten copies. 4xx is not a "stop" signal. |
| **There is no retry counter in the request** — only `event_id`, signature, and `user-agent: Razorpay-Webhook/v1` | A receiver cannot tell attempt 1 from attempt 11 by looking at it. Deduplication **must** be stateful on the receiver's side. This is a negative result and the most product-relevant thing we found. |

The endpoint deactivation was observed directly: at `2026-08-29T12:08Z` Razorpay
disabled all four failing probe endpoints within 40 seconds of each other and
emailed a notice for each. Two of them still received a delivery ~14 minutes
after their stated "final attempt". It reproduced the following day, with
`mode-200` surviving as the control both times.

### A seventh finding, from building this

**Razorpay's list endpoints lag by minutes.** A payment captured seconds ago can
be absent from `GET /v1/payments` and from the dashboard, while
`GET /v1/orders/{id}` reports that order paid immediately.

We hit this live. Reconciliation that only enumerates has a blind window exactly
where a fresh payment lives — and worse, a console built on that list will tell a
merchant "everything is accounted for, 0 captured payments" while their money
sits at Razorpay. True of the list; false about the money.

Raze therefore asks about each open order **by name**, on its own timer,
independent of the enumeration. The list is still consulted and still shown — and
labelled as the weakest evidence on the page.

---

## 5. What we got wrong, and how we found out

Three claims were written down and later overturned by more data. They are kept
here because a research process that only reports its wins is not a research
process.

**Claim: the second retry tier depends on time of day.** Runs 2 and 3 differed —
8.6s versus 5.9s for the non-instant tier — and each run's three modes clustered
tightly (spread 0.24s and 0.13s). That tightness seemed to rule out noise, so we
argued for a real per-run difference with time of day the leading candidate.

**Run 4 refuted it.** Its within-run spread was 1.63s — wider than the
between-run gap that had made the two-regime story convincing. The tight
clustering in the first two runs was itself coincidence. Three samples spanning
04:02Z, 12:35Z and 13:37Z show no monotonic pattern.

The honest number is **~6–9s** for the non-instant tier. Not 8.6s, not 5.9s, and
not a function of time of day. `mode-slow` is the control that proves the
variance is real rather than a measurement artifact: 12.65 / 13.09 / 12.32s
across all three samples, because its 8-second handler delay dominates whatever
jitter sits underneath.

The two-tier structure itself — payment-lifecycle events retry instantly at
~0.23s, `refund.created` and `payment.failed` do not — reproduced in every sample
and is not in doubt. Only the magnitude of the second tier was mis-stated.

**Claim: one `event_id` identifies one delivery stream.** It does not. Razorpay
assigns one id per event and delivers it to every subscribed endpoint. The first
version of the analyser grouped by `event_id` alone and merged five independent
endpoint streams into one bogus delta sequence. Grouping is now by
`(mode, event_id)`. Worth knowing for any merchant running more than one webhook
config.

**Claim: `mode-drop` measures a connection reset.** It does not, on this host.
Railway's edge converts a destroyed origin socket into a 502 before Razorpay sees
it, which is why its timing matches `mode-500` to within 0.2s. Measuring a true
reset needs a host that does not terminate TLS at an edge proxy. The limitation
is the instrument, not the finding.

Had we written the demo around "Razorpay retries in 200ms" as a universal claim,
a refund-based demo would have sat there looking broken for six seconds. That is
the clearest argument in the whole exercise for insisting on more than one run:
**the sample, not the instrument, was the limitation.**

---

## 6. How it works

### The path a delivery takes

```
Razorpay
   │
   ▼
signature checked over raw bytes ──────► rejected if it fails
   │
   ▼
stored in the inbox, event_id unique ───► duplicate rejected by the database
   │
   ▼
200 returned  (before any business logic — this is why 0.23s cannot hurt)
   │
   ▼
drained: event type ranked, guards applied, mapping applied
   │
   ▼
row read back out of the merchant's table ──► only now is it "done"
```

### The three things running underneath

**Reconciliation** asks Razorpay what it recorded and compares against the
merchant's rows. This is the mechanism that does not depend on delivery at all —
which is why the demo below works with no webhook registered anywhere.

**The targeted poll** starts from the merchant's unpaid orders and asks Razorpay
about each one by name. Bounded: only orders carrying a gateway id, only the most
recent, one request each. This is what catches a payment the list has not caught
up with.

**The expectation ledger** detects *absence*. An order created and then silent
past a deadline is a different problem from an order that failed, and it is the
only signal left when an endpoint has been deactivated.

### The split that makes a model safe to involve

A model reads the schema and proposes which column is which. **Deterministic code
then checks every claim against the live database**, and anything that fails a
check is dropped. A wrong answer from the model cannot arm a wrong mapping; the
worst it can do is fail a check and cost the merchant a question.

There is also a model-free reader that produces the same claim from the schema
alone and goes through the identical verification, so a server with no model
available is not stuck. The model is how Raze reads an unfamiliar schema quickly.
It is not how Raze is allowed to be correct.

**Nothing in the decision path involves a model.** The policy engine is a pure
function. One test empties `PATH` so `claude` is unreachable and runs every tool
anyway.

### Proving it was running

Every loop pass writes a row to `raze_heartbeat` with a timestamp, whether or not
it found anything. Three bugs during this build were diagnosed from reading logs
and all three diagnoses were wrong, because an absent log line is not evidence: an
interval that never fires produces exactly the same silence as an interval whose
work found nothing. The heartbeat is the difference, and it survives the process
that wrote it.

---

## 7. Run it

**Node 20.19 or newer.** Check first — the suite says so and stops, rather than
failing six layers in.

```bash
node --version

git clone https://github.com/LokarajR/Raze.git
cd Raze
npm install
npm run test:offline
```

`npm install` pulls a real PostgreSQL as an npm package (~108 MB), so there is no
database to install. MongoDB is different: `mongodb-memory-server` fetches a
binary from a Mongo CDN on first run, and if that is blocked the MongoDB layer
prints `SKIP` and says why. Every other layer runs with no network at all.

Allow about 400 MB of disk and a little longer than two minutes on the first run.

Expect **twelve layers, all passing**, on a machine that has never seen a
credential. Groups that need a Razorpay account report `SKIP` rather than passing
quietly — a test that cannot run says so instead of counting itself green.

Two layers are worth looking at first:

```
control        the full probe set against a CORRECT integration → zero findings,
               and the same probes DO fire on a defective one
deterministic  every tool run with `claude` unreachable on PATH
```

No Claude subscription is needed for any of this.

---

## 8. The demo: lose a payment, watch it come back

**This runs entirely on your own machine.** Reconciliation asks Razorpay what it
recorded rather than waiting to be told, so no webhook, no public address and no
deployment is needed. The webhook path is the optimisation; reconciliation is the
guarantee.

You need a Razorpay **Test Mode** key pair (`rzp_test_…`). Raze refuses live keys.

### 1. Start the shop

```bash
cd storefront
npm install
DATABASE_URL=postgres://user:pass@host:5432/postgres \
RAZORPAY_KEY_ID=rzp_test_xxx \
RAZORPAY_KEY_SECRET=xxx \
PORT=4100 node server.js
```

It creates its own database (`kettle`) on whatever Postgres you point it at, so a
name as ordinary as `shop_orders` cannot collide with an existing table. It seeds
140 prior counter sales so the table has a shape; those carry **no gateway id**.
Every row that has one is a real Razorpay order created against the real API.

Open <http://localhost:4100>.

### 2. Watch it lose a payment

Tick **"customer closes the tab after paying"**, place an order, and complete the
payment.

The tick does not skip payment. It skips the browser telling the shop afterwards
— exactly what a closed tab changes and nothing else.

Result: the shop shows `pending`, ₹0.00 received. Razorpay has the money.
**Nothing will ever fix this.** Wait as long as you like. Leave the order there.

### 3. Connect Raze

```bash
npm run web
```

Open <http://localhost:7000> and give it three things: key id, key secret, and the
shop's database URL. Nothing else is asked.

| Step | What to look at |
|---|---|
| `schema` | It has never seen this database. It names the orders table, the Razorpay id column, and which money column is **owed** versus **received**. |
| `webhook` | Generates the secret, registers the endpoint, subscribes only to events this schema can record, reads it back from Razorpay to confirm. You never open the dashboard. |
| `backfill` | Asks Razorpay what it recorded and reports what your database never applied. |
| `watch` | Reports the timestamp of a pass that **finished**, not that a timer was created. |

Running locally there is no public address, so the webhook step says so plainly
and reconciliation carries the work. That is the intended path here.

### 4. Watch the repair

Within about twenty seconds, refresh the shop. The order is `paid`, received
equals billed.

Raze asked Razorpay about that order by name, found a captured payment, checked
the amount against what was owed, wrote the row through the same mapping and
guards a live delivery would use, then read the row back out of the shop's own
table before reporting it.

### 5. Watch what it refuses — the half that matters

- **An order nobody paid for.** Place one and dismiss the payment window. It
  stays `pending` forever. Raze does not invent a payment.
- **A payment with no order.** Refused with `no-matching-order`.
- **An amount that disagrees.** Change an order's owed amount before paying it.
  Refused with `amount-mismatch`, both figures quoted.

### If something misbehaves

- **The dashboard shows no payment but you paid.** That is the list lag from
  §4. Do not pay twice — Raze asks per order and sees it immediately.
- **Postgres will not start.** Run it again; Raze clears its own orphaned
  Postgres on the next start. If it persists: `RAZE_PG_PORT=55500 npm run
  test:offline`.
- **The chat surface will not answer.** It needs Claude Code installed; the
  engine does not need a model at all. `node bin/raze status` prints the same
  facts from the command line.

---

## 9. Evidence you can re-run

```bash
npm test              # twelve layers, replaying real captured deliveries
npm run chaos         # a worker SIGKILLed mid-transaction, a handler failing its
                      # first two attempts at every event, forged deliveries in
                      # the stream, every delivery dropped, the database
                      # terminated underneath — each payment still lands once
npm run demo          # unprotected 1/5, protected 5/5, control 5/5 with 0 findings
```

Three properties of the suite worth naming:

**It replays reality.** The probes replay deliveries Razorpay really sent, and
read business state **directly from Postgres**. There is no `/test-state`
endpoint — instrumentation added for a test would be a form of simulation.

**Zero findings on a correct integration is a build-failing test.** The control
asserts that the probe set reports nothing against a correct implementation *and*
that the same probes do fire on a defective one. Tooling that cannot stay quiet
when nothing is wrong is not a measuring instrument.

**No model is reachable.** `test/deterministic.test.js` spawns the MCP server with
`PATH` emptied.

---

## 10. Why this is not "ask an AI to fix the handler"

|  | A model rewrites your handler | Raze |
|---|---|---|
| How it knows what is broken | reads the code and infers | replays real captured deliveries, reads real database state |
| How you know the fix worked | you trust it | the same probes re-run and have to pass |
| What happens to a delivery that never arrives | nothing | reconciliation finds it |
| What it does when unsure | writes something plausible | refuses, names the rule |
| Whose code changes | yours | none |

And against Razorpay's own agentic integration, which makes integration **fast**:

> Fast integration is not enough. The integration should be hardened against the
> failure patterns we have actually measured — and the merchant's code should not
> have to change to get them.

Every protection in §2 exists because of a specific number in §4.

---

## 11. Honest limitations

- **Test Mode only.** Raze fires real deliveries when it checks an integration
  and refuses to touch a live account.
- **Razorpay's account-level webhook API is create-and-list only.** `DELETE` and
  `PATCH` both answer `404 no Route matched` — those verbs exist only on the
  partner route, under an account id a merchant using their own keys does not
  have. Raze can register a webhook but cannot retire a stale one; it reports
  them rather than pretending.
- **Postgres and MongoDB.** No other stores.
- **The fast path needs a public address.** Razorpay refuses `localhost` at save
  time. Reconciliation needs nothing, which is why §8 works on a laptop.
- **The model-free schema reader** handles ordinary schemas and declines on odd
  ones rather than guessing.
- **`mode-drop` did not measure what it was meant to** — see §5.

---

## 12. Commands and layout

```bash
node bin/raze status      # reconciliation state, ledger, inbox, outbox — no model
node bin/raze up          # migrate, map, register, backfill, start watching
node bin/raze web         # the console
node bin/raze audit       # replay the probe set against an integration
node bin/raze agent       # write .mcp.json so an MCP client can drive it
```

```
src/runtime/     inbox, dedupe, ordering, acknowledgement
src/policy/      the pure decision function — every rule fails toward escalation
src/loops/       reconcile, targeted poll, sweep
src/mapping/     event → merchant state, validated against the live schema
src/reconcile/   ask Razorpay what it recorded
src/ledger/      expectations and deadlines — detecting absence
src/outbox/      effects, delivered once
src/agent/       schema reading (model and model-free), integration building
src/mcp/         the MCP server
src/web/         the console
storefront/      the shop that loses the payment
measurement/     796 real deliveries, and the analysis
test/            twelve layers
```

`.claude/agents/raze.md` is an agent definition consumed by Claude Code, not
documentation — it is the file that makes `raze` available as an agent.
