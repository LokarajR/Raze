-- Terminal state for events that cannot be processed.
--
-- Retrying forever with backoff looks alive and is stuck. An event that has
-- failed repeatedly is not going to succeed on attempt two hundred, and leaving
-- it in the queue hides it: the inbox shows work pending, nothing shows that the
-- work is impossible.
--
-- After max_attempts an event stops being retried and is marked for attention.
-- Nothing is deleted and nothing is marked processed — the raw bytes stay, so it
-- can be replayed by hand once the cause is fixed.
ALTER TABLE raze_inbox ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE raze_inbox ADD COLUMN IF NOT EXISTS attention_since TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS raze_inbox_attention
  ON raze_inbox (attention_since) WHERE needs_attention;

-- Reconciliation liveness.
--
-- "No drift found" and "never ran" are different facts that looked identical.
-- A window that was never covered is not a clean window, and a daemon that died
-- quietly should be visible as a gap rather than as silence.
CREATE TABLE IF NOT EXISTS raze_reconcile_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  covered_through TIMESTAMPTZ,
  CONSTRAINT raze_reconcile_state_single_row CHECK (id = 1)
);

INSERT INTO raze_reconcile_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
