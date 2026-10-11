/**
 * The self-correction pass: what it removes, and — more importantly — what it
 * refuses to remove.
 *
 * Run: node test-selfclean.js
 */
const { findSelfCleanPoints } = require('./lib/selfClean');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/** Build a history from a list of prices, one reading per hour. */
let seq = 0;
function hist(prices) {
  seq++;
  const base = 1700000000000 + seq * 100000000;
  return prices.map((price, i) => ({
    id: 'p' + i,
    price,
    checkedAt: new Date(base + i * 3600000).toISOString(),
  }));
}
function droppedPrices(prices, opts) {
  const points = hist(prices);
  const v = findSelfCleanPoints(points, opts);
  const ids = new Set(v.drop);
  return points.filter((p) => ids.has(p.id)).map((p) => p.price);
}

console.log('--- impossible readings go, whatever else the history says ---');

// A phone with an MRP of ₹23,999. ₹53,999 is above it; ₹6,348 is an EMI
// instalment. Both were seen in the wild on the reported product.
const withJunk = [21999, 21999, 53999, 21999, 6348, 21999, 21999, 21999, 21999];
const gone1 = droppedPrices(withJunk, { trustedPrice: 21999, mrp: 23999 });
check('a reading above the MRP is removed', gone1.includes(53999), JSON.stringify(gone1));
check('an EMI instalment far below the MRP is removed', gone1.includes(6348), JSON.stringify(gone1));
check('the honest ₹21,999 readings are all kept',
  gone1.length === 2, 'removed ' + gone1.length);
check('the newest reading is never removed',
  !findSelfCleanPoints(hist(withJunk), { trustedPrice: 21999, mrp: 23999 }).drop.includes('p8'));

console.log('--- a transient excursion is removed; a real drop is not ---');

// The product sits at ₹21,999. One reading of ₹15,000 appears and is gone by the
// next check — a scrape artifact.
const excursion = [21999, 21999, 21999, 15000, 21999, 21999, 21999, 21999];
check('an isolated low excursion is removed',
  droppedPrices(excursion, { trustedPrice: 21999, mrp: 23999 }).includes(15000));

// The same low, but it HOLDS. That is a real deal and must survive.
const realDrop = [21999, 21999, 21999, 15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000];
const goneReal = droppedPrices(realDrop, { trustedPrice: 21999, mrp: 23999 });
check('a genuine price drop that holds is KEPT',
  !goneReal.includes(15000), 'removed ' + JSON.stringify(goneReal));

console.log('--- a shifted series is removed ---');

// A run sitting at ₹16,000 with the readings on BOTH sides back at ₹21,999: the
// series shifted away and came back, so it was never this product's price.
const shifted = [21999, 21999, 21999, 12000, 12000, 12000, 21999, 21999, 21999, 21999, 21999, 21999];
const goneShift = droppedPrices(shifted, { trustedPrice: 21999, mrp: 23999 });
check('a shifted run bracketed on both sides is removed',
  goneShift.filter((p) => p === 12000).length === 3, JSON.stringify(goneShift));
check('the readings around it survive', goneShift.every((p) => p === 12000));

console.log('--- what it will NOT do ---');

// A history that is uniformly wrong at a PLAUSIBLE level. Every reading is the
// wrong figure, but the figure is believable, so nothing in the numbers gives it
// away. Deleting this would be guesswork.
const plausible = [19999, 19999, 19999, 19999, 19999, 19999, 19999, 19999];
check('a plausible-but-wrong history is left alone (no evidence in the numbers)',
  droppedPrices(plausible, { trustedPrice: 21999, mrp: 23999 }).length === 0);

// A product whose price simply stepped down and held. Note the MRP is high
// enough that ₹25,999 is a believable past price — with an MRP of ₹23,999 it
// would be above the MRP and correctly removed for that reason alone.
const moved = [25999, 25999, 25999, 21999, 21999, 21999, 21999, 21999, 21999];
check('a price that stepped down and held is kept',
  droppedPrices(moved, { trustedPrice: 21999, mrp: 29999 }).length === 0,
  JSON.stringify(droppedPrices(moved, { trustedPrice: 21999, mrp: 29999 })));

// ...and the same run IS removed when it sits above the MRP, because a selling
// price above the M.R.P. is impossible whatever the history looks like.
check('the same past prices go when they are above the MRP',
  droppedPrices(moved, { trustedPrice: 21999, mrp: 23999 }).filter((p) => p === 25999).length === 3);

// Too little to judge.
check('a history with too few readings is left alone',
  droppedPrices([21999, 53999, 21999], { trustedPrice: 21999, mrp: 23999 }).length === 0);

// A history where MOST readings are impossible must still be cleaned, even
// though the fraction guard would otherwise refuse.
const mostlyJunk = [6348, 6348, 6348, 6348, 6348, 6348, 21999];
check('a history that is mostly impossible readings is still cleaned',
  droppedPrices(mostlyJunk, { trustedPrice: 21999, mrp: 23999 }).filter((p) => p === 6348).length === 6);

// No trusted price and no MRP: nothing to judge by, so nothing happens.
check('with no reference at all, nothing is removed',
  droppedPrices([21999, 15000, 21999, 21999, 21999, 21999], {}).length === 0);

console.log('--- the newest reading is always safe ---');

const newestIsOdd = [21999, 21999, 21999, 21999, 21999, 21999, 21999, 21999, 15000];
check('the reading we just recorded is never deleted',
  droppedPrices(newestIsOdd, { trustedPrice: 21999, mrp: 23999 }).includes(15000) === false);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
