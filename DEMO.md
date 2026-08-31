# The demo

A shop loses a payment. Raze finds it. Both halves are real: real Razorpay Test
Mode orders, real captured payments, a real Postgres database, and a shop that
has never heard of Raze.

Nothing here is staged. The shop is not sabotaged, no failure is injected, and no
Razorpay response is faked. The bug is that the shop is written the ordinary way.

**This runs entirely on your own machine.** Reconciliation asks Razorpay what it
recorded rather than waiting to be told, so no webhook, no public address and no
deployment is needed for any of it. The webhook path is an optimisation, not the
guarantee.

---

## What you need

- Node 20.10 or newer
- A Razorpay **Test Mode** key pair (`rzp_test_…`) — Dashboard → Account &
  Settings → API Keys. Raze refuses live keys.
- Nothing else. Postgres is downloaded and run for you.

---

## 1. Start the shop

```bash
cd storefront
npm install
DATABASE_URL=postgres://raze:raze@127.0.0.1:55432/postgres \
RAZORPAY_KEY_ID=rzp_test_xxx \
RAZORPAY_KEY_SECRET=xxx \
PORT=4100 node server.js
```

If you do not already have a Postgres to hand, start Raze's first — `npm run web`
in the repository root prints the connection string it is using — or point
`DATABASE_URL` at any Postgres you like. The shop creates its own database
(`kettle`) on that server, so it never collides with anything already there.

Open <http://localhost:4100>. It seeds 140 prior counter sales so the table has a
shape, none of which carry a gateway id. **Every row with a
`gateway_order_id` is a real Razorpay order created against the real API.**

## 2. Watch it lose a payment

Tick **"customer closes the tab after paying"**, place an order, and complete the
payment with netbanking.

The tick does not skip payment. It skips the browser telling the shop afterwards
— exactly what happens when a customer's tab dies on a train.

Result:

- The shop shows the order `pending`, ₹0.00 received.
- Razorpay has the money.
- **Nothing will ever fix this.** The shop's only path to `paid` was the callback
  that did not run. Wait as long as you like.

That is the merchant's reality today. Leave the order sitting there.

## 3. Connect Raze

```bash
npm run web
```

Open <http://localhost:7000> and give it three things — your Razorpay key id, key
secret, and the shop's database URL (`…/kettle`). Nothing else is asked.

Watch the steps land:

| Step | What to look at |
|---|---|
| `schema` | It has never seen this database. It names the orders table, the column carrying the Razorpay id, and — the part that matters — which money column is **owed** and which is **received**. |
| `webhook` | It generates a signing secret, registers the endpoint, subscribes to only the events this schema can record, and reads the registration back from Razorpay to confirm it. You never open the dashboard. |
| `backfill` | It asks Razorpay what it already recorded and reports what your database never applied. |
| `watch` | It reports the timestamp of a pass that **finished**, not that a timer was created. |

If you are running locally with no public address, the webhook step says so
plainly and reconciliation carries the work. That is the intended path for this
demo.

## 4. Watch the repair

Within about twenty seconds, refresh the shop. The order from step 2 is `paid`,
received equals billed.

Raze asked Razorpay about that order **by name**, found a captured payment,
checked the amount against what the order was owed, wrote the row through the
same mapping and guards a live delivery would use, and then **read the row back
out of the shop's own table** before reporting it.

Ask the console *"is everything alright?"* — it answers with what it repaired and
what is still open, counted from your database and from Razorpay.

## 5. Watch what it refuses

This is the half that matters.

**An order nobody paid for.** Place an order and dismiss the payment window. It
stays `pending` forever. Raze does not invent a payment.

**A payment with no order.** Any captured payment whose order id is not in the
database is refused with `no-matching-order`. Creating the row would be inventing
a customer.

**An amount that disagrees.** Change an order's owed-amount column before paying
it. The payment no longer matches what was owed, and Raze escalates with
`amount-mismatch` instead of writing.

Every refusal names its rule and is listed in the console with the reason in
plain words.

---

## What to look at afterwards

```bash
npm test          # 12 layers, replaying real captured Razorpay deliveries
npm run chaos     # worker killed mid-transaction, forged deliveries, every
                  # delivery dropped, database killed underneath
```

The suite passes with **no API key and no model reachable** — one test empties
`PATH` to prove it.

Every loop pass writes a row to `raze_heartbeat` with a timestamp, whether or not
it found anything. That table is the answer to "was it actually running", and it
survives the process that wrote it.

---

## Notes for anyone reproducing this

- **Razorpay's dashboard and list APIs lag by minutes.** A payment you just made
  can be missing from both while being fully captured. Do not pay twice. Raze
  asks per order and sees it immediately — that lag is exactly why.
- Razorpay refuses `localhost` when registering a webhook. Running locally
  therefore has no webhook, which is the point: reconciliation does not need one.
- Everything here is Test Mode. Raze refuses live keys.
