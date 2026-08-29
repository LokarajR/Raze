-- Raze — initial schema.
--
-- Raze never writes to the merchant's own tables. It owns these four and hands
-- the merchant's handler a transaction; the handler writes its own state inside
-- that same transaction. That shared boundary is what makes the business-state
-- transition exactly-once within Raze's transactional boundary.

-- Durable inbox. event_id is the dedupe key.
CREATE TABLE IF NOT EXISTS raze_inbox (
  event_id         TEXT PRIMARY KEY,          -- x-razorpay-event-id
  event_type       TEXT NOT NULL,             -- payment.captured, etc
  raw_body         BYTEA NOT NULL,            -- exact bytes as received
  raw_body_sha256  TEXT NOT NULL,
  signature        TEXT,                      -- null for reconcile-sourced rows
  headers          JSONB NOT NULL,            -- all headers, verbatim
  subject_id       TEXT,                      -- order_id / refund_id, for ordering
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,               -- NULL until handler commits
  process_attempts INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  resolution       TEXT,                      -- 'applied' | 'ignored_stale' | 'no_handler'
  source           TEXT NOT NULL              -- 'webhook' | 'reconcile' | 'replay'
);

CREATE INDEX IF NOT EXISTS raze_inbox_unprocessed
  ON raze_inbox (received_at) WHERE processed_at IS NULL;

-- Highest state-machine rank reached per subject, for ordering decisions.
CREATE TABLE IF NOT EXISTS raze_subject_state (
  subject_id  TEXT PRIMARY KEY,
  rank        INT NOT NULL,
  event_type  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What we expect to happen, and by when.
CREATE TABLE IF NOT EXISTS raze_expectations (
  id                BIGSERIAL PRIMARY KEY,
  subject_type      TEXT NOT NULL,            -- 'order' | 'refund' | 'payment'
  subject_id        TEXT NOT NULL,            -- order_id, refund_id
  expected_event    TEXT NOT NULL,            -- payment.captured
  deadline          TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolution        TEXT,                     -- 'fulfilled' | 'recovered'
                                              -- | 'failed' | 'abandoned'
  resolution_detail JSONB
);

CREATE INDEX IF NOT EXISTS raze_expectations_due
  ON raze_expectations (deadline) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS raze_expectations_open_unique
  ON raze_expectations (subject_type, subject_id, expected_event)
  WHERE resolved_at IS NULL;

-- Outbox for side effects outside the transactional boundary.
-- At-least-once with idempotent delivery. NOT exactly-once execution.
CREATE TABLE IF NOT EXISTS raze_outbox (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  effect_type     TEXT NOT NULL,              -- 'email' | 'shipping' | ...
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS raze_outbox_pending
  ON raze_outbox (created_at) WHERE delivered_at IS NULL;

-- Audit trail of reconciliation runs. A run that did not happen is not the same
-- as a run that found nothing, so every attempt is recorded.
CREATE TABLE IF NOT EXISTS raze_reconcile_runs (
  id             BIGSERIAL PRIMARY KEY,
  window_from    TIMESTAMPTZ NOT NULL,
  window_to      TIMESTAMPTZ NOT NULL,
  razorpay_count INT NOT NULL,
  local_count    INT NOT NULL,
  drift_found    INT NOT NULL,
  drift_repaired INT NOT NULL,
  ok             BOOLEAN NOT NULL DEFAULT true,
  error          TEXT,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail         JSONB
);
