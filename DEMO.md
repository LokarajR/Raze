# Demo script

Three minutes. Every number below was produced by a real run and can be
reproduced on stage; nothing here is a mock-up.

Have ready, in this order:

- a terminal in the repo
- https://raze-console-production.up.railway.app open in a browser
- the Razorpay dashboard, Payments tab
- your editor with the MCP server configured

---

## 0:00 — The problem, in one sentence

> A Razorpay webhook returns HTTP 200 and the money still goes missing. The
> status code says the delivery succeeded. It says nothing about whether the
> merchant's database changed.

Do not explain further yet. Show it.

---

## 0:15 — Somebody else's code

Console, stage 1. Paste a real repository:

```
https://github.com/neharahman/razorpay-webhook
```

It clones, finds the handler, and shows the defect against their actual source:

```
Signature verified over re-serialised JSON · line 74
  const requestedBody = JSON.stringify(req.body)
  const expectedSignature = crypto.createHmac('sha256', ...).update(requestedBody)
```

> This is not a repository I wrote. Raze fetched it thirty seconds ago. Ten of
> these were scanned: six have a webhook handler, three match known defects.

---

## 0:45 — Run it and watch the money go wrong

Console, stage 2. **Start the merchant**, then **Run the probes**.

Five real captured Razorpay deliveries, fired at a running merchant with its own
database. The result is read out of the merchant's own table.

```
FIND  Duplicate delivery     credit_count=2, credited=200 paise
FIND  Refund event           status=refunded, credited=-1400 paise (was 100)
FIND  Tampered signature     ACCEPTED — credited 100 paise on a forged signature
  ok  Out-of-order delivery  final status=paid
FIND  Timeout-induced retry  single credited 100, with retries credited 300
```

> Every one of those deliveries returned HTTP 200. A negative balance, credit
> for a payment that never happened, and money credited twice — and the
> integration looks healthy from the outside.

---

## 1:15 — What it costs, without inventing anything

Console, stage 3. Enter volume, average order value, and delivery retry rate.

```
5000 txn/month x 2% retried x Rs 1200 credited twice = Rs 1,20,000/month
```

> The retry rate is asked for, never assumed. The 796-delivery measurement
> records what Razorpay does when a delivery fails — 16 attempts across 22.76
> hours, first retry 0.23 seconds — not how often failure happens on your
> endpoint. And orders nobody paid for are counted separately; abandonment is
> not revenue loss.

That last sentence is worth saying slowly. It is the sentence that makes the
other numbers credible.

---

## 1:45 — The same code, behind Raze

Console, stage 4. **Put Raze in front**, then **Run the same probes**.

```
5/5 pass
```

> The handler was not modified. Not one line. The defects are still in their
> code. Raze sits in front of it and the money is correct anyway.

---

## 2:00 — Live, on real money

This is the part that cannot be faked, so do it live.

Console, stage 5 → **Create payment link** → pay it in Test Mode on your phone.

Deliveries appear in the right-hand feed within seconds. Show the Razorpay
dashboard beside it: the same order id, the same amount.

Two payments were run this way while building it:

| | unprotected | behind Raze |
|---|---|---|
| order | `order_TVwSioXEUqiTSf` | `order_TVwZGIPFdIOvgf` |
| payment | `pay_TVwSspsKZ0s1WE` | `pay_TVwZNJzV4n0ye0` |
| merchant row | `paid ₹500 x1` | `paid ₹500 x1` |
| deliveries held | **none** | **3, byte-for-byte** |

> Both got the right answer. Only one of them can be investigated if it goes
> wrong. Unprotected, there is no record that anything ever arrived.

---

## 2:30 — Ask your editor what happened

Switch to the editor with the MCP server configured. Ask in plain language:

> what happened to order_TVwZGIPFdIOvgf?

```
razorpay        pay_TVwZNJzV4n0ye0  captured  ₹500  netbanking  10:11:56
deliveries      TVwZQn9YwbLUBB  payment.authorized   766B  sha256 ee235a25…
                TVwZRokQyK18bM  payment.captured     794B  sha256 43b1242b…
                TVwZSAcHUZ7iBc  order.paid          1039B  sha256 69c5039b…
dedupe          3 received, 3 distinct event ids, 3 applied
state_machine   rank 2, order.paid
merchant        paid, ₹500, applied once
verdict         provider record and merchant state agree
```

> Payment captured at 10:11:56. First byte arrives at Raze 3.7 seconds later.
> Raw bodies hashed and kept. Rank 2 recorded — so if Razorpay redelivers
> `payment.authorized` tomorrow, it is recognised as stale instead of moving
> this order backwards.

---

## 2:50 — Why this is not another payment MCP

> Razorpay ships an MCP. So do Stripe, Square, PayPal and Dwolla. Every one of
> them is provider access: create an order, fetch a payment, list webhook
> subscriptions. They answer what the provider says.
>
> None of them answer the question a merchant loses money on: this event was
> delivered twice after our process crashed — does exactly one entitlement, one
> invoice, one ledger posting exist in *our* database?
>
> That needs an engine, not an API wrapper. Eight of Raze's nine tools are
> read-only. The ninth changes merchant state and cannot be called without a
> plan a human approved — and the plan is refused if the state moved after it
> was approved.

---

## Close

> 796 real deliveries measured. Ten public integrations scanned. 77 assertions
> passing on a machine with no credentials. Two live payments through a deployed
> endpoint. Nothing in this demo is simulated.

---

## If the wifi dies

Everything except stage 5 runs offline:

```bash
npm run test:offline
npm run eval:public     # needs network once, then cached
npm run demo
```

`npm run demo` alone tells the whole story in 20 seconds, and needs nothing but
the repository.

## Numbers, and where each comes from

| Claim | Source |
|---|---|
| 16 deliveries, 22.76h, first retry 0.23s | `measurement/RESULTS.md`, 796 real deliveries |
| 10 repos, 6 handlers, 3 with defects | `npm run eval:public` |
| 4 findings unprotected, 5/5 protected | `npm run demo` |
| 77 assertions | `npm run test:offline` |
| Live payments | Razorpay dashboard, Test Mode |
