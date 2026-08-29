-- What Raze notices while it runs.
--
-- The retry ladder was learned by recording every delivery and computing over
-- it. The same method applies in production: record what actually happens for
-- this merchant, this account, this traffic — then compute, rather than assume.
--
-- Every row here is an observation, never a conclusion. Conclusions are derived
-- on demand in src/learn, with the sample count attached, so a recommendation
-- based on four events can never be mistaken for one based on four thousand.

CREATE TABLE IF NOT EXISTS raze_observations (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,        -- 'delivery' | 'handler' | 'fulfilment'
  event_type  TEXT,
  event_id    TEXT,
  subject_id  TEXT,
  -- delivery: milliseconds since the first delivery of this event id
  -- handler:  milliseconds the handler or mapping took
  -- fulfilment: milliseconds from expectation created to resolved
  value_ms    BIGINT,
  attempt     INT,
  ok          BOOLEAN,
  detail      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raze_observations_kind ON raze_observations (kind, event_type, at DESC);
CREATE INDEX IF NOT EXISTS raze_observations_event ON raze_observations (event_id) WHERE kind = 'delivery';
