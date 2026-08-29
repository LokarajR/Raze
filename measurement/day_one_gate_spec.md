# Day-One Gate — Razorpay Webhook Retry Measurement Harness

**Hand this whole file to Claude Code as the task spec.**

---

## 0. Purpose (read this first, it determines every design decision)

We are building a product that tests whether a merchant's Razorpay webhook integration survives real-world delivery edge cases. Before writing any product code, we must answer three empirical questions about Razorpay's **actual** retry behaviour. Razorpay's docs state that retries happen on an "exponential backoff schedule over 24 hours" but **never publish the actual schedule**. We cannot design a demo around behaviour we have not measured.

**This harness is a measurement instrument, not a product.** Its only job is to record ground truth.

### The three questions

1. **Retry timing** — When an endpoint fails to respond correctly, how long until Razorpay's first retry? Second? Third? How many total?
2. **Duplicate identity** — Is the retried event byte-identical to the original? Is `x-razorpay-event-id` unchanged? Is the signature unchanged?
3. **Failure trigger threshold** — Which endpoint behaviours actually trigger a retry: HTTP 500? HTTP 4xx? A slow 200 (>5s)? A connection drop?

### Absolute constraint: nothing is simulated

- No mock Razorpay server.
- No hand-crafted webhook payloads.
- No fake timestamps.
- Every byte logged must have arrived over the network from Razorpay's infrastructure.

If a design decision would require faking any part of this, stop and flag it rather than working around it.

---

## 1. Critical implementation requirement: raw body capture

**This is the single most important detail in the spec. Get it wrong and every measurement is worthless.**

Razorpay computes `X-Razorpay-Signature` as HMAC-SHA256 over the **raw request body bytes**, keyed with the webhook secret. Any JSON parse-and-reserialize changes key ordering and whitespace, producing a different byte string.

We must capture and persist the **exact original bytes**, before any parsing.

In Express, `express.json()` consumes the stream and discards the raw body. Use the `verify` callback to stash it:

```js
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;              // Buffer, untouched bytes
    req.rawBodyHex = buf.toString('hex');
  }
}));
```

Persist `rawBody` as a hex string or base64 in the log. Never persist only the parsed object — we need to prove byte-identity between original delivery and retry, and that proof requires the original bytes.

Also capture **all** request headers verbatim, not a filtered subset. We do not yet know which headers matter.

---

## 2. What to build

### 2.1 The probe server

A single small Node/Express service (or Python/FastAPI — Node is preferred for Razorpay SDK parity).

**Endpoints:**

| Path | Method | Behaviour |
|---|---|---|
| `/webhook/mode-500` | POST | Log the delivery, then respond `500`. |
| `/webhook/mode-slow` | POST | Log the delivery, wait 8 seconds, then respond `200`. |
| `/webhook/mode-drop` | POST | Log the delivery, then destroy the socket without responding. |
| `/webhook/mode-200` | POST | Log the delivery, respond `200` immediately. **Control.** |
| `/webhook/mode-400` | POST | Log the delivery, respond `400`. |
| `/health` | GET | Respond `200 OK`. For deploy verification. |

Every webhook path uses the **same** logging function. The only difference is the response.

**Per-delivery log record** (append-only, one JSON object per line, or a SQLite row):

```json
{
  "seq": 1,
  "received_at_iso": "2026-08-27T14:03:11.482Z",
  "received_at_ms": 1787845391482,
  "path": "/webhook/mode-500",
  "method": "POST",
  "headers": { "...": "every header verbatim, no filtering" },
  "event_id": "value of x-razorpay-event-id, or null",
  "signature": "value of X-Razorpay-Signature, or null",
  "event_type": "parsed body.event, e.g. payment.captured",
  "raw_body_b64": "base64 of exact bytes",
  "raw_body_sha256": "hex digest of exact bytes",
  "raw_body_length": 1234,
  "remote_ip": "source IP",
  "response_sent": 500,
  "response_delay_ms": 0
}
```

`raw_body_sha256` is what makes byte-identity checkable in one comparison.

**Persistence must survive process restart.** Append to a file on a mounted volume, or SQLite on disk. If the host restarts mid-measurement and we lose the log, the run is void.

Log to **stdout as well**, in a single readable line per delivery, so a live terminal shows retries arriving in real time. This doubles as the demo view.

### 2.2 The analysis script

A separate script that reads the log and answers the three questions. Run it after each measurement run.

**Output for each `event_id` seen more than once:**

```
EVENT: evt_ABC123  (payment.captured)  path=/webhook/mode-500
  deliveries: 5
  arrival deltas: +0s, +12s, +47s, +180s, +720s
  body sha256 identical across all deliveries: YES
  signature identical across all deliveries: YES
  event_id identical across all deliveries: YES (by definition of grouping)
  headers that differ between deliveries: [x-razorpay-retry-count, ...]
```

**Summary section:**

```
MODE          UNIQUE EVENTS  MAX DELIVERIES  FIRST RETRY DELAY  RETRIED?
mode-500      3              5               12s                YES
mode-slow     3              2               9s                 YES
mode-drop     3              4               15s                YES
mode-400      3              1               —                  NO
mode-200      3              1               —                  NO
```

The `mode-200` row is the control. If it shows retries, something is wrong with our understanding and we must stop and investigate.

Compute the diff of header sets between first and subsequent deliveries — Razorpay may add a retry-count or attempt header we do not know about. Finding one would be valuable.

### 2.3 Deployment

Razorpay hard requirements:

- Webhook URLs must be **publicly reachable**. Localhost will be rejected at save time.
- Webhook URLs must use **port 80 or 443 only**.
- Razorpay's webhook source IPs may need allowlisting depending on host firewall config.

**Do not use ngrok or any tunnel for this measurement.** Tunnels drop and reconnect; a dropped tunnel is indistinguishable in our logs from Razorpay giving up. Deploy to a real host: Railway, Render, or Fly.io. Free tiers are fine.

**Beware host-level idle sleep.** Some free tiers sleep after inactivity, and a cold start can take 30+ seconds — which would corrupt the timing measurement and may itself trigger a retry. Verify the chosen host either does not sleep or configure a keepalive ping every 60 seconds for the duration of the run.

Note the deployed base URL in the run log.

---

## 3. Manual steps (these are for the human, not Claude Code)

Claude Code should print these as a checklist when the harness is ready to run.

1. Razorpay Dashboard → **Test Mode** (confirm the toggle; live mode would cost real money).
2. Settings → Webhooks → Add Webhook.
3. URL: the deployed probe URL + path (e.g. `https://<host>/webhook/mode-500`).
4. Set a webhook **secret** — record it, we need it later for signature verification work.
5. Subscribe to events: `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.created`.
6. When prompted for OTP in test mode, the default is **754081**.
7. Create **five separate webhook configs**, one per mode path, all with the same secret and events.
8. Trigger a real test payment (Payment Links is the fastest route, or a test-mode checkout).
9. Watch the stdout stream. Leave it running for **at least 90 minutes** — early retries may be seconds apart while later ones stretch out.
10. Run the analysis script.

**Repeat the whole run three times** on different days/times. One run is an anecdote.

---

## 4. Gate outcomes

Record the result explicitly. These outcomes change the product design.

| Observation | Consequence |
|---|---|
| First retry arrives **under 60s** | Live retry demo is viable. Timeout/retry becomes the headline probe — Razorpay itself produces the duplicate, fully real, nothing constructed. |
| First retry arrives **60s–10min** | Not live-demoable. Pre-record a real run with real timestamps and present the captured trace. Still fully real, just not live. |
| First retry **>10min or never** | Razorpay-generated duplicates are off the table for the demo. Product falls back to constructed adversarial probes only. Weaker story — decide whether to continue. |
| Retried body is **not byte-identical** | Major finding. Signature-based replay assumptions break. Investigate before proceeding. |
| `x-razorpay-event-id` **changes** on retry | Idempotency-by-event-id is unreliable and the entire Test 1 premise needs rework. Investigate immediately. |
| `mode-200` control shows **any** retry | Our model of retry triggers is wrong. Stop and investigate. |

---

## 5. Non-goals for this harness

Do not build any of the following yet. They belong to the product, not the measurement:

- Signature tampering or forged-signature probes
- Event reordering
- Business-state observation or database reads
- Any LLM/explanation layer
- Any UI beyond stdout
- The demo applications themselves

Scope creep here costs days we do not have.

---

## 6. Deliverables

1. `probe-server/` — the Express service, deployable.
2. `analyze.js` (or `.py`) — the analysis script.
3. `RESULTS.md` — written after the runs, containing:
   - Deployed URL and host
   - Timestamps of each run
   - The summary table from §2.2
   - The gate outcome from §4, stated explicitly
   - Any surprises

`RESULTS.md` is the actual output of this exercise. The code is disposable; the measurement is not.
