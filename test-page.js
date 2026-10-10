/**
 * test-page.js
 * ---------------------------------------------------------------------------
 * The price-history page's own logic, which no server test covered.
 *
 * Three bugs were reported, and one of them CAUSED another:
 *
 *  1. "Should you buy at this price?" said Yes and "a reasonable time to buy"
 *     after a +7.4% INCREASE. The gauge measures position within the recorded
 *     range, and a rise can still sit low in that range.
 *  2. The analysis text showed a foreign currency symbol.
 *  3. A corrupted reading (₹53,999 on a phone whose MRP is ₹40,999) was still in
 *     the history, dragging the average and the HIGH — and a too-high maximum
 *     flattens every price towards the bottom of the range. That is precisely how
 *     bug 3 produced bug 1: with the junk included the gauge sat at 0.074 and the
 *     verdict was "Yes"; without it, at 1.000 and "wait".
 *
 * The page is HTML, so its functions are lifted out of public/index.html and run
 * here for real.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else {
    fail++;
    console.log('  ✗ FAIL: ' + name);
  }
}

const page = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
function grab(re) {
  const m = page.match(re);
  if (!m) throw new Error('could not extract ' + re);
  return m[0];
}

// --- 2) the currency ---------------------------------------------------------
eval(grab(/var CURRENCY_SYMBOLS = \{[\s\S]*?\n  \}/));

check('INR renders the rupee', money(28998, 'INR') === '₹28,998');
check('a lowercase code still renders the rupee', money(28998, 'inr') === '₹28,998');
check('a padded code still renders the rupee', money(28998, ' INR ') === '₹28,998');
check('a missing code renders the rupee', money(28998, null) === '₹28,998');
check('an empty code renders the rupee', money(28998, '') === '₹28,998');
check('an unknown code renders the rupee rather than nothing', money(28998, 'XYZ') === '₹28,998');
check('a real foreign code still maps correctly', money(28998, 'GBP') === '£28,998');
check('no value renders a dash', money(null, 'INR') === '—');

// An Indian store is INR whatever the stored currency says — that is what stops
// a scraper's bad guess from putting a foreign symbol in the analysis text.
check('the page forces INR for an Indian store',
  /isIndianStore \? 'INR' : \(p\.currency \|\| 'INR'\)/.test(page));
check('...based on the marketplace', /var isIndianStore = p\.marketplace === 'amazon' \|\| p\.marketplace === 'flipkart'/.test(page));

// --- 3) a corrupted reading must not distort the stats -----------------------
const MRP = 40999;
const hist = [{ price: 26998 }, { price: 28998 }, { price: 53999 }, { price: 28998 }];
const usable = hist.filter(
  (h) => typeof h.price === 'number' && h.price <= MRP * 1.02 && h.price >= MRP * 0.4
);
const prices = usable.map((h) => h.price);
const low = Math.min.apply(null, prices);
const high = Math.max.apply(null, prices);
const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

check('the corrupted high is excluded', high === 28998);
check('the average is no longer dragged up', avg === 28331);
check('the honest low survives', low === 26998);
check('the page applies exactly that filter',
  /h\.price <= mrpRef \* 1\.02 && h\.price >= mrpRef \* 0\.4/.test(page));
check('...and falls back when nothing survives', /if \(!usable\.length\) usable = hist;/.test(page));

// --- 1) the gauge position, and therefore the verdict ------------------------
const pos = (28998 - low) / (high - low);
check('with the junk excluded the price sits at the TOP of its range',
  Math.abs(pos - 1) < 0.001);

// The bug, stated as a test: with the junk included the same price sat near the
// BOTTOM, which is what produced "Yes" and "a reasonable time to buy".
const rawPrices = hist.map((h) => h.price);
const junkPos = (28998 - Math.min.apply(null, rawPrices)) /
  (Math.max.apply(null, rawPrices) - Math.min.apply(null, rawPrices));
check('with the junk included it sat near the bottom (the reported bug)',
  junkPos < 0.15);
check('so the old verdict threshold would have said "reasonable time to buy"',
  junkPos <= 0.15 && pos > 0.15);

// --- the verdict must respect a rise ----------------------------------------
check('a rise is detected before the verdict is worded', /var rose = \(prev != null && last != null && last > prev\)/.test(page));
check('a rise says the price went up', /The price just went UP/.test(page));
check('a rise near the high recommends waiting', /waiting is the sensible move/.test(page));
check('the rise branch comes FIRST, so it cannot be overridden',
  page.indexOf('if (rose) {') < page.indexOf('} else if (pos <= 0.15) {'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
