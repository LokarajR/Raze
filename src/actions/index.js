'use strict';

/**
 * What Raze did while nobody was watching.
 *
 * An agent that repairs unattended owes an account of itself. Not a log line —
 * a record a merchant can read months later and check: what it touched, what it
 * was worth, which rule allowed it, and what their own table said afterwards.
 *
 * THE FIELD THAT MATTERS IS `verified_state`
 *
 * Everything else describes an intention. That column records what was read back
 * out of the merchant's own table after the write, which is the only evidence
 * that the money actually landed. A repair is not finished when the insert
 * succeeds; the inbox accepting a row proves a row exists, not that the merchant
 * got paid.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raze_actions (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind           TEXT NOT NULL,          -- recovered | escalated | swept
  order_id       TEXT,
  payment_id     TEXT,
  amount_paise   BIGINT,
  rule           TEXT NOT NULL,          -- which policy rule matched
  why            TEXT NOT NULL,          -- in the merchant's words
  verified_state JSONB,                  -- read back from THEIR table, after
  acknowledged   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS raze_actions_at ON raze_actions (at DESC);
CREATE INDEX IF NOT EXISTS raze_actions_open
  ON raze_actions (acknowledged) WHERE kind = 'escalated';
`;

async function ensure(pool) {
  await pool.query(SCHEMA);
}

async function record(pool, { kind, orderId, paymentId, amountPaise, rule, why, verifiedState }) {
  await ensure(pool);
  const r = await pool.query(
    `INSERT INTO raze_actions (kind, order_id, payment_id, amount_paise, rule, why, verified_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, at`,
    [kind, orderId || null, paymentId || null, amountPaise || null, rule, why,
      verifiedState ? JSON.stringify(verifiedState) : null]
  );
  return r.rows[0];
}

/**
 * What has happened since a given moment — the console's opening screen.
 *
 * Recovered and waiting are counted separately because they mean opposite
 * things to a merchant: one is money they now have, the other is a decision
 * only they can make.
 */
async function since(pool, when) {
  await ensure(pool);
  const from = when || new Date(Date.now() - 24 * 3600 * 1000);

  const recovered = await pool.query(
    `SELECT order_id, payment_id, amount_paise, at, verified_state
       FROM raze_actions
      WHERE kind = 'recovered' AND at >= $1
      ORDER BY at DESC`, [from]);

  const waiting = await pool.query(
    `SELECT order_id, payment_id, amount_paise, rule, why, at
       FROM raze_actions
      WHERE kind = 'escalated' AND NOT acknowledged
      ORDER BY at DESC LIMIT 50`);

  const sum = (rows) => rows.reduce((a, r) => a + Number(r.amount_paise || 0), 0);
  return {
    since: from,
    recovered: {
      count: recovered.rowCount,
      paise: sum(recovered.rows),
      orders: recovered.rows.slice(0, 20),
    },
    waiting: {
      count: waiting.rowCount,
      paise: sum(waiting.rows),
      orders: waiting.rows.slice(0, 20),
    },
  };
}

/** An escalation the merchant has dealt with stops being a thing that needs them. */
async function acknowledge(pool, orderId) {
  await ensure(pool);
  const r = await pool.query(
    `UPDATE raze_actions SET acknowledged = true
      WHERE kind = 'escalated' AND NOT acknowledged AND order_id = $1`,
    [orderId]);
  return r.rowCount;
}

module.exports = { ensure, record, since, acknowledge, SCHEMA };
