# Quickstart

Written as the path you actually take: clone it, run it with nothing configured,
then point it at your own Razorpay account and watch it recover a real payment.

No Claude subscription is needed for any of this. The chat surface uses one if
you have one; everything that decides whether money is correct is deterministic
code and is asserted to stay that way.

---

## 1. Run it with nothing configured — 2 minutes

```bash
git clone https://github.com/LokarajR/Raze.git
cd Raze
npm install
npm run test:offline
```

`npm install` pulls a real PostgreSQL and a real MongoDB as npm packages, so
there is no database to set up.

Expect **110 assertions across 10 layers, all passing**, on a machine that has
never seen a credential. Two of those layers are the ones to look at first:

```
control        the full probe set against a CORRECT integration → zero findings,
               and the same probes DO fire on a defective one
deterministic  every tool run with `claude` unreachable on PATH
```

Then see it matter:

```bash
npm run demo
```

```
unprotected   1/5 pass, 4 findings — UNSAFE TO SHIP
protected     5/5 pass
control       5/5 pass, 0 findings
```

Same merchant handler in both. The defects are still in their code; Raze sits in
front of it and the money is correct anyway.

---

## 2. Point it at your own Razorpay account — 5 minutes

Create a **Test Mode** account at [razorpay.com](https://razorpay.com) if you do
not have one. Dashboard → Settings → API Keys → Generate Test Key.

```bash
cp .env.example .env
```

```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxx
```

Check that reconciliation can actually enumerate your account. Everything
downstream depends on it:

```bash
node bin/raze gate
```

It writes `gate/RECONCILE_GATE_RESULTS.md`. A `STOP` verdict means enumeration is
lossy on your account — investigate before trusting anything built on it.

---

## 3. A public webhook URL — 5 minutes

Razorpay rejects `localhost` at save time, so deliveries need a public HTTPS
endpoint.

```bash
railway up
railway domain
```

`render.yaml` and `fly.toml` are included if you prefer those. Then, in the
Razorpay dashboard: **Settings → Webhooks → Add New Webhook**

```
URL     https://<your-host>/webhook
Secret  anything; put the same value in .env as RAZORPAY_WEBHOOK_SECRET
Events  payment.authorized, payment.captured, payment.failed,
        order.paid, refund.created
```

---

## 4. The first reconcile — the part that matters

Make a real Test Mode payment. The console can create the link for you:

```bash
npm run web          # http://127.0.0.1:7000
```

Create a payment link, pay it with Razorpay's test card `4111 1111 1111 1111`,
and watch the delivery arrive in the live feed.

Now sever delivery entirely and let Raze recover it from the provider instead:

```bash
node bin/raze reconcile
```

```
reconcile:  3 drifted -> 3 repaired
```

That is the whole thesis in one command. **Raze does not depend on delivery.**
Every webhook can be dropped, every endpoint disabled, and asking Razorpay what
it recorded still recovers the money.

That is not hypothetical. Razorpay disabled four of our endpoints twice during
development, for exactly the reason it disables anyone's — sustained delivery
failure. It is recorded in `measurement/RESULTS.md`, with the two endpoints that
answer correctly surviving both times as a control.

---

## 5. Ask it questions — optional, needs Claude

```bash
node bin/raze agent      # writes .mcp.json from your .env; refuses if either check fails
```

Restart Claude Code in that directory, or open the console, and ask:

```
is everything alright?
```

It answers in money and order ids. The model is given **read tools only** — not
as an instruction it is asked to respect, but as a boundary of the process it
runs in: it cannot repair anything because the tool is not there to call.
Recovery happens only when a human clicks Approve.

If Claude Code is absent, this surface says so plainly and points at the CLI.
Everything in sections 1–4 keeps working.

---

## What to look at if you have five minutes

| | |
|---|---|
| `measurement/RESULTS.md` | 796 real deliveries. The retry ladder, measured: 16 attempts across 22.76 hours, first retry 0.23s. Two live endpoint deactivations, with a control. |
| `test/control.test.js` | zero findings on correct code, asserted on every build |
| `test/deterministic.test.js` | the core running with `claude` unreachable |
| `npm run eval:public` | ten real published integrations, fetched at run time, scanned |

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| `could not create directory ... Permission denied` | The clone is somewhere unwritable, usually `System32`. `cd ~` and clone again. |
| `pre-existing shared memory block is still in use` | Run the command again; Raze clears its own orphan. |
| Two checkouts on one machine | Nothing. The port is chosen from 55432 upward; `RAZE_PG_PORT` pins it. |
| `MISMATCHED` state | Raze is reading columns your schema does not have. `node bin/raze infer` proposes the right ones. |
| `BLIND` state | Razorpay is unreachable — check the keys. This is deliberately not reported as "fine". |
| Want your own Postgres | Set `DATABASE_URL`; the embedded server never starts. |

Do not pipe these commands into `head` or `findstr`. A closed pipe kills the
process early and can make a failure look like a pass.
