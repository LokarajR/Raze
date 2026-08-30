# If it breaks on stage

One page. Open it, find the row, run the command, say the line.

**The CLI is the fallback for everything.** Nothing in the deterministic core
needs the chat surface, the console, or a network. If two things fail at once,
skip to the bottom and run the offline suite — that alone tells the whole story.

---

## The line to have ready

Whatever fails, say this once and move on. Do not apologise twice.

> That's the demo failing, not the product. Everything that decides whether the
> money is correct runs from the command line — let me show you there.

Then run the fallback and keep going. Judges forgive a broken demo. They do not
forgive fumbling.

---

## The three failures, and what to run

### 1. The chat surface does not answer

*Symptom:* "Ask Raze" hangs, or answers "I could not start Claude Code".

*Say:*

> The conversation is an interface, not the engine. It needs Claude Code
> installed; the engine doesn't need a model at all. Here's the same answer from
> the command line.

*Run:*

```bash
node bin/raze status
```

That prints reconciliation state, the ledger, the inbox and the outbox, with no
model anywhere. If you want the same five-state answer the chat gives:

```bash
node test/deterministic.test.js
```

That runs every tool with `claude` unreachable on PATH and passes. It is the
strongest possible version of this recovery: the failure you just hit is the
thing the test proves does not matter.

---

### 2. Postgres is not up

*Symptom:* `embedded postgres failed to start`, `ECONNREFUSED`, or
`pre-existing shared memory block is still in use`.

*First, just run it again.* Raze clears its own orphaned Postgres on the next
start, and this usually resolves on the second attempt.

*If it still fails, say:*

> There's a Postgres on this machine from an earlier run. Raze detects that and
> takes the next free port — let me give it a clean one.

*Run:*

```bash
RAZE_PG_PORT=55500 npm run test:offline
```

*Or point it at any Postgres you have:*

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/db npm run test:offline
```

*Or, in the worst case, kill the orphan yourself:*

```powershell
Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Select ProcessId,CommandLine
```

Kill only PIDs whose path contains this checkout. Then re-run.

---

### 3. The webhook URL is dead

*Symptom:* the deployed console is down, the payment link fails, or no delivery
arrives after you pay.

*Say:*

> Delivery is exactly what Raze refuses to depend on — so this is a convenient
> failure. Watch what happens when I sever it deliberately.

*Run:*

```bash
npm run demo
```

That is the whole story in 20 seconds, entirely local: a merchant with real
defects, four findings, then the same handler behind Raze passing 5/5, then a
correct integration with zero findings.

*If you still have Razorpay credentials and a network:*

```bash
node bin/raze reconcile
```

```
reconcile:  3 drifted -> 3 repaired
```

Payments recovered with no delivery at all. If the network is also gone, say:

> Razorpay disabled four of our endpoints twice while we built this, for
> sustained delivery failure. It is in `measurement/RESULTS.md`, with the two
> endpoints that answer correctly surviving both times as a control. This is the
> failure the product exists for.

---

## If everything fails

```bash
npm run test:offline
```

90 assertions, ten layers, no credentials, no model, no network. It includes the
two that carry the argument:

```
control        the full probe set against correct code → zero findings,
               and the same probes still fire on the broken one
deterministic  every tool run with claude unreachable on PATH
```

Say:

> Nothing here is simulated and nothing here needs my laptop to cooperate. 796
> real captured deliveries, ten real published integrations scanned, and the
> control that says it finds nothing on correct code — which is the assertion
> that makes every other finding worth believing.

---

## Before you start, thirty seconds of prevention

```bash
node bin/raze status                 # postgres is up, nothing is stale
claude -p "reply with OK"            # the chat surface will work
curl -s -o /dev/null -w "%{http_code}\n" https://<your-host>/health
```

Three answers: state printed, `OK`, and `200`. If any is wrong, you already know
which section above you will need, before anyone is watching.

**And check this one, because it is invisible until it bites:**

```powershell
[Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User')
```

If that prints anything, the chat surface is running on an API key rather than
your subscription — and a judge who clones the repo will not have one. Remove it:

```powershell
[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')
```

Then close and reopen the terminal. Or, for one session only:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo-shell.ps1
```
