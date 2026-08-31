# Kettle & Crumb — the shop

A small shop that takes Razorpay payments the way most small shops take Razorpay
payments.

This exists so the problem Raze solves can be watched happening rather than
described. It does not import Raze, does not know it exists, and has no webhook
handler.

## The bug is that there is no bug

Nothing here is sabotaged. There is no flag that breaks it, no injected failure,
no artificial delay, and nothing about Razorpay is simulated.

The only path from `pending` to `paid` is the customer's browser posting back
after Checkout closes — which is exactly how a first integration is written,
because it is the path the quickstart shows and it works every time you test it
yourself.

It works every time you test it because you never close the tab. A customer on a
train does. Their card is charged, Razorpay has the money, and this shop's
database still says `pending` — forever, because nothing here will ever ask
again.

The checkbox on the page (**"customer closes the tab after paying"**) does not
skip the payment. It skips the callback afterwards, which is the only thing a
closed tab actually changes.

## What is seeded and what is not

On first boot it inserts 140 prior orders so the table is not empty. Those rows
are invented and carry **no gateway id** — the shop took that trade over the
counter.

**Every row with a `gateway_order_id` is a real Razorpay order**, created by this
server against the real API. Nothing fakes a payment, a signature, or a Razorpay
response.

## Running it

```bash
npm install
DATABASE_URL=postgres://user:pass@host:5432/postgres \
RAZORPAY_KEY_ID=rzp_test_xxx \
RAZORPAY_KEY_SECRET=xxx \
PORT=4100 node server.js
```

It creates and uses a database of its own (`kettle`) on whatever Postgres
`DATABASE_URL` points at, so a name as ordinary as `shop_orders` cannot collide
with someone else's table — this file's first deployment crashed on exactly that.

Test Mode keys only.

## The schema

Written the way a shop would write it, not the way an integration would like it:

| Column | Why it is like this |
|---|---|
| `order_ref` | What the customer is quoted. The shop's own numbering. |
| `gateway_order_id` | Razorpay's id, kept separately rather than overloaded onto the reference. |
| `amount_due_paise` | What was billed. |
| `amount_paid_paise` | What actually arrived. The owner wants to see both. |
| `order_state` | Plain words the shop's staff read. |

Those two money columns are the distinction Raze has to get right: a payment is
checked against what was **owed**, never against a figure the payment itself
wrote.
