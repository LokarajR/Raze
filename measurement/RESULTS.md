# RESULTS — Razorpay Webhook Retry Measurement

> **STATUS: RUNS 1 AND 2 COMPLETE.** Every number below came from deliveries that
> arrived over the network from Razorpay's infrastructure and was read out of the
> append-only log. Nothing is estimated, inferred, or copied from Razorpay's
> documentation. Cells that could not be filled from the log say `not measured`.
>
> Run 2 reproduces Run 1 step for step. Run 3 is still outstanding.
>
> This file is the actual output of the exercise. The code is disposable; the
> measurement is not.

## Deployment

Filled in from the deploy itself, not from documentation. Everything marked
*verified* was checked against the live host.

| | |
|---|---|
| Deployed base URL | `https://probe-production-8fd7.up.railway.app` |
| Host and plan | Railway, free trial ($5 credit / 30 days). Project `razorpay-retry-probe`, service `probe`. |
| Region | Railway edge `sin1` (Singapore) — from `x-railway-edge` on live responses |
| Persistent storage | Volume `probe-volume`, 500 MB, mounted at `/data`; log at `/data/deliveries.jsonl`. **Survives restart: yes — verified.** Redeployed, `boot_id` changed and `/health` reported `resumed_from: 6`, so the append-only log was intact across the restart. |
| Idle sleep behaviour | Railway app-sleeping (serverless) was never enabled on this service, so the instance stays warm. **Confirm the toggle is off in the Railway dashboard before each run**; if in doubt run `node keepalive.js https://probe-production-8fd7.up.railway.app/health` for the whole window. |
| `mode-drop` reaches Razorpay as | **Edge 502, not a TCP reset — verified.** `POST /webhook/mode-drop` through the public URL returns `HTTP 502` with body `{"status":"error","code":502,"message":"Application failed to respond",...}` and header `x-railway-fallback: true`. Railway terminates TLS at its own edge, so destroying the origin socket makes the edge synthesize a 502 towards the caller. **`mode-drop` on this host therefore measures "upstream 502", NOT "connection dropped".** Do not conflate it with a true connection reset when reading the results. |
| Webhook secret recorded | Yes. 32-char hex, generated locally, same value on all five webhook configs. Stored **only** in `probe-server/.env` as `RAZORPAY_WEBHOOK_SECRET` (gitignored, and excluded from the Docker build context via `.dockerignore`). The value is deliberately not written into any tracked file. The probe does not use it — signature verification is a spec §5 non-goal — it is recorded so every logged `raw_body_b64` can be signature-verified offline later. |
| Razorpay mode | Test mode confirmed: **yes** — API key is `rzp_test_...`, and the Payment Link page rendered the "created in Test Mode" banner. No real money moved. |

Live-endpoint check through the public URL (deploy verification only, not measurement):

```
GET  /health              -> 200
POST /webhook/mode-500    -> 500
POST /webhook/mode-400    -> 400
POST /webhook/mode-200    -> 200
POST /webhook/mode-slow   -> 200 after 8.34s   (SLOW_DELAY_MS=8000)
POST /webhook/mode-drop   -> 502 from Railway edge (see caveat above)
```

Those six checks wrote 6 records into `/data/deliveries.jsonl` before any Razorpay
traffic existed. Rather than delete them (the Railway CLI refuses file deletes when
it detects an agent, and its own suggested command prints the wrong flag order), the
run was pointed at a **fresh file on the same volume**:

```
LOG_DIR=/data/run1        ->  /data/run1/deliveries.jsonl
```

Verified after redeploy: `/health` reports `log_file: /data/run1/deliveries.jsonl`,
`deliveries_logged: 0`, `resumed_from: 0`. **Not one byte in the measurement log
came from anything but Razorpay.** The six deploy-check records remain at
`/data/deliveries.jsonl`, untouched, as the audit trail for the table above.

Use a new directory per run — `/data/run2`, `/data/run3` — so each run's log is
independent and no run can contaminate another:

```bash
railway variables --service probe --set "LOG_DIR=/data/run2"
railway redeploy --yes --service probe
```

Pulling the log for analysis:

```bash
# over HTTP, token is in probe-server/.env
curl -H "x-probe-token: $DOWNLOAD_TOKEN" https://probe-production-8fd7.up.railway.app/_log/download > deliveries.jsonl

node analyze.js ./deliveries.jsonl
```

`/_log/download` always serves whatever `LOG_DIR` currently points at, so pull the
log **before** switching `LOG_DIR` for the next run.

## Runs

Three runs, on different days and times. One run is an anecdote.

### Run 1

| | |
|---|---|
| Started (ISO, UTC) | `2026-08-27T14:03:39.686Z` (first delivery) |
| Ended (ISO, UTC) | `2026-08-27T15:35:40Z` (log pulled); last delivery `2026-08-27T15:30:11.089Z` |
| Window length | **92 min** (>= 90 min required) |
| Trigger used | Payment Link `plink_TUoqyzFHdqfBFY`, INR 1, paid via test-mode netbanking. Payment `pay_TUouivTMBk4OY6`. |
| Events subscribed | `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.created` (all five configs) |
| Deliveries logged | **141** |
| Server restarts during window | **0** (single `boot_id` across the whole log) |
| Events actually produced | 3 — `payment.authorized` (`TUoumpUn1znA6u`), `payment.captured` (`TUouniJth9WtQ2`), `order.paid` (`TUouo1AHHh2FHC`). `payment.failed` and `refund.created` did not fire; nothing failed and nothing was refunded. |

```
=== SUMMARY ===
MODE          UNIQUE EVENTS  MAX DELIVERIES  FIRST RETRY DELAY     RETRIED?
mode-500      3              12              0.2s (0.2s-0.2s)      YES
mode-slow     3              11              13.6s (13.6s-14.4s)   YES
mode-drop     3              12              0.2s (0.2s-0.2s)      YES
mode-400      3              11              5.8s (5.8s-6.7s)      YES
mode-200      3              1               —                     NO

=== FLAGS ===
(none)
```

**Retry schedule per mode**, deltas from the original delivery. Same event
(`payment.captured`, `TUouniJth9WtQ2`) across all five endpoints, so the modes are
directly comparable:

```
mode-500   12 deliveries   0.0s, 0.2s, 6.1s, 19.1s, 39.5s, 82.3s, 164.5s, 326.1s, 650.5s, 1293.4s, 2576.5s, 5139.9s
mode-drop  12 deliveries   0.0s, 0.2s, 6.3s, 18.8s, 39.5s, 82.3s, 164.4s, 326.1s, 650.2s, 1293.5s, 2576.6s, 5139.9s
mode-400   11 deliveries   0.0s,       6.1s, 18.5s, 39.7s, 82.3s, 164.3s, 325.8s, 650.2s, 1293.4s, 2576.5s, 5139.8s
mode-slow  11 deliveries   0.0s,      13.6s, 30.5s, 58.1s, 105.3s, 194.0s, 362.7s, 690.6s, 1337.7s, 2623.3s, 5190.7s
mode-200    1 delivery     0.0s
```

After the first couple of steps the interval doubles cleanly: ~20s, 40s, 82s, 164s,
326s, 650s, 1293s, 2577s, 5140s. **The probe was still receiving retries when the
window closed at 92 minutes**, so the total number of attempts and the point at which
Razorpay gives up were NOT reached — `not measured`. Extrapolating the doubling would
put the next attempt near +2.9h, consistent with Razorpay's documented "over 24
hours", but that is inference, not measurement, and is recorded here as such.

**Signature verification of the captured bytes.** Every logged `raw_body_b64` was
HMAC-SHA256'd with the webhook secret and compared to the `X-Razorpay-Signature`
header recorded alongside it:

```
signature verifies: 141/141   mismatches: 0
```

This is the proof that the raw-body capture is byte-exact. Had `express.json()`
parsed and re-serialized the body, key ordering and whitespace would have shifted
and these would not verify.

### Run 2

Run 2 was deliberately logged to the **same file** as Run 1 rather than rotating
`LOG_DIR`. Rotating would have made `/data/run1` unreadable (the probe only serves
whatever `LOG_DIR` currently points at) and would have diverted any late Run 1
retry into Run 2's log. Because `analyze.js` groups by `(mode, event_id)`, the two
runs stay completely separate inside one file; they are split back out by
`event_id` into `run1-deliveries.jsonl` and `run2-deliveries.jsonl` for analysis.

| | |
|---|---|
| Started (ISO, UTC) | `2026-08-28T13:30:03.195Z` (first delivery) |
| Gate window closed | `2026-08-28T15:01Z` — **91 min** (>= 90 min required) |
| Trigger used | Payment Link `plink_TVCpfgE1OsYs1O`, INR 1, test-mode netbanking. Payment `pay_TVCsKe6a4pkI5j`. Then a full refund (`rfnd_TVCtCeHGHVUVuT`) to fire `refund.created`, and a deliberately failed payment on `plink_TVCtTq2BLrOe13` to fire `payment.failed`. |
| Deliveries logged (Run 2 only) | **231** at gate close |
| Server restarts during window | **0** |
| Events produced | **5** — `payment.authorized` (`TVCsPCVArESdpc`), `payment.captured` (`TVCsQ1cdGY8e1W`), `order.paid` (`TVCsQOXaIRbTT0`), `refund.created` (`TVCtlcwEXm4Eas`), `payment.failed` (`TVCzmP1a7zfyQ9`). All five subscribed types are now covered. |

```
=== SUMMARY ===
MODE          UNIQUE EVENTS  MAX DELIVERIES  FIRST RETRY DELAY     RETRIED?
mode-500      5              12              0.2s (0.2s-8.6s)      YES
mode-slow     5              11              11.0s (11.0s-12.7s)   YES
mode-drop     5              12              0.2s (0.2s-8.4s)      YES
mode-400      5              11              5.9s (5.9s-8.6s)      YES
mode-200      5              1               —                     NO

=== FLAGS ===
(none)
```

**Reproduction check.** Same mode, same event type, both runs, deltas in seconds:

```
Run 1  mode-500 payment.captured:
  0.2, 6.1, 19.1, 39.5, 82.3, 164.5, 326.1, 650.5, 1293.4, 2576.5, 5139.9, 10267.2, 20508.1, 40988.6, 81953.0
Run 2  mode-500 payment.captured:
  0.2, 6.3, 19.6, 40.4, 83.5, 165.4, 327.6, 648.8, 1291.2, 2575.1, 5137.5
```

Every step agrees to within a couple of percent, a day apart, at a different time of
day. **The backoff schedule is deterministic — not load-dependent and not jittered.**

**Signature verification:** `231/231`, zero mismatches. Byte-exact capture holds.

**New in Run 2 — the instant retry is event-type dependent.** Run 1 only ever
produced payment-lifecycle events, so its first retry looked like a flat 0.2s.
Run 2 added `refund.created` and `payment.failed`, and they behave differently:

| Event type | First retry (mode-500) | Total attempts |
|---|---|---|
| `payment.authorized` | 0.2s | 12 |
| `payment.captured` | 0.2s | 12 |
| `order.paid` | 0.3s | 12 |
| `refund.created` | **6.8s** | 11 |
| `payment.failed` | **8.6s** | 11 |

The three payment-lifecycle events get an immediate near-duplicate at ~0.2s and
therefore one extra attempt; `refund.created` and `payment.failed` skip it and start
at the ~6-9s step instead — exactly the pattern `mode-400` shows. After that first
step all five follow the identical doubling curve.

This does not change the gate outcome (every value is far under 60s), but it does
change what can be claimed. "First retry in 0.2 seconds" is true **for payment
events**, not for every webhook.

### Run 3

Run 3 was placed deliberately in a **morning** slot. Runs 1 and 2 both started in the
afternoon/evening (14:03Z and 13:30Z), which meant time of day was the one variable
the reproduction check could not speak to. Run 3 started at 04:00Z — nine and a half
hours earlier in the day than either predecessor — specifically to test whether the
backoff schedule is load- or time-dependent. Same log file, same `boot_id`, split out
by `event_id` into `run3-deliveries.jsonl` exactly as Run 2 was.

| | |
|---|---|
| Started (ISO, UTC) | `2026-08-29T04:00:07.953Z` (first delivery) |
| Local time | 09:30 IST — morning slot, ~9.5h earlier in the day than Runs 1 and 2 |
| Gate window closes | `2026-08-29T05:30Z` (90 min) |
| Trigger used | Payment Link `plink_TVResICmHpRBUk`, INR 1, test-mode netbanking. Payment `pay_TVRhBUzohX46of`, order `order_TVRgqVVfsPAubD`. Then a full refund (`rfnd_TVRih5Xi0dNvIV`) to fire `refund.created`, and a deliberately failed payment on `plink_TVFEhxxq4ydeVH` to fire `payment.failed`. |
| Deliveries logged (Run 3 only) | **231** at gate close — the identical count Run 2 produced |
| Server restarts during window | **0** (`server boots: 1`) |
| Events produced | **5** — `payment.authorized` (`TVRhV17g6dYxgA`), `payment.captured` (`TVRhVuiyJLwYwq`), `order.paid` (`TVRhWFuBA4mKnQ`), `refund.created` (`TVRjGqGx1reYUL`), `payment.failed` (`TVRjvDsMnuT86O`). All five types again. |

```
=== SUMMARY ===
MODE          UNIQUE EVENTS  MAX DELIVERIES  FIRST RETRY DELAY     RETRIED?
mode-500      5              12              0.2s (0.2s-6.0s)      YES
mode-slow     5              11              11.0s (11.0s-13.9s)   YES
mode-drop     5              12              0.2s (0.2s-6.0s)      YES
mode-400      5              11              5.9s (5.9s-6.9s)      YES
mode-200      5              1               —                     NO

=== FLAGS ===
(none)
```

At gate close this table is **cell-for-cell identical to Run 2's** in every column
except the upper bound of the first-retry range, and Run 3 produced exactly the same
total, **231 deliveries**. The only difference anywhere is the range ceiling —
`0.2s-6.0s` where Run 2 read `0.2s-8.6s` — which is the `payment.failed` discrepancy
discussed below and nothing else.

The control row is the one that matters most: `mode-200` sits at exactly 1 delivery
per event for the third consecutive run. A single retry there would have invalidated
the model of what triggers a retry.

**Reproduction check across all three runs**, same mode, same event type, deltas in
seconds:

```
Run 1  mode-500 payment.captured:
  0.2, 6.1, 19.1, 39.5, 82.3, 164.5, 326.1, 650.5, 1293.4, ...
Run 2  mode-500 payment.captured:
  0.2, 6.3, 19.6, 40.4, 83.5, 165.4, 327.6, 648.8, 1291.2, ...
Run 3  mode-500 payment.captured:
  0.2, 6.4, 17.8, 41.0, 82.6, 165.2, 325.5, 647.9, ...
```

Three runs, spanning three days and two different times of day, agree at every step.
**No time-of-day or load dependence exists in the retry schedule.** This was Run 3's
stated purpose and it returns a clean negative — which is the useful answer, because
it means a demo's timing can be trusted at any hour.

**Signature verification:** clean on every event, all five types. Byte-exact capture
holds for the third run.

**What Run 3 changed — the 8.6s figure does not reproduce.** Run 2's headline
event-type finding was that `refund.created` and `payment.failed` skip the instant
0.2s retry. That structure reproduced exactly. The *magnitude* did not:

| event_type | mode | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| `payment.authorized` | mode-500 | 0.23s | 0.23s | 0.24s |
| `payment.captured` | mode-500 | 0.23s | 0.23s | 0.23s |
| `order.paid` | mode-500 | 0.25s | 0.27s | 0.24s |
| `refund.created` | mode-500 | — | 6.76s | 5.97s |
| `payment.failed` | mode-500 | — | **8.60s** | **5.88s** |

**RESOLVED 2026-08-29 by a fourth sample. It is variance, not time of day.**

| mode | Run 2, 13:37Z | Run 3, 04:02Z | Run 4, 12:35Z |
|---|---|---|---|
| `mode-400` | 8.63s | 5.87s | 7.23s |
| `mode-500` | 8.60s | 5.88s | 7.64s |
| `mode-drop` | 8.39s | 6.00s | 8.86s |
| `mode-slow` | 12.65s | 13.09s | 12.32s |

An earlier draft argued that because each run's three modes clustered tightly
(spread 0.24s in Run 2, 0.13s in Run 3), the 8.6s and 5.9s figures could not be
noise and had to reflect a real per-run difference, with time of day the leading
candidate. **Run 4 refutes that.** Its within-run spread is 1.63s — wider than
the between-run gap that made the two-regime story look convincing. The tight
clustering in the first two runs was itself coincidence, and three samples
spanning 04:02Z, 12:35Z and 13:37Z show no monotonic pattern.

**Quote ~6-9s for the non-instant tier.** Not 8.6s, not 5.9s, and not a function
of time of day.

`mode-slow` is the control that confirms the variance is real rather than a
measurement artifact: 12.65 / 13.09 / 12.32s, stable across all three samples,
because its 8-second handler delay dominates whatever jitter sits underneath.

The two-tier structure itself — payment-lifecycle events retry instantly at
~0.23s, `refund.created` and `payment.failed` do not — reproduced in every
sample and is not in doubt. Only the magnitude of the second tier was
mis-stated. None of this affects the gate outcome: every value is far under 60s.

## The three questions

### 1. Retry timing

- First retry delay: **0.2s** for `mode-500`/`mode-drop` on payment-lifecycle events; **6.8-8.6s** for `refund.created` and `payment.failed`; **5.8-8.6s** for `mode-400`; **11.0-14.4s** for `mode-slow`. See the Run 2 event-type table — the instant retry is not universal.
- Full observed schedule (deltas from original, `mode-500`): `0.2s, 6.1s, 19.1s, 39.5s, 82.3s, 164.5s, 326.1s, 650.5s, 1293.4s, 2576.5s, 5139.9s` — an immediate retry, then roughly-doubling exponential backoff.
- Total deliveries before Razorpay gave up: **not measured** — still retrying at the 92-minute mark, 12 deliveries in. Answering this needs a run spanning ~24h.
- Total span from original to last retry: **not measured**, same reason. Observed so far: **85.7 min** and continuing.
- Consistent across runs? **YES.** Run 2, a day later at a different time of day, reproduced every step to within a couple of percent. The schedule is deterministic.

### 2. Duplicate identity

- Retried body byte-identical to original (`raw_body_sha256`): **YES**, on every stream, all 141 deliveries.
- `X-Razorpay-Signature` unchanged: **YES**, and it verifies against the secret on all 141.
- `x-razorpay-event-id` unchanged: **YES** — the id is stable across every retry of an event.
- Headers that differ between original and retry: **none from Razorpay.** The only headers that change are host-edge noise (`x-railway-request-id`, `x-request-start`, `x-forwarded-for`, `x-real-ip`), which Railway regenerates per request.
- Any previously unknown Razorpay header (retry count / attempt number): **NO — and this is a finding.** The only Razorpay-origin headers present are `user-agent: Razorpay-Webhook/v1`, `x-razorpay-event-id`, and `x-razorpay-signature`. There is **no attempt counter, no retry flag, no delivery id**. A retry is indistinguishable from the original delivery by inspection of the request alone. The receiver's own memory of the `event_id` is the only way to tell them apart.

### 3. Failure trigger threshold

| Mode | Endpoint behaviour | Retried? | Notes |
|---|---|---|---|
| mode-500 | HTTP 500 | **YES** | 12 deliveries. Immediate retry at +0.2s, then exponential backoff. |
| mode-400 | HTTP 400 | **YES** | 11 deliveries. **Razorpay does not treat 4xx as terminal.** Identical backoff to mode-500 but without the +0.2s immediate retry — first retry at ~6s. |
| mode-slow | 200 after 8s | **YES** | 11 deliveries. Razorpay abandons the connection before our 8s response and retries — first retry at ~13.6s. A slow success is treated as a failure. |
| mode-drop | socket destroyed | **YES** | 12 deliveries. Timing is bit-for-bit the same as mode-500, which is expected: on Railway this arrives at Razorpay as an edge-synthesized **502**, not a connection reset. See the deployment caveat — this row measures "upstream 5xx", not "connection dropped". |
| mode-200 | HTTP 200 immediately | **NO** | Exactly 1 delivery per event, 3 total. **Control holds.** |

Only an immediate 2xx stops the retry machine. Every other behaviour tested —
server error, client error, slow success, dropped origin socket — produces retries
on the same backoff curve.

## Gate outcome (spec section 4)

**Stated explicitly:** First retry arrives **under 60s** — in fact under **one
second** (0.2s) for a 500 or a dropped socket. **The live retry demo is viable.**
Timeout/retry becomes the headline probe: Razorpay itself produces the duplicate,
fully real, nothing constructed.

- [x] First retry **under 60s** → live retry demo viable; timeout/retry becomes the headline probe.
- [ ] ~~First retry 60s-10min~~
- [ ] ~~First retry >10min or never~~
- [ ] ~~Retried body not byte-identical~~ — body IS byte-identical.
- [ ] ~~`x-razorpay-event-id` changes on retry~~ — id is stable.
- [ ] ~~`mode-200` control shows any retry~~ — control clean, 1 delivery per event.

Provisional on one run. Re-confirm in Runs 2 and 3 before building on it.

Consequence for the product design:

A demo can trigger a real payment, let the merchant's endpoint fail, and show the
genuine Razorpay retry landing **within a second** — live, with no waiting and
nothing faked. The duplicate is byte-identical and carries the same `event_id` and
the same valid signature, so idempotency-by-event-id is a sound premise for Test 1.

The strongest probe is not the 500 — it is **mode-slow**. An endpoint that returns
a correct `200` but takes 8 seconds still gets retried, because Razorpay gave up
before the response arrived. A merchant whose handler does its work synchronously
before responding will therefore be silently double-processing under load while
returning `200` on every attempt and seeing nothing wrong in their own logs. That
is a real, common, invisible bug, and this harness demonstrates it with real
traffic.

## Webhook deactivation after sustained failure (2026-08-29)

At **12:08 UTC on 2026-08-29** Razorpay disabled all four failing endpoints and
emailed `alerts@razorpay.com` notices for each:

| Endpoint | Deactivation timestamp (from the email) |
|---|---|
| `mode-500` | 2026-08-29 12:08:08 UTC |
| `mode-drop` | 2026-08-29 12:08:11 UTC |
| `mode-400` | 2026-08-29 12:08:45 UTC |
| `mode-slow` | 2026-08-29 12:08:46 UTC |

> "We have been experiencing webhook delivery failure for past 24 hours while trying
> to hit the test webhook url ... we have disabled your webhook as a precaution. You
> can re-enable the webhook again by visiting the Dashboard and going to the webhooks
> tab. Note that this is the final failed attempt and we will not be attempting any
> more retries at this url."

`mode-200` was not deactivated — it always responds 200, so its failure streak never
started. That is a clean control for this behaviour as well.

**This does not explain the ladder termination.** The obvious objection is that Run 1's
ladders stopped because the endpoints were disabled. They did not:

- Run 1's ladders stopped at `2026-08-28T12:49:33Z`.
- Deactivation happened at `2026-08-29T12:08Z` — **23.3 hours later**.
- Run 3 delivered normally to all four failing modes at `04:00Z` on 08-29, which is
  impossible if those endpoints had been disabled the previous day.

Run 1 terminated on its own schedule. Finding #8 stands.

**The stated "final attempt" is not final.** The email for `mode-drop` gives
12:08:11 UTC as the final failed attempt, but the probe logged a further delivery to
`mode-drop` at `12:22:48Z` — 14 minutes later — and to `mode-slow` at `12:24:08Z`.
Deactivation takes effect with a lag; the emailed timestamp is when the decision was
made, not when delivery stopped. Nothing arrived after 12:24:08Z.

**The exact triggering rule is not established.** One observation cannot separate the
candidate rules ("24h since last success", "24h since first failure in the current
streak", "24h since endpoint registration"). These endpoints arguably never had a
successful delivery at all — `mode-slow` answers 200 but only after 8s, which
Razorpay evidently does not count as success. Recording the fact and the timestamps;
not inferring the rule.

**Why this matters more than the retry cap.** Finding #8 says undelivered events are
abandoned after 22.8 hours. This says the endpoint is then *switched off*. A merchant
whose endpoint is down for a day does not simply lose that day's events and resume —
delivery stops permanently until a human notices an email and clicks re-enable in a
dashboard. The failure is silent, open-ended, and invisible to any monitoring that
watches the endpoint rather than the sender.

## Surprises

1. **HTTP 400 is retried.** The common assumption that 4xx means "don't bother
   retrying, the request is malformed" does not hold. Razorpay retries a 400 on the
   same exponential curve as a 500 — 11 attempts and counting. A merchant rejecting
   malformed webhooks with a 400 will receive that webhook another ten times.

2. **There is no retry counter in the request.** No attempt number, no retry flag,
   no per-delivery id — only `event_id`, signature, and `user-agent:
   Razorpay-Webhook/v1`. A receiver cannot tell attempt 1 from attempt 11 by looking
   at the request. Deduplication *must* be stateful on the receiver's side. This is
   a negative result, and it is the most product-relevant thing in this run.

3. **The first retry is nearly instantaneous.** 200 milliseconds after a 500. Far
   faster than "exponential backoff over 24 hours" suggests, and it is what makes
   the live demo possible. It is a genuine extra attempt, not a duplicate of the
   same TCP delivery — separate request, separate edge request-id.

4. **`mode-400` skips the instant retry.** 500 and dropped-socket both get the
   +0.2s immediate retry; 400 does not, starting at ~6s instead. So Razorpay *does*
   distinguish 4xx from 5xx — just not by giving up on it.

5. **One `event_id` fans out to all five webhook configs.** Razorpay assigns one id
   per event and delivers it to every subscribed endpoint. This broke the first
   version of `analyze.js`, which grouped by `event_id` alone and merged five
   independent endpoint streams into one bogus delta sequence. Grouping is now by
   `(mode, event_id)`. Worth knowing for any merchant running more than one webhook
   config: the same `event_id` legitimately arrives at several endpoints.

6. **`mode-drop` could not be measured as intended on this host.** Railway's edge
   converts a destroyed origin socket into a 502 before Razorpay sees it, which is
   why its timing is identical to `mode-500` to within 0.2s. Measuring a true
   connection reset needs a host that does not terminate TLS at an edge proxy.

7. **The instant 0.2s retry only happens for payment-lifecycle events.**
   `refund.created` and `payment.failed` skip it entirely and start at ~6s. Run 1
   never revealed this because it only produced payment events. Had we written the
   demo around "Razorpay retries in 200ms" as a universal claim, a refund-based
   demo would have sat there looking broken for six seconds. This is the clearest
   argument in the whole exercise for the spec's insistence on three runs — the
   sample, not the instrument, was the limitation.

   **Amended 2026-08-29 by Run 3.** The two-tier structure reproduced. The
   magnitude did not.

   | event_type | mode | Run 1 | Run 2 | Run 3 |
   |---|---|---|---|---|
   | payment.authorized | mode-500 | 0.23s | 0.23s | 0.24s |
   | payment.captured | mode-500 | 0.23s | 0.23s | 0.23s |
   | order.paid | mode-500 | 0.25s | 0.27s | 0.24s |
   | payment.authorized | mode-400 | 6.75s | 6.47s | 6.90s |
   | refund.created | mode-500 | — | 6.76s | 5.97s |
   | payment.failed | mode-500 | — | **8.60s** | **5.88s** |

   **RESOLVED 2026-08-29 by a fourth sample. It is variance, not time of day.**

   | mode | Run 2, 13:37Z | Run 3, 04:02Z | Run 4, 12:35Z |
   |---|---|---|---|
   | `mode-400` | 8.63s | 5.87s | 7.23s |
   | `mode-500` | 8.60s | 5.88s | 7.64s |
   | `mode-drop` | 8.39s | 6.00s | 8.86s |
   | `mode-slow` | 12.65s | 13.09s | 12.32s |

   An earlier draft argued that because each run's three modes clustered tightly
   (spread 0.24s in Run 2, 0.13s in Run 3), the 8.6s and 5.9s figures could not be
   noise and had to reflect a real per-run difference, with time of day the leading
   candidate. **Run 4 refutes that.** Its within-run spread is 1.63s — wider than
   the between-run gap that made the two-regime story look convincing. The tight
   clustering in the first two runs was itself coincidence, and three samples
   spanning 04:02Z, 12:35Z and 13:37Z show no monotonic pattern.

   **Quote ~6-9s for the non-instant tier.** Not 8.6s, not 5.9s, and not a function
   of time of day.

   `mode-slow` is the control that confirms the variance is real rather than a
   measurement artifact: 12.65 / 13.09 / 12.32s, stable across all three samples,
   because its 8-second handler delay dominates whatever jitter sits underneath.

   The two-tier structure itself — payment-lifecycle events retry instantly at
   ~0.23s, `refund.created` and `payment.failed` do not — reproduced in every
   sample and is not in doubt. Only the magnitude of the second tier was
   mis-stated. None of this affects the gate outcome: every value is far under 60s.

7b. **No time-of-day dependence in the main schedule.** Runs starting at 14:03Z,
   13:30Z, and 04:00Z produce identical first-retry delays for every
   payment-lifecycle event: 0.23s on mode-500/mode-drop, ~6-7s on mode-400. The
   morning slot in Run 3 was added specifically to test load/time dependence and
   found none. `mode-slow` varies 11.0-14.4s across all runs, which is the 8s
   handler delay compounding with normal scheduling variance, not a time effect.

8. **The backoff is deterministic.** Two runs a day apart, at different times of
   day, produced the same curve to within a couple of percent at every step.
   Whatever Razorpay is doing, it is not jittered and not visibly load-dependent.
   That makes the retry schedule safe to build a timed demo around.

   **Corrected 2026-08-29 00:45 IST.** This finding originally said "eleven
   steps" — that was an artifact of when the log was pulled, not a property of
   the ladder. Run 2's payment-lifecycle events kept climbing after the write-up:

   ```
   0.11, 0.34, 0.68, 1.40, 2.77, 5.48, 10.83, 21.53, 42.91, 85.64, 171.01, 341.72 m
   ```

   Fourteen doublings observed on Run 2 and still going; ratio holds at 2.00x.
   Run 2's 14th step landed at +683.07m against Run 1's +683.15m — the two runs
   agree to **five seconds after eleven and a half hours**, an 0.01% divergence.
   Whatever generates this schedule is not merely unjittered, it is clocked.

   Run 1, started a day earlier, is further along and shows the same curve
   extending to **fourteen** doublings (`payment.authorized` / mode-500, start
   2026-08-27T14:03:39Z):

   ```
   0.11, 0.32, 0.67, 1.38, 2.75, 5.45, 10.85, 21.58, 42.95, 85.68,
   171.13, 341.81, 683.15, 1365.89 m
   ```

   The 14th step is at **+1365.89m = 22.76h**, landed 2026-08-28T12:49:33Z. The
   ratio is 2.00x at every step from the 5th onward; the first two intervals
   (0.11m, 0.32m) run slightly wide of 2x and are the only deviation anywhere in
   the data.

   **RESOLVED 2026-08-29. The ladder terminates at fourteen doublings.**

   The predicted 15th step (+2731.8m = 45.5h = 2026-08-29T11:35Z) never arrived.
   All twelve Run 1 ladders stopped at the same wall-clock instant,
   `2026-08-28T12:49:33Z` = **+1365.9m = 22.76 hours**, and the missing step was
   45 minutes overdue on a schedule that had held to +/-5 seconds across fourteen
   consecutive doublings. That is a terminated ladder, not a late one.

   | | |
   |---|---|
   | Ladder length | **14 doublings**, first retry through +22.76h |
   | Max deliveries per event | **16** on `mode-500` / `mode-drop` — initial + 0.2s instant retry + 14 steps |
   | | **15** on `mode-400` / `mode-slow` — no instant retry |
   | Total retry span | **22.76 hours** |
   | Step 15 would have landed | +45.5h — outside the 24h window, never sent |

   **The stopping rule is the window, not the attempt count.** Razorpay's docs
   say retries happen "on an exponential backoff schedule over 24 hours" and
   never publish the schedule. The measured behaviour is that doubling continues
   until the *next* step would fall outside 24 hours, and then stops. 22.76h is
   simply where the fourteenth doubling lands before that cap — it is not a
   configured limit, it is an arithmetic consequence of doubling from 0.11m.

   Practical consequence: an endpoint down for a full day and recovering will
   receive **at most 16 deliveries** of a given event, and anything not delivered
   inside 22.8 hours is never delivered at all. A merchant that treats webhooks
   as guaranteed-eventually is wrong after that point and needs reconciliation
   by polling, not by waiting.

   Run 2 is one step behind and reached +1365.9m at 2026-08-29T12:17Z. Its
   step 15 would land at +45.5h = 2026-08-30T11:02Z, also outside the window, so
   it is predicted to terminate identically. Confirmable 2026-08-30.

   Per-mode row counts differ for structural reasons, not noise:

   | Mode | Rows at +341.7m | Composition |
   |---|---|---|
   | mode-500, mode-drop | 14 | initial + 0.2s instant retry + 12 ladder steps |
   | mode-400 | 13 | no instant retry (first at 5.8s) + 12 ladder steps |
   | mode-slow | 12 | ladder runs ~0.5% slower, 13th step not yet due |

   The ~0.5% dilation on `mode-slow` is consistent across every step and is
   explained by the 8s handler delay shifting each attempt's start.
