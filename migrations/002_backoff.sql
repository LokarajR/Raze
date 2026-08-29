-- Retry backoff for the inbox worker.
--
-- Without this a permanently failing row is retried as fast as the worker loops,
-- which burns CPU and floods last_error. Backoff is exponential on
-- process_attempts and capped, so a poison row costs one attempt per interval
-- rather than starving the queue.
ALTER TABLE raze_inbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

DROP INDEX IF EXISTS raze_inbox_unprocessed;
CREATE INDEX IF NOT EXISTS raze_inbox_ready
  ON raze_inbox (received_at)
  WHERE processed_at IS NULL;
