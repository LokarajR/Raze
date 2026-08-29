# Raze — reconciliation gate results

Run 2026-08-29T13:33:48.201Z against Razorpay Test Mode.
Produced by `raze/gate/reconcile-gate.js`. This file is evidence, not scaffolding.

## Verdict

> **PASS** — reconcile on `order_id`. Build Layer 3 as specified.

## Window

```
from  2026-08-26T13:33:44.000Z
to    2026-08-29T13:33:44.000Z
```

Covers the whole measurement period, so every payment created through the Payment
Links flow during runs 1-4 falls inside it.

## Enumeration

| | |
|---|---|
| Maximum accepted `count` | **100** |
| Payments enumerated | **6** |
| Pages at `count=100` | 1 |
| Pages at `count=3` | 3 (sizes 3, 3, 0) |

Payment status distribution: `failed` 3, `refunded` 2, `captured` 1.

## Field presence

Asserted on every enumerated payment.

| Field | Result |
|---|---|
| `id` | present on all |
| `order_id` | present on all |
| `status` | present on all |
| `amount` | present on all |
| `created_at` | present on all |

`order_id` is present and non-null on every payment, which is the mapping key Layer 3 needs.


## Pagination integrity

The same window was enumerated twice — once at `count=100` (a single page)
and once at `count=3` to force `skip>0` — and the resulting id sets compared.

| Check | Result |
|---|---|
| Payments dropped across pages | 0 |
| Payments duplicated across pages | no |
| Unexpected ids in paged result | 0 |

Enumeration is complete and stable across page sizes. Combined with the overlapping windows Layer 3 uses, a payment captured at a window boundary cannot be missed.

## Known-payment check

Payments created earlier through the Payment Links flow during the measurement,
looked up in the enumerated set. This proves the enumeration surfaces real, known
payments rather than merely returning a non-empty list.

- `pay_TVRhBUzohX46of` — found

## What this means for the build

Layer 3 reconciliation is buildable as specified. The diff is keyed on `order_id`,
pagination follows `skip` in steps of 100, and the reconcile loop can trust
that a full window enumeration returns every payment exactly once.
