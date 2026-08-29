'use strict';

/**
 * Pattern recognition tests.
 *
 * Two properties matter more than coverage here.
 *
 * It must not fire on correct code. A detector that flags a working integration
 * teaches its user to ignore it, which is worse than having no detector — the
 * same rule the audit's control case enforces.
 *
 * And it must repair only what it can repair unambiguously. Where the right edit
 * depends on a decision the merchant has to make, it says so instead of guessing;
 * a wrong automated edit to payment code is worse than no edit.
 *
 *   node test/layer8.test.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scan, repairAll, PATTERNS } = require('../src/patterns');

const RAZE = path.join(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`> FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

const ids = (hits) => hits.map((h) => h.pattern.id).sort();

function main() {
  console.log('\nLayer 8 tests  (known defect patterns)\n');

  // ---- the control: correct code must produce nothing -------------------
  const correct = fs.readFileSync(path.join(RAZE, 'examples', 'demo-merchant', 'server.js'), 'utf8');
  check('CONTROL: a correct integration matches no pattern',
    scan(correct).length === 0, ids(scan(correct)).join(', '));

  // Raze's own runtime is a webhook handler that does everything right.
  const runtime = fs.readFileSync(path.join(RAZE, 'src', 'runtime', 'index.js'), 'utf8');
  check('CONTROL: the runtime itself matches no pattern',
    scan(runtime).length === 0, ids(scan(runtime)).join(', '));

  // ---- the legacy handler, whose defects are known ----------------------
  const legacy = fs.readFileSync(path.join(RAZE, 'examples', 'merchant-legacy', 'server.js'), 'utf8');
  const legacyIds = ids(scan(legacy));
  check('the legacy handler is caught not verifying signatures',
    legacyIds.includes('no-signature-verification'), legacyIds.join(', '));
  check('the legacy handler is caught not deduplicating',
    legacyIds.includes('no-idempotency-on-event-id'), legacyIds.join(', '));

  // ---- re-serialised signature, the shape seen in real repositories -----
  const reserialised = `
    const crypto = require('crypto');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.post('/webhook', (req, res) => {
      const expected = crypto.createHmac('sha256', process.env.SECRET)
        .update(JSON.stringify(req.body)).digest('hex');
      if (expected !== req.headers['x-razorpay-signature']) return res.status(400).end();
      const e = req.body.payload.payment.entity;
      res.json({ ok: true, id: e.id });
    });
  `;
  const rHits = scan(reserialised);
  check('signature over re-serialised JSON is recognised',
    ids(rHits).includes('signature-over-reserialised-json'), ids(rHits).join(', '));

  const repaired = repairAll(reserialised);
  check('it is repaired by capturing and verifying the raw bytes',
    repaired.changed
      && /req\.rawBody/.test(repaired.source)
      && !/JSON\.stringify\(\s*req\.body\s*\)/.test(repaired.source)
      && /verify:/.test(repaired.source),
    JSON.stringify(repaired.applied.map((a) => a.id)));

  check('the repaired source still parses',
    (() => {
      const tmp = path.join(require('os').tmpdir(), `raze-pattern-${Date.now()}.js`);
      fs.writeFileSync(tmp, repaired.source);
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      fs.unlinkSync(tmp);
      return r.status === 0;
    })());

  check('re-scanning the repaired source no longer reports that pattern',
    !ids(scan(repaired.source)).includes('signature-over-reserialised-json'),
    ids(scan(repaired.source)).join(', '));

  // ---- removed mongoose API ---------------------------------------------
  const mongoose = `
    const paymentModel = require('./models/payment');
    async function h(req, res) {
      const doc = { flag: true };
      await paymentModel.update({ _id: req.body.id }, doc);
      res.json({ ok: true });
    }
  `;
  check('Model.update() is recognised as removed in Mongoose 7',
    ids(scan(mongoose)).includes('removed-mongoose-update'), ids(scan(mongoose)).join(', '));
  const mRepair = repairAll(mongoose);
  check('it is repaired to updateOne()',
    /paymentModel\.updateOne\(/.test(mRepair.source) && !/paymentModel\.update\(/.test(mRepair.source),
    mRepair.source.match(/paymentModel\.\w+\(/)?.[0]);

  // ---- what must NOT be automated ---------------------------------------
  const undecidable = PATTERNS.filter((p) => {
    const r = p.repair('nothing that matches anything');
    return r && r.error;
  });
  check('patterns needing a human decision refuse to repair rather than guess',
    undecidable.length >= 3,
    `${undecidable.length} of ${PATTERNS.length} decline`);

  // ---- a repair that cannot be made is reported, not silently skipped ---
  const legacyRepair = repairAll(legacy);
  check('unrepairable findings are reported with a reason',
    legacyRepair.skipped.length > 0 && legacyRepair.skipped.every((s) => !!s.reason),
    JSON.stringify(legacyRepair.skipped.map((s) => s.id)));

  // ---- detection is conservative ----------------------------------------
  const unrelated = `
    const express = require('express');
    const app = express();
    app.get('/health', (req, res) => res.json({ ok: true }));
    app.post('/order', async (req, res) => { await db.save(req.body); res.json({ ok: true }); });
  `;
  check('code that is not a webhook handler matches nothing',
    scan(unrelated).length === 0, ids(scan(unrelated)).join(', '));

  console.log(`\n${pass}/${pass + fail} passed\n`);
  process.exit(fail ? 1 : 0);
}

main();
