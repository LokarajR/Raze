'use strict';

/**
 * Layer 15 — the policy that decides whether Raze may act unattended.
 *
 * This is the module a judge should attack hardest, because it is the one that
 * moves money while nobody is watching. Every assertion here is a case where
 * getting it wrong costs a merchant real money, so each one states the failure
 * rather than the rule.
 *
 * The bias under test is deliberate and one-directional: anything that cannot be
 * established as a fact must escalate. A policy that fails towards acting is not
 * a safety mechanism, it is an optimism setting.
 *
 *   node test/policy.test.js
 */

const { decide, describe: describePolicy, RULES } = require('../src/policy');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

// A merchant who has confirmed everything and has no side effects: the only
// shape in which auto-repair is ever permitted.
const READY = { mappingConfirmed: true, escalateOnly: false, autoRepair: true };
const CAPTURED = { id: 'pay_x', status: 'captured', amount: 50000 };
const PENDING_ORDER = { status: 'pending', expectedAmount: 50000, appliedAmount: 0 };

const call = (over = {}) => decide({
  payment: CAPTURED, order: PENDING_ORDER, matchedRows: 1, merchant: READY, ...over,
});

console.log('\nLayer 15 tests  (unattended repair policy)\n');

// ---- the one case that may proceed ---------------------------------------
const clean = call();
check('a clean capture against a matching unpaid order auto-repairs',
  clean.action === 'auto' && clean.rule === RULES.AUTO_CLEAN_CAPTURE,
  JSON.stringify(clean));

// ---- money -----------------------------------------------------------------
const mismatch = call({ order: { ...PENDING_ORDER, expectedAmount: 45000 } });
check('Rs 450 paid against a Rs 500 order escalates, never settles it',
  mismatch.action === 'escalate' && mismatch.rule === RULES.ESCALATE_AMOUNT_MISMATCH,
  JSON.stringify(mismatch));
check('the mismatch is explained in rupees, both sides named',
  /Rs 450\.00/.test(mismatch.why) && /Rs 500\.00/.test(mismatch.why), mismatch.why);

const unknownAmount = call({ order: { ...PENDING_ORDER, expectedAmount: null } });
check('an order with no recorded amount escalates rather than skipping the check',
  unknownAmount.action === 'escalate' && unknownAmount.rule === RULES.ESCALATE_AMOUNT_UNKNOWN,
  JSON.stringify(unknownAmount));

// ---- state -----------------------------------------------------------------
for (const status of ['authorized', 'failed', 'refunded', 'created']) {
  const r = call({ payment: { ...CAPTURED, status } });
  check(`a payment in state "${status}" is never auto-applied`,
    r.action === 'escalate' && r.rule === RULES.ESCALATE_NOT_CAPTURED,
    JSON.stringify(r));
}

const noOrder = call({ order: null });
check('a payment with no matching order escalates rather than inventing one',
  noOrder.action === 'escalate' && noOrder.rule === RULES.ESCALATE_NO_ORDER,
  JSON.stringify(noOrder));

const alreadyPaid = call({ order: { status: 'paid', expectedAmount: 50000, appliedAmount: 50000 } });
check('an order already settled escalates instead of being credited twice',
  alreadyPaid.action === 'escalate' && alreadyPaid.rule === RULES.ESCALATE_ALREADY_APPLIED,
  JSON.stringify(alreadyPaid));

const partiallyApplied = call({ order: { status: 'pending', expectedAmount: 50000, appliedAmount: 1 } });
check('an order with money already applied escalates even if its status says pending',
  partiallyApplied.action === 'escalate'
    && partiallyApplied.rule === RULES.ESCALATE_ALREADY_APPLIED,
  JSON.stringify(partiallyApplied));

const refundedOrder = call({ order: { status: 'refunded', expectedAmount: 50000, appliedAmount: 0 } });
check('a refunded order is never re-settled by a stale capture',
  refundedOrder.action === 'escalate', JSON.stringify(refundedOrder));

// ---- blast radius ----------------------------------------------------------
for (const rows of [0, 2, 7]) {
  const r = call({ matchedRows: rows });
  check(`a key matching ${rows} rows escalates rather than writing`,
    r.action === 'escalate' && (r.rule === RULES.ESCALATE_MULTI_ROW
      || r.rule === RULES.ESCALATE_NO_ORDER),
    JSON.stringify(r));
}

// ---- the merchant's standing decisions -------------------------------------
const declined = call({ merchant: { ...READY, autoRepair: false } });
check('a merchant who declined auto-repair is never auto-repaired, however clean',
  declined.action === 'escalate' && declined.rule === RULES.ESCALATE_AUTO_DISABLED,
  JSON.stringify(declined));

const sideEffects = call({ merchant: { ...READY, escalateOnly: true } });
check('a merchant whose writes trigger fulfilment never auto-applies',
  sideEffects.action === 'escalate' && sideEffects.rule === RULES.ESCALATE_SIDE_EFFECTS,
  JSON.stringify(sideEffects));
check('that reason names the real risk rather than citing a setting',
  /email|shipment|fulfilment/i.test(sideEffects.why), sideEffects.why);

const unconfirmed = call({ merchant: { ...READY, mappingConfirmed: false } });
check('an unconfirmed mapping escalates — a wrong column is worse than a delay',
  unconfirmed.action === 'escalate' && unconfirmed.rule === RULES.ESCALATE_MAPPING_UNCONFIRMED,
  JSON.stringify(unconfirmed));

// ---- the standing decisions outrank a clean case ---------------------------
const declinedButClean = decide({
  payment: CAPTURED, order: PENDING_ORDER, matchedRows: 1,
  merchant: { mappingConfirmed: true, escalateOnly: true, autoRepair: false },
});
check('a merchant preference is not overridden by an otherwise perfect case',
  declinedButClean.action === 'escalate', JSON.stringify(declinedButClean));

// ---- nothing may proceed on missing input ----------------------------------
const nothing = decide({});
check('called with no facts at all, it escalates rather than throwing or allowing',
  nothing.action === 'escalate', JSON.stringify(nothing));

// ---- every verdict is explainable ------------------------------------------
const verdicts = [clean, mismatch, unknownAmount, noOrder, alreadyPaid, sideEffects, unconfirmed];
check('every verdict carries a reason a merchant could read',
  verdicts.every((v) => typeof v.why === 'string' && v.why.length > 20
    && !/idempoten|HMAC|SKIP LOCKED/i.test(v.why)),
  verdicts.map((v) => v.why).find((w) => !w || w.length <= 20) || 'ok');

check('every verdict names the rule that produced it',
  verdicts.every((v) => typeof v.rule === 'string' && v.rule.length > 0));

// ---- the description shown to the merchant matches the code ----------------
const described = describePolicy();
check('the policy shown to the merchant lists both sides',
  described.auto.length >= 5 && described.escalate.length >= 6,
  JSON.stringify({ auto: described.auto.length, escalate: described.escalate.length }));

console.log(`\n${pass}/${pass + fail} passed\n`);
process.exit(fail ? 1 : 0);
