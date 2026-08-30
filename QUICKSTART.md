# Quickstart

Four commands to see Raze work. No Razorpay account, no Docker, no configuration.

```bash
git clone https://github.com/LokarajR/Raze.git
cd Raze
npm install
npm run test:offline
```

`npm install` pulls a real PostgreSQL and a real MongoDB as npm packages, so
there is no database to set up. Expect **77 assertions across 7 layers**, all
passing, on a machine that has never seen a credential.

Then:

```bash
npm run eval:public    # ten real published integrations, scanned    ~20s
npm run demo           # a broken merchant, then the same code protected
npm run web            # the console at http://127.0.0.1:7000
```

## What each one shows

**`test:offline`** — the guarantee, tested. Duplicate deliveries, the real
16-delivery retry ladder, forged signatures, out-of-order events, a handler that
throws mid-transaction, a worker SIGKILLed while holding a lock.

**`eval:public`** — ten integrations written by other people, fetched at run time
and never vendored. Six have a webhook handler; three of those match known
defects, with the file and line.

**`demo`** — a merchant with real defects is started with its own database, five
real captured Razorpay deliveries are fired at it, and the result is read out of
its own table. Then the identical probes run with Raze in front of the *unchanged*
handler.

```
unprotected   1/5 pass, 4 findings — UNSAFE TO SHIP
protected     5/5 pass
control       5/5 pass, 0 findings
```

**`web`** — the same engine behind a page: import a repository, watch the probes,
see the money, then put Raze in front.

## As an MCP server

```bash
npm run mcp
```

It speaks JSON-RPC on stdout, so a terminal showing nothing is correct — it is
run by a client. Add to Claude Code, Cursor, Windsurf or Claude Desktop:

```json
{
  "mcpServers": {
    "raze": {
      "command": "node",
      "args": ["/absolute/path/to/Raze/bin/raze-mcp"],
      "env": {
        "DATABASE_URL": "postgres://...",
        "RAZORPAY_KEY_ID": "rzp_test_...",
        "RAZORPAY_KEY_SECRET": "..."
      }
    }
  }
}
```

Then ask your editor: *"what happened to order_XYZ?"*

## With your own Razorpay Test Mode account

Put your keys in `.env`:

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

Run the reconciliation gate first — everything downstream depends on it:

```bash
npm test               # all layers, including the live-API ones
node bin/raze gate     # writes gate/RECONCILE_GATE_RESULTS.md
```

A `STOP` verdict means enumeration is lossy. Investigate before building on it.

To receive real deliveries you need a public HTTPS endpoint; Razorpay rejects
localhost at save time.

```bash
railway up
railway domain
```

Then Razorpay dashboard → Settings → Webhooks → point at
`https://<your-host>/webhook` with the same `RAZORPAY_WEBHOOK_SECRET`.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `could not create directory ... Permission denied` | The clone is somewhere unwritable, usually `System32`. `cd ~` and clone again. |
| `pre-existing shared memory block is still in use` | Run the command again; Raze clears its own orphan. |
| Two checkouts on one machine | Nothing. The port is chosen from 55432 upward. `RAZE_PG_PORT` pins it. |
| Want your own Postgres | Set `DATABASE_URL`; the embedded server never starts. |

Do not pipe these commands into `head` or `findstr`. A closed pipe kills the
process early and can make a failure look like a pass.
