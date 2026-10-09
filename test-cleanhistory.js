/**
 * test-cleanhistory.js
 * ---------------------------------------------------------------------------
 * The cleanup DELETES price history, so it is tested against a fake Firestore
 * that records every write. What matters:
 *
 *   1. it removes the bad reading from the reported scenario,
 *   2. it does NOT remove a genuine price drop — a real drop is low too,
 *   3. it does not touch a product with too little history to judge,
 *   4. it refuses when it would remove most of a product's history,
 *   5. a DRY RUN writes nothing at all,
 *   6. applying writes the deletions and re-points lastPrice.
 *
 * No Firebase credentials and no network are needed.
 * ---------------------------------------------------------------------------
 */

const path = require('path');
const { findBadPoints, cleanHistory } = require('./lib/cleanHistory');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('  ✗ FAIL: ' + name);
  }
}

function pt(id, price, day) {
  return { id, price, checkedAt: new Date(2026, 9, day || 1).toISOString() };
}

// --- 1. the reported scenario -------------------------------------------------
// A ₹19,999 phone logged once at ₹10,490 (an exchange-offer figure) and then
// back to normal. That one reading must go.
{
  const readings = [
    pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 10490, 3),
    pt('d', 19999, 4), pt('e', 19999, 5),
  ];
  const v = findBadPoints(readings);
  check('the exchange-price reading is dropped', v.drop.length === 1 && v.drop[0] === 'c');
}

// --- 2. a genuine price drop survives ----------------------------------------
// A real drop stays down, so it is not an outlier — it must be kept.
{
  const readings = [
    pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 18999, 3),
    pt('d', 18999, 4), pt('e', 18999, 5),
  ];
  check('a real price drop is NOT removed', findBadPoints(readings).drop.length === 0);
}
{
  // A drop that holds, deep but lasting: every reading low, so nothing is an
  // outlier relative to the product's own median.
  const readings = [
    pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 12000, 3),
    pt('d', 12000, 4), pt('e', 12000, 5), pt('f', 12000, 6),
  ];
  check('a deep but lasting drop is NOT removed', findBadPoints(readings).drop.length === 0);
}

// --- 3. a run of consecutive bad readings ------------------------------------
{
  const readings = [
    pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 10490, 3),
    pt('d', 10490, 4), pt('e', 19999, 5), pt('f', 19999, 6),
  ];
  const v = findBadPoints(readings);
  check('a run of two bad readings is removed together',
    v.drop.length === 2 && v.drop.includes('c') && v.drop.includes('d'));
}

// --- 4. too little history to judge ------------------------------------------
{
  const readings = [pt('a', 19999, 1), pt('b', 10490, 2), pt('c', 19999, 3)];
  const v = findBadPoints(readings);
  check('a product with too few readings is left alone', v.drop.length === 0);
  check('...and says why', /too few readings/.test(String(v.reason)));
}

// --- 5. a low price that HOLDS is a real drop, not an artifact ---------------
{
  // Four consecutive low readings. A scrape artifact appears once or twice; a
  // price that stays down for four checks is a genuine drop and must survive.
  const readings = [
    pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 12000, 3),
    pt('d', 12000, 4), pt('e', 12000, 5), pt('f', 12000, 6),
  ];
  check('a low price that holds for several readings is kept',
    findBadPoints(readings).drop.length === 0);
}

// --- 6. refuse when most of the history would go ------------------------------
{
  // Scattered bad readings, more than half of the history — that is not an
  // outlier problem, so the product is refused rather than gutted.
  const readings = [
    pt('a', 19999, 1), pt('b', 5000, 2), pt('c', 19999, 3), pt('d', 5000, 4),
    pt('e', 19999, 5), pt('f', 5000, 6), pt('g', 19999, 7), pt('h', 5000, 8),
    pt('i', 5000, 9),
  ];
  const v = findBadPoints(readings);
  check('a mostly-bad history is refused, not gutted', v.drop.length === 0);
  check('...and says it refused', /refused/.test(String(v.reason)));
}

// --- 6. the fake Firestore ----------------------------------------------------
function fakeFirestore(products) {
  const writes = { deleted: [], updates: [] };
  const makeHistRef = (pid, hid) => ({ pid, hid });
  const makeProduct = (p) => {
    const histRefs = p.readings.map((r) => {
      const ref = makeHistRef(p.id, r.id);
      ref._data = r;
      return ref;
    });
    const histDocs = histRefs.map((ref) => ({ id: ref.hid, ref, data: () => ref._data }));
    const docRef = {
      set: async (update, o) => writes.updates.push({ id: p.id, update, opts: o }),
      collection: () => ({
        orderBy: () => ({ get: async () => ({ docs: histDocs }) }),
        get: async () => ({ docs: histDocs }),
      }),
    };
    return {
      id: p.id,
      ref: docRef,
      data: () => ({ title: p.title, lastPrice: p.lastPrice, productId: p.id }),
      exists: true,
    };
  };
  const docs = products.map(makeProduct);
  const db = {
    collection: () => ({
      doc: (id) => docs.find((d) => d.id === id) || { exists: false, id },
      limit: () => ({ get: async () => ({ docs }) }),
      get: async () => ({ docs }),
    }),
    batch: () => ({
      delete: (ref) => writes.deleted.push(ref),
      commit: async () => {},
    }),
  };
  return { fb: { db, admin: null, COLLECTIONS: { PRODUCTS: 'products', PRICE_HISTORY: 'price_history' } }, writes };
}

const fixture = [
  {
    id: 'p1',
    title: 'Infinix Note 50s 5G+ (Titanium Grey, 128 GB)',
    lastPrice: 10490,
    readings: [
      pt('h1', 19999, 1), pt('h2', 19999, 2), pt('h3', 10490, 3),
      pt('h4', 19999, 4), pt('h5', 19999, 5),
    ],
  },
  {
    id: 'p2',
    title: 'A phone with a real drop',
    lastPrice: 18999,
    readings: [
      pt('g1', 19999, 1), pt('g2', 19999, 2), pt('g3', 18999, 3),
      pt('g4', 18999, 4), pt('g5', 18999, 5),
    ],
  },
];

// --- 7. a dry run writes nothing ---------------------------------------------
{
  const { fb, writes } = fakeFirestore(fixture);
  return (async () => {
    const report = await cleanHistory({ apply: false, fb });
    check('the dry run finds the bad product', report.affected === 1);
    check('the dry run counts the reading it would remove', report.removed === 1);
    check('the dry run reports it without applying', report.products[0].status === 'would clean');
    check('the dry run DELETES nothing', writes.deleted.length === 0);
    check('the dry run writes nothing to any product', writes.updates.length === 0);
    check('the dry run leaves the clean product alone', report.untouched === 1);

    // --- 8. applying deletes the reading and re-points lastPrice --------------
    const applied = fakeFirestore(fixture);
    const report2 = await cleanHistory({ apply: true, fb: applied.fb });
    check('applying removes exactly one reading', applied.writes.deleted.length === 1);
    check('applying removes the RIGHT reading', applied.writes.deleted[0].hid === 'h3');
    check('applying re-points lastPrice at the newest good reading',
      applied.writes.updates.length === 1 &&
        applied.writes.updates[0].id === 'p1' &&
        applied.writes.updates[0].update.lastPrice === 19999);
    check('applying does not touch the clean product',
      applied.writes.updates.every((u) => u.id !== 'p2'));
    check('the applied report says cleaned', report2.products[0].status === 'cleaned');
    check('the applied report counts what it removed', report2.removed === 1);

    // --- 9. the surfaces that expose it --------------------------------------
    const fs = require('fs');
    check('the endpoint exists', fs.existsSync(path.join(__dirname, 'api/clean-history.js')));
    check('the CLI exists', fs.existsSync(path.join(__dirname, 'scripts/clean-history.js')));
    const ep = fs.readFileSync(path.join(__dirname, 'api/clean-history.js'), 'utf8');
    check('the endpoint is gated by CRON_SECRET', ep.includes('CRON_SECRET'));
    check('the endpoint is a dry run unless apply is set',
      ep.includes("q.apply === '1'") && ep.includes('apply'));
    const tg = fs.readFileSync(path.join(__dirname, 'api/telegram.js'), 'utf8');
    check('there is a Telegram admin command for it', /cleanhistory/.test(tg));
    check('the Telegram command checks the admin', /cleanhistory[\s\S]{0,400}resolveAdminId/.test(tg));

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })();
}
