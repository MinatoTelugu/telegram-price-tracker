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

// --- 5. the reported case, at ANY run length ---------------------------------
// The bad scrape repeats the SAME wrong figure on every check, so the bad run is
// long. Judging by run length alone kept exactly the data being cleaned — which
// is why the page still showed ₹10,490.
{
  // A realistic history: a day of normal readings either side of the bad run,
  // so the run is a small share of the history (as it is on the real product).
  for (const n of [1, 2, 3, 4, 6, 10]) {
    const readings = [];
    for (let i = 0; i < 20; i++) readings.push(pt('a' + i, 19999, i + 1));
    for (let i = 0; i < n; i++) readings.push(pt('bad' + i, 10490, 21 + i));
    for (let i = 0; i < 20; i++) readings.push(pt('z' + i, 19999, 40 + i));
    const v = findBadPoints(readings);
    check('a bad run of ' + n + ' readings is removed', v.drop.length === n);
  }
}

// --- 6. a real drop is still safe --------------------------------------------
{
  // A 30%-off deal that ends: ₹13,999 -> ₹19,999 is only 1.43x, not the huge
  // snap-back a misread shows, so the deal is kept.
  const readings = [pt('a', 19999, 1), pt('b', 19999, 2)];
  for (let i = 0; i < 4; i++) readings.push(pt('d' + i, 13999, 3 + i));
  readings.push(pt('y', 19999, 40), pt('z', 19999, 41));
  check('a deal that ends and rises a little is NOT removed',
    findBadPoints(readings).drop.length === 0);
}
{
  // A low price holding for a very long time is a real drop, whatever the ratio.
  const readings = [pt('a', 19999, 1), pt('b', 19999, 2)];
  for (let i = 0; i < 20; i++) readings.push(pt('d' + i, 11000, 3 + i));
  readings.push(pt('y', 19999, 40), pt('z', 19999, 41));
  const v = findBadPoints(readings);
  check('a low price holding for many hours is kept', v.drop.length === 0);
  check('...and it is REPORTED as kept, not silently ignored',
    Array.isArray(v.kept) && v.kept.length === 20);
  check('...with a reason that mentions it was kept', /kept/.test(String(v.reason)));
}
{
  // A drop still live at the end — no recovery at all — is real.
  const readings = [pt('a', 19999, 1), pt('b', 19999, 2)];
  for (let i = 0; i < 6; i++) readings.push(pt('d' + i, 14999, 3 + i));
  check('a drop still live at the end is kept', findBadPoints(readings).drop.length === 0);
}

// --- 7. the explicit override needs no heuristics -----------------------------
{
  const readings = [pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 10490, 3), pt('d', 10490, 4), pt('e', 19999, 5)];
  const v = findBadPoints(readings, { maxPrice: 12000 });
  check('maxPrice removes every reading at or below it', v.drop.length === 2);
  check('maxPrice is marked explicit', v.explicit === true);
  const none = findBadPoints(readings, { maxPrice: 5000 });
  check('maxPrice below everything removes nothing', none.drop.length === 0);
}

// --- 8. refuse when most of the history would go ------------------------------
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

// --- 9. the fake Firestore ----------------------------------------------------
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

// --- 10. a dry run writes nothing --------------------------------------------
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

    // --- 11. the surfaces that expose it -------------------------------------
    const fs = require('fs');
    check('the endpoint exists', fs.existsSync(path.join(__dirname, 'api/clean-history.js')));
    check('the CLI exists', fs.existsSync(path.join(__dirname, 'scripts/clean-history.js')));
    const ep = fs.readFileSync(path.join(__dirname, 'api/clean-history.js'), 'utf8');
    check('the endpoint is gated by CRON_SECRET', ep.includes('CRON_SECRET'));
    check('the endpoint is a dry run unless apply is set',
      ep.includes("q.apply === '1'") && ep.includes('apply'));
    check('the endpoint accepts an explicit max price', ep.includes('q.max'));
    const cli = fs.readFileSync(path.join(__dirname, 'scripts/clean-history.js'), 'utf8');
    check('the CLI accepts an explicit max price', cli.includes("argValue('max')"));
    const tg = fs.readFileSync(path.join(__dirname, 'api/telegram.js'), 'utf8');
    check('there is a Telegram admin command for it', /cleanhistory/.test(tg));
    check('the Telegram command checks the admin', /cleanhistory[\s\S]{0,400}resolveAdminId/.test(tg));

    // --- a reading ABOVE the MRP is not a price ---------------------------------
// The reported page showed Highest ₹53,999 for a phone whose MRP is ₹40,999.
// The high side is judged against the MRP, because a median cannot separate
// "the price legitimately fell" from "junk appeared": with a majority-low history
// the median sits low and the honest readings become the outliers. Readings above
// the MRP are also excluded from the floor's reference — one such reading would
// otherwise drag it up and make the honest readings the candidates.
{
  // Build real reading objects — a bare number has no .price and is filtered out.
  const hi = [];
  for (let i = 0; i < 20; i++) hi.push(pt('hi' + i, 28998, i + 1));
  const withJunk = [...hi, pt('junk', 53999, 30), ...hi];
  const v = findBadPoints(withJunk, { mrp: 40999 });
  check('a reading above the MRP is removed', v.drop.length === 1 && v.drop[0] === 'junk');

  const twoJunk = [...hi, pt('j1', 53999, 30), pt('j2', 53999, 31), ...hi];
  check('a run of them is removed together', findBadPoints(twoJunk, { mrp: 40999 }).drop.length === 2);

  // A real 7% rise must survive — it is below the MRP and it persists.
  const risen = [...hi];
  for (let i = 0; i < 20; i++) risen.push(pt('r' + i, 30998, 30 + i));
  check('a real rise is kept', findBadPoints(risen, { mrp: 40999 }).drop.length === 0);

  // The real drop from the same page must survive too.
  const dropped = [...hi];
  for (let i = 0; i < 4; i++) dropped.push(pt('dr' + i, 26998, 30 + i));
  dropped.push(...hi);
  check('the real drop to ₹26,998 is kept', findBadPoints(dropped, { mrp: 40999 }).drop.length === 0);

  // Without an MRP there is no principled ceiling, so a high reading is KEPT.
  // That is deliberate: keeping one wrong reading is far cheaper than deleting
  // honest ones.
  check('with no MRP a high reading is left alone',
    findBadPoints(withJunk, {}).drop.length === 0);

  // The cases that must not regress.
  check('a deep but lasting drop is still kept',
    findBadPoints([pt('a', 19999, 1), pt('b', 19999, 2), pt('c', 12000, 3),
      pt('d', 12000, 4), pt('e', 12000, 5), pt('f', 12000, 6)], {}).drop.length === 0);
  const held = [pt('a', 19999, 1), pt('b', 19999, 2)];
  for (let i = 0; i < 20; i++) held.push(pt('h' + i, 11000, 3 + i));
  held.push(pt('y', 19999, 40), pt('z', 19999, 41));
  check('a low price holding for many hours is still kept',
    findBadPoints(held, {}).drop.length === 0);
  const misread = [];
  for (let i = 0; i < 20; i++) misread.push(pt('a' + i, 19999, i + 1));
  for (let i = 0; i < 4; i++) misread.push(pt('bad' + i, 10490, 21 + i));
  for (let i = 0; i < 20; i++) misread.push(pt('z' + i, 19999, 40 + i));
  check('the reported exchange misread is still removed',
    findBadPoints(misread, {}).drop.length === 4);

  // cleanHistory must hand the MRP to the check.
  const lib = fs.readFileSync(__dirname + '/lib/cleanHistory.js', 'utf8');
  check('cleanHistory passes the product MRP to the check', /mrp: typeof d\.mrp === 'number'/.test(lib));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })();
}
