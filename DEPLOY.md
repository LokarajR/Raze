# Deploying a public webhook endpoint

Razorpay rejects `localhost` when you save a webhook — the endpoint must be
publicly reachable over HTTPS on 443. This is only needed for **real mode**;
demo mode runs entirely locally.

Do not use ngrok for a live demonstration. A tunnel dropping mid-pitch is
indistinguishable from the product failing.

All three options deploy the same `Dockerfile`, which runs the demo merchant in
`protected` mode — the Raze runtime in front of an unmodified handler.

## Railway

```bash
railway init
railway add --database postgres
railway variables set \
  RAZORPAY_KEY_ID=... \
  RAZORPAY_KEY_SECRET=... \
  RAZORPAY_WEBHOOK_SECRET=...
railway up
railway domain          # prints the public URL
```

`railway.json` sets the healthcheck to `/health`. `DATABASE_URL` is injected by
the Postgres plugin.

## Render

```bash
render blueprint launch      # or connect the repo in the dashboard
```

`render.yaml` provisions a free Postgres and wires `DATABASE_URL` automatically.
The three Razorpay variables are marked `sync: false`, so set them in the
dashboard — they are never committed.

## Fly.io

```bash
fly launch --no-deploy
fly postgres create --name raze-db
fly postgres attach raze-db
fly secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=...
fly deploy
```

`fly.toml` sets `auto_stop_machines = false` deliberately: a stopped machine
refuses connections, which from Razorpay's side is indistinguishable from a
broken webhook — and roughly 24 hours of that gets the endpoint disabled.

## After deploying

1. Confirm the endpoint answers:

   ```bash
   curl https://<your-host>/health
   # {"ok":true,"mode":"protected"}
   ```

2. Razorpay dashboard → Settings → Webhooks → add
   `https://<your-host>/webhook`, set the same secret as
   `RAZORPAY_WEBHOOK_SECRET`, and subscribe to `payment.authorized`,
   `payment.captured`, `payment.failed`, `order.paid`, `refund.created`.

3. Create a real Test Mode payment, then:

   ```bash
   raze status
   raze ledger --sweep
   ```

## If deliveries stop arriving

Razorpay disables an endpoint after roughly 24 hours of sustained delivery
failure and emails a notice for each one. Delivery does not resume on its own —
re-enable the webhook in the dashboard. This was observed directly during the
measurement; see `measurement/RESULTS.md`.
