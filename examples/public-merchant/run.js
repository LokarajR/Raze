'use strict';

/**
 * Runs a real, independently written, public Razorpay integration.
 *
 * The point of this file is that it contains no merchant logic of its own. It
 * clones a public repository at run time, starts a real MongoDB, wires that
 * project's own model and controller together, and serves its webhook route
 * unmodified. Every business decision in the request path is the original
 * author's code.
 *
 * WHY THE CODE IS NOT VENDORED
 * The target repositories carry no LICENSE file, which under default copyright
 * means all rights reserved. Copying them into this repository would not be
 * ours to do. They are fetched into .public-merchants/ (gitignored) the same way
 * a test fixture is downloaded, and nothing from them is committed here.
 *
 * WHAT THIS DEMONSTRATES
 * The probes replay real captured Razorpay deliveries — including a genuine
 * 16-attempt retry ladder measured over 22.76 hours — at code that was never
 * written with Raze in mind, and read the resulting state from that project's
 * own MongoDB. Whatever it does wrong, it does on its own.
 *
 *   node examples/public-merchant/run.js --serve
 *   node examples/public-merchant/run.js --serve --protected
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const mongoose = require('mongoose');
const { resolveDemoSecret } = require('../../src/secret');

// One secret shared by this example's sender and its runtime, so signature
// verification runs on a machine with no Razorpay account configured.
const DEMO = resolveDemoSecret(process.env);
// Their handler reads the secret from the environment, exactly as it would in
// production. Without one it dies inside crypto and the report would blame
// their code for our missing configuration, so give it the same demo secret
// everything else here uses.
if (!process.env.RAZORPAY_WEBHOOK_SECRET) process.env.RAZORPAY_WEBHOOK_SECRET = DEMO.secret;

const RAZE = path.join(__dirname, '..', '..');
const CACHE = path.join(RAZE, '.public-merchants');

/**
 * The integrations this harness knows how to mount.
 *
 * `webhookPath` is the route the original project serves; `mount` wires the
 * project's own controller to it. Nothing here reimplements their logic.
 */
const TARGETS = {
  'pavankumaroff': {
    repo: 'https://github.com/pavankumaroff/razorpay-webhook.git',
    label: 'pavankumaroff/razorpay-webhook',
    root: 'backend',
    // Their verify() reads req.body as a parsed object and re-serialises it to
    // check the signature, so the route has to give it a parsed body — exactly
    // as their own server does.
    mount(app, root) {
      const controller = require(path.join(root, 'controllers', 'paymentController'));
      app.post('/webhook', express.json({
        verify: (req, res, buf) => { req.rawBody = buf; },
      }), (req, res) => controller.verify(req, res));
    },
    /** Read business state from the project's own collection. */
    async state(orderId) {
      const col = mongoose.connection.collection('payments');
      const docs = await col.find({ order_id: orderId }).toArray();
      const paise = docs.reduce((n, d) => n + Math.round((d.amount || 0) * 100), 0);
      return {
        status: docs.length ? (docs[0].status || 'recorded') : null,
        credited_paise: paise,
        credit_count: docs.length,
      };
    },
    async reset() {
      await mongoose.connection.collection('payments').deleteMany({});
    },
  },
};

function ensureCloned(target) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dir = path.join(CACHE, target.label.split('/').join('-'));
  if (!fs.existsSync(dir)) {
    console.error(`cloning ${target.repo} ...`);
    const res = spawnSync('git', ['clone', '-q', '--depth', '1', target.repo, dir], {
      encoding: 'utf8', timeout: 180000,
    });
    if (res.status !== 0) {
      throw new Error(`could not clone ${target.repo}: ${(res.stderr || '').slice(0, 200)}`);
    }
  }
  return path.join(dir, target.root || '');
}

/**
 * Their controller requires the razorpay SDK and mongoose models. Both are
 * resolved from THIS package's node_modules, which is the only accommodation
 * made — it avoids running npm install inside a cloned repository.
 */
function prepareModuleResolution(projectRoot) {
  const Module = require('module');
  const original = Module._nodeModulePaths;
  Module._nodeModulePaths = function (from) {
    return original.call(this, from).concat(path.join(RAZE, 'node_modules'));
  };
  return projectRoot;
}

async function startMongo() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('razorpay_demo'));
  return mongod;
}

async function main() {
  const which = process.argv.find((a) => TARGETS[a]) || 'pavankumaroff';
  const target = TARGETS[which];
  const useRaze = process.argv.includes('--protected');
  const port = Number(process.env.PORT || 4300);

  const projectRoot = prepareModuleResolution(ensureCloned(target));
  const mongod = await startMongo();

  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true, target: target.label, protected: useRaze }));

  if (useRaze) {
    // The Raze runtime in front of the same untouched controller. The merchant
    // code is not edited; deliveries simply do not reach it twice, unverified,
    // or out of order.
    const raze = require(path.join(RAZE, 'src', 'runtime'));
    const { connect, migrate } = require(path.join(RAZE, 'src', 'db'));
    const { pool } = await connect();
    await migrate(pool);

    const controller = require(path.join(projectRoot, 'controllers', 'paymentController'));
    const rz = raze.create({ db: pool, webhookSecret: DEMO.secret });

    for (const type of ['payment.authorized', 'payment.captured', 'order.paid', 'refund.created', 'payment.failed']) {
      rz.on(type, async (event) => {
        // Hand their controller exactly the shape it expects. Raze has already
        // guaranteed this is the first time this event id has been applied.
        await new Promise((resolve, reject) => {
          const req = { body: event, header: () => undefined, headers: {} };
          const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json() { resolve(); return this; },
            send() { resolve(); return this; },
          };
          Promise.resolve(controller.verify(req, res)).catch(reject);
          setTimeout(resolve, 3000);
        });
      });
    }
    rz.startWorker({ intervalMs: 150 });
    app.use('/webhook', express.raw({ type: () => true }), rz.middleware());
  } else {
    target.mount(app, projectRoot);
  }

  app.listen(port, () => {
    console.log(`public merchant: ${target.label}  ${useRaze ? '(behind Raze)' : '(as published)'}  :${port}`);
  });

  process.on('SIGTERM', async () => { await mongoose.disconnect(); await mongod.stop(); process.exit(0); });
  process.on('SIGINT', async () => { await mongoose.disconnect(); await mongod.stop(); process.exit(0); });
}

module.exports = { TARGETS, ensureCloned, prepareModuleResolution, startMongo, CACHE };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
