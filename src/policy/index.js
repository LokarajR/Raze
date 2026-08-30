'use strict';

/**
 * Whether Raze may repair this on its own.
 *
 * This is the module that makes unattended operation defensible, and it is
 * deliberately the dullest code in the project: no model, no inference, no
 * network. Facts in, verdict out, same answer every time. A judgement about
 * moving a merchant's money should be readable in full by the person whose money
 * it is.
 *
 * THE ASYMMETRY THAT SHAPES EVERY RULE
 *
 * Escalating something repairable costs a merchant a few minutes. Auto-applying
 * something that should have been escalated can double-credit an account, fire a
 * fulfilment hook twice, or write money against the wrong order. So every rule is
 * written to fail towards escalation, and anything this module cannot establish
 * as a fact is treated as a reason to stop rather than a detail to assume.
 *
 * That includes its own ignorance. If the merchant's schema has no column that
 * states what an order was supposed to cost, the amount cannot be checked — and
 * an unverifiable amount escalates, rather than quietly skipping the check that
 * exists to catch the worst case.
 */

/** Every reason this module can give, so callers can branch on a value. */
const RULES = {
  AUTO_CLEAN_CAPTURE: 'clean-capture',
  ESCALATE_NOT_CAPTURED: 'payment-not-captured',
  ESCALATE_NO_ORDER: 'no-matching-order',
  ESCALATE_ALREADY_APPLIED: 'order-already-paid',
  ESCALATE_AMOUNT_MISMATCH: 'amount-mismatch',
  ESCALATE_AMOUNT_UNKNOWN: 'amount-not-verifiable',
  ESCALATE_MULTI_ROW: 'would-touch-multiple-rows',
  ESCALATE_MAPPING_UNCONFIRMED: 'mapping-not-confirmed',
  ESCALATE_SIDE_EFFECTS: 'merchant-has-side-effects',
  ESCALATE_AUTO_DISABLED: 'auto-repair-declined',
};

/**
 * @param {object} facts
 * @param {object} facts.payment    Razorpay's record: { id, status, amount }
 * @param {object|null} facts.order The merchant's row, or null if there is none:
 *                                  { status, expectedAmount, appliedAmount }
 *                                  expectedAmount is null when their schema does
 *                                  not record what the order should cost.
 * @param {number} facts.matchedRows How many rows the key matched. Anything but
 *                                   one is a reason to stop.
 * @param {object} facts.merchant   { mappingConfirmed, escalateOnly, autoRepair }
 * @returns {{ action: 'auto'|'escalate', rule: string, why: string }}
 */
function decide({ payment, order, matchedRows, merchant }) {
  const m = merchant || {};

  // ---- the merchant's own standing decisions come first -------------------
  // Someone who has said "always ask me" is not overridden by a clean case.
  if (m.autoRepair === false) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_AUTO_DISABLED,
      why: 'You asked to approve every repair yourself.',
    };
  }
  if (m.escalateOnly) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_SIDE_EFFECTS,
      why: 'Marking this order paid may trigger something else in your application — '
        + 'an email, a shipment, a fulfilment hook. Repairing it unattended could fire '
        + 'that a second time, so it waits for you.',
    };
  }
  if (!m.mappingConfirmed) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_MAPPING_UNCONFIRMED,
      why: 'The mapping between your orders and Razorpay payments has not been confirmed, '
        + 'so a repair could write the wrong column.',
    };
  }

  // ---- the provider's side -----------------------------------------------
  if (!payment || payment.status !== 'captured') {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_NOT_CAPTURED,
      why: `Razorpay reports this payment as ${payment ? payment.status : 'unknown'}, not `
        + 'captured. Only a captured payment is money that actually moved.',
    };
  }

  // ---- the merchant's side ------------------------------------------------
  if (!order) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_NO_ORDER,
      why: 'Razorpay has this payment but there is no matching order in your database. '
        + 'Creating one would be inventing a record, not repairing one.',
    };
  }
  if (matchedRows !== 1) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_MULTI_ROW,
      why: `This payment matches ${matchedRows} rows in your orders table. A repair that `
        + 'touches more than one row is not a repair.',
    };
  }
  if (Number(order.appliedAmount) > 0 || /paid|refunded/i.test(String(order.status || ''))) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_ALREADY_APPLIED,
      why: 'Your order is already marked as settled, so there is nothing to recover — '
        + 'and applying again would credit it twice.',
    };
  }

  // ---- the amount ---------------------------------------------------------
  // The single most valuable check here, and the one most tempting to skip when
  // a schema makes it awkward. Skipping it is how a Rs 450 payment silently
  // settles a Rs 500 order.
  if (order.expectedAmount === null || order.expectedAmount === undefined) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_AMOUNT_UNKNOWN,
      why: 'Your orders table does not record what this order was supposed to cost, so I '
        + 'cannot check that the payment matches it. I will not settle an order against '
        + 'an amount I cannot verify.',
    };
  }
  if (Number(order.expectedAmount) !== Number(payment.amount)) {
    return {
      action: 'escalate',
      rule: RULES.ESCALATE_AMOUNT_MISMATCH,
      why: `Razorpay says ${fmt(payment.amount)}, your order says `
        + `${fmt(order.expectedAmount)}. Those have to agree before I touch it.`,
    };
  }

  return {
    action: 'auto',
    rule: RULES.AUTO_CLEAN_CAPTURE,
    why: `Razorpay captured ${fmt(payment.amount)} for this order, your order is still `
      + 'unpaid for exactly that amount, and it matches one row. Nothing here needs a '
      + 'decision.',
  };
}

const fmt = (paise) => 'Rs ' + (Number(paise) / 100).toFixed(2);

/**
 * The policy in the merchant's own words, for the screen where they approve it.
 *
 * Kept beside the rules on purpose. A policy described in one place and
 * implemented in another drifts, and the merchant's copy is the one that would
 * be wrong.
 */
function describe() {
  return {
    auto: [
      'Razorpay says the payment was captured',
      'the amount matches your order exactly',
      'your order is still unpaid',
      'it matches exactly one order',
      'you have confirmed how your orders map to payments',
    ],
    escalate: [
      'the amount does not match',
      'there is no matching order',
      'your order is already settled',
      'the payment is anything other than captured',
      'the repair would touch more than one row',
      'your order table records no expected amount to check against',
      'marking an order paid triggers something else in your application',
    ],
    note: 'Anything Raze cannot establish as a fact waits for you. Escalating something '
      + 'repairable costs you a few minutes; repairing something that should have waited '
      + 'can credit an account twice.',
  };
}

module.exports = { decide, describe, RULES };
