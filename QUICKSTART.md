# Quickstart

## Demo mode — no Razorpay account, no Docker, no network

```bash
npm install
npx raze demo --sever-delivery
```

With no `DATABASE_URL`, Raze starts a real embedded PostgreSQL under `.pgdata`.
The audit probes replay the captured delivery corpus, so nothing external is
needed. The `--sever-delivery` recovery step does query the live Razorpay API and
needs credentials; omit the flag to stay fully offline.

Prefer containers? `docker compose up -d` first, then
`DATABASE_URL=postgres://raze:raze@localhost:5432/raze npx raze demo`.

## Real mode — your own Razorpay Test Mode account

1. `cp .env.example .env` and fill in your Test Mode keys.

2. Run the reconciliation gate first. Everything downstream depends on it:

   ```bash
   npx raze gate
   ```

   It writes `gate/RECONCILE_GATE_RESULTS.md`. A `STOP` verdict means
   enumeration is lossy — investigate before building on it.

3. Deploy a public webhook endpoint. Razorpay rejects localhost at save time.

   ```bash
   # Railway
   railway up
   # Render / Fly.io: see their own docs; any HTTPS host on 443 works
   ```

4. In the Razorpay dashboard, Settings → Webhooks, point a webhook at
   `https://<your-host>/webhook` and set the same secret you put in `.env`.

5. Initialise and protect:

   ```bash
   npx raze init
   npx raze protect
   ```

6. Create a real Test Mode payment. Then:

   ```bash
   npx raze status
   npx raze ledger --sweep
   ```

## Running the tests

```bash
node test/layer1.test.js     # runtime — real captured deliveries, real Postgres
node test/layer3.test.js     # reconciliation — live Razorpay API
node test/layer2.test.js     # ledger — creates a real unpaid order
node test/layer4.test.js     # audit — all three integrations, control included
```

Layers 2 and 3 call the live Razorpay API and need credentials. Layer 1 and the
audit probes need only the captured corpus.

## Troubleshooting

**`pre-existing shared memory block is still in use`** — two processes tried to
start the embedded Postgres on one data directory. Pass `DATABASE_URL` to the
second, or `taskkill /F /IM postgres.exe` (Windows) / `pkill postgres` and retry.

**`raze gate` returns FALLBACK** — `order_id` was missing on some payments.
Reconciliation still works, keyed on `payment_id` persisted at order creation.
Record the limitation.

**No drift found when you expect some** — reconciliation only counts settled
payments (`captured`, `refunded`). A `failed` payment moved no money; its absence
is the ledger's business, not reconciliation's.

**Webhook saved but nothing arrives** — check the endpoint is HTTPS on 443 and
publicly reachable, and that the secret matches. Razorpay disables an endpoint
after roughly 24 hours of sustained failure and emails you; it must then be
re-enabled by hand in the dashboard.
