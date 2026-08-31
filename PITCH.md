# Raze

**A merchant's order says pending. Razorpay has the money. Nothing in either
system will ever notice.**

Raze is the layer that notices. It reads a merchant's database, works out how
their orders relate to Razorpay payments, builds the Razorpay-side integration
for them, and from then on keeps the two in agreement — repairing what it can
prove and refusing everything else by name.

The merchant connects a database and supplies keys. They are asked nothing else,
and their code does not change by one character.

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
second job: verify an HMAC-SHA256 signature over the **raw** bytes, deduplicate
on `x-razorpay-event-id`, tolerate events arriving out of order, and answer 2xx
within five seconds. Most shops do not do all four. Some do none.

This repository contains a shop that has this bug — `storefront/`. Nothing in it
is sabotaged. There is no flag that breaks it and no injected failure. It is
simply written the ordinary way, and the ordinary way loses money.

---

## 2. What we measured

Everything Raze does is a consequence of something we measured against live
Razorpay infrastructure, not something we assumed.

Razorpay's documentation says retries happen "on an exponential backoff schedule
over 24 hours" and never publishes the schedule. We recorded it: **796 real
deliveries, four runs, one continuous server process, zero restarts, signatures
verified on every one.** The corpus ships in `measurement/` and every test in
this repository replays it.

**The retry ladder — 16 deliveries across 22.76 hours**

| # | Since first delivery | Gap from previous |
|---:|---:|---:|
| 1 | **0.23s** | 0.23s |
| 5 | 1.37m | 42.75s |
| 10 | 42.94m | 1283.09s |
| 15 | **22.76h** | 40964.44s |
| — | *never arrived* | ladder ended |

Fourteen doublings, ratio 2.00 from the fifth gap onward. Two runs a day apart
agreed on the 11.4-hour step **to within five seconds** — a 0.01% divergence. The
schedule is not merely unjittered; it is clocked. The stopping rule is the
24-hour window, not an attempt count.

**Four findings, and what each one forces:**

| What we measured | What it means for a merchant |
|---|---|
| First retry at **0.23 seconds** | A handler that processes before replying is *guaranteed* a duplicate. Not likely — guaranteed. |
| **Nothing after 22.76 hours** | Waiting is not a recovery strategy. If it has not arrived, it never will. |
| Sustained failure **disables the endpoint** — observed directly, reproduced twice | Delivery never resumes without human action. A merchant whose endpoint was switched off is not told by their own system. |
| Refunds and failures skip the instant retry (~6–9s) | Refund handling cannot be tuned to payment timing. |

And one found during this build, on live infrastructure:

**Razorpay's list endpoints lag by minutes.** A payment captured seconds ago can
be absent from `GET /v1/payments` and from the dashboard while
`GET /v1/orders/{id}` reports the order as paid immediately. Any reconciliation
that only enumerates has a blind window exactly where a fresh payment lives.
Raze therefore asks about each open order **by name**, on its own timer,
independent of the list.

Full write-up, including three claims we published and later overturned with more
data: `measurement/RESULTS.md`.

---

## 3. What Raze does

Given a database URL and a Razorpay key pair, and nothing else:

1. **Reads the schema** and decides which table holds orders, which column carries
   the Razorpay order id, which says whether an order is paid, which money column
   is *owed*, and which is *received*.
2. **Verifies every one of those claims against the live database** before
   believing any of it — the columns must exist, the money columns must be
   numeric, the key column's values must actually look like Razorpay order ids,
   and the expected-amount column must not be the same one money is credited to.
3. **Builds the Razorpay side**: generates a signing secret, registers the
   webhook, subscribes to only the events the merchant's schema can actually
   record, then reads the registration back from Razorpay to confirm it.
4. **Backfills** — asks Razorpay what it already recorded and reports what the
   merchant's database never applied.
5. **Watches**, on three independent timers: reconcile every 60s, poll every open
   order by name every 20s, sweep deadlines every 30s.

The merchant's four handler obligations are met outside their codebase: the
signature is checked over raw bytes before anything parses them, the event id is
stored under a uniqueness constraint so a duplicate is rejected by the database
rather than by a check that can race, event types are ranked so a transition
cannot move an order backwards, and the delivery is acknowledged as soon as it is
durably stored — before any business logic runs.

### The distinction the whole thing rests on

One money column records **what was owed**. Another records **what arrived**. A
payment is only applied after it agrees with the first.

Get those backwards and every payment verifies against a figure it wrote itself,
which is worse than no checking at all — it produces a system that is confidently
wrong. This is the single judgement Raze refuses to guess at: when a schema does
not clearly distinguish the two, it reports divergence and never repairs
unattended.

---

## 4. What it refuses to do

Anyone can write something that marks orders paid. The question is what it does
when it should **not** write.

| Situation | What Raze does |
|---|---|
| Razorpay has a payment, no matching order exists | `no-matching-order` — refuses. Creating the order would invent a customer. |
| Payment is refunded, not captured | `payment-not-captured` — refuses. |
| Amount does not match what the order was owed | `amount-mismatch` — refuses. |
| Order is already settled | `order-already-paid` — refuses. Applying again would credit twice. |
| The key would touch more than one row | `would-touch-multiple-rows` — refuses. |
| No column records what was owed | Reports divergence, never repairs unattended. |

Every rule fails toward escalation. A repair is not reported as done until Raze
has **read the row back out of the merchant's own table**: an exception not being
thrown proves nothing, and a queue accepting a row proves a row exists, not that
money landed where the merchant can see it.

---

## 5. Why this is not Razorpay's agentic integration

Razorpay's agentic integration makes integration **fast**: understand the app,
generate the integration, get payments working.

Raze's claim is different:

> Fast integration is not enough. The integration should be hardened against the
> failure patterns we have actually measured — and the merchant's code should not
> have to change to get them.

Two differences follow. First, Raze generates no code into the merchant's
application; the shop in this repository has no webhook handler and has never
heard of Raze. Second, the protections are not chosen from a style guide — each
one exists because of a specific number in `measurement/`.

Reconciliation sits underneath all of it as the guarantee that does not depend on
delivery at all: it asks Razorpay what it recorded rather than waiting to be
told. That is why the demo works with no webhook registered anywhere.

---

## 6. Evidence you can re-run

```
npm test              # 12 layers. Every one replays real captured deliveries.
npm run chaos         # worker SIGKILLed mid-transaction, handler failing its
                      # first two attempts, forged deliveries, every delivery
                      # dropped, database killed underneath. Each payment still
                      # lands exactly once.
```

**No model is involved in any of it.** The suite passes with no API key and no
model reachable — one test empties `PATH` to prove it. The schema reading has a
model-free path that goes through exactly the same verification; the model is how
Raze reads an unfamiliar schema quickly, not how it is allowed to be correct.

A permanent build-failing control test asserts that a correctly built integration
produces **zero findings** — so the tooling cannot quietly start reporting
problems that are not there.

Every loop pass writes a heartbeat row with a timestamp, whether or not it found
anything, so "was it actually running" is answerable after the process dies
rather than inferred from logs.

---

## 7. Honest limitations

- **Test Mode only.** Raze fires real deliveries when it checks an integration
  and refuses to touch a live account.
- **Razorpay's account-level webhook API is create-and-list only.** `DELETE` and
  `PATCH` both answer `404 no Route matched`. Raze can register a webhook but
  cannot retire a stale one; it reports them instead of pretending.
- **Postgres and MongoDB.** No other stores.
- **The fast path needs a public address.** Reconciliation does not — which is
  why the demo below works entirely on a laptop with no webhook registered.
- The model-free schema reader handles ordinary schemas and declines on odd ones
  rather than guessing.

---

## 8. Run it

`QUICKSTART.md` — the shortest path from clone to a passing suite.
`DEMO.md` — the shop, the failure, and the repair, end to end.
`README.md` — how every part of it works.
`measurement/RESULTS.md` — the research in full, including what we got wrong.
