-- Backoff for outbox delivery.
--
-- The outbox table existed with an attempts counter and nothing that used it, so
-- a failing effect would have been retried as fast as the drainer looped. An
-- email provider returning 500 deserves a pause, not a flood.
ALTER TABLE raze_outbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE raze_outbox ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS raze_outbox_ready
  ON raze_outbox (created_at)
  WHERE delivered_at IS NULL;
