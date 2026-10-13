/**
 * test-category.js
 * ---------------------------------------------------------------------------
 * Category inference from a product title, and the category-aware deals wiring.
 *
 * The title is the source because it is the one field a store redesign cannot
 * change — browse-node ids and breadcrumb markup can, and do. The tests use real
 * titles from the bot's own logs, including the ones that must NOT match.
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const c = require('./lib/category.js');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// Real titles, with the category each must resolve to.
const CASES = [
  ['Samsung Galaxy M17 5G Mobile', 'mobile'],
  ['Apple iPhone 17 (Black, 256 GB)', 'mobile'],
  ['iQOO Z10 Lite 5G (64 GB Storage, 4 GB RAM)', 'mobile'],
  ['Redmi Note 14 5G (Titanium Blue, 128 GB)', 'mobile'],
  ['ASUS TUF Gaming A15 AMD Ryzen 7 Gaming Laptop', 'electronics'],
  ['GEONIX 22-Inch FHD IPS 75Hz Monitor', 'electronics'],
  ['Whirlpool 7 Kg Washing Machine', 'appliances'],
  ['Printed Georgette Stitched Flared Gown', 'fashion'],
  ['Campus Women Ciara Running Shoes', 'fashion'],
  ['Callas ST-40 Wooden Study Table with Hutch', 'home'],
  ['Gloss Gel High Shine Nail Polish', 'beauty'],
];
for (const [title, want] of CASES) {
  const got = c.categoryFromTitle(title);
  check(want + ': ' + title.slice(0, 42), got.id === want, 'got ' + got.id);
}

// The traps.
check('"top" does not make a laptop a shirt', c.categoryFromTitle('Gaming Laptop').id === 'electronics');
check('"watch" in a phone title does not win over "5G"', c.categoryFromTitle('Samsung 5G Mobile with Smartwatch Bundle').id === 'mobile');
check('an empty title is "other", not a guess', c.categoryFromTitle('').id === 'other');
check('a nonsense title is "other", not a guess', c.categoryFromTitle('Safari Magnum at minimum 78% Discount').id === 'other');
check('"other" carries zero confidence', c.categoryFromTitle('').confidence === 0);
check('a specific long word raises confidence', c.categoryFromTitle('Whirlpool Washing Machine').confidence >= 0.9);
check('a short common word keeps confidence low', c.categoryFromTitle('Printed Beige Top').confidence <= 0.5);

// Sources.
check('phones have listing pages', (c.sourcesForCategory('mobile') || []).length > 0);
check('fashion has listing pages', (c.sourcesForCategory('fashion') || []).length > 0);
check('an unknown category has none', c.sourcesForCategory('nonsense') === null);
check('every source is a Flipkart listing', (c.sourcesForCategory('mobile') || []).every((u) => /flipkart\.com\/search/.test(u)));

// Wiring.
const deals = fs.readFileSync(path.join(__dirname, 'lib/deals.js'), 'utf8');
const track = fs.readFileSync(path.join(__dirname, 'api/track.js'), 'utf8');
const apiDeals = fs.readFileSync(path.join(__dirname, 'api/deals.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');

check('the deal scrape can be steered by category', /sourcesForCategory\(category\)/.test(deals));
check('...and ranks same-category deals first', /categoryFromTitle\(d\.title \|\| ''\)\.id === category/.test(deals));
check('...with a fallback so the strip is never empty', /inCat\.length >= 3/.test(deals));
check('electronics and phones lead the default sources',
  deals.indexOf('q=mobile') < deals.indexOf('q=fashion%20sale'));
check('there are more phone/tech sources than before',
  (deals.match(/flipkart\.com\/search/g) || []).length >= 8);
check('/api/track reports the category', /category: categoryFromTitle\(/.test(track));
check('...and its confidence', /categoryConfidence/.test(track));
check('/api/deals accepts ?category=', /req\.query\.category/.test(apiDeals));
check('the page has a trending section', /id="trending"/.test(page));
check('...that follows the product being viewed', /renderDeals\(d\.product\.category/.test(page));
check('...and names the category in the heading', /CATEGORY_HEADINGS/.test(page));
check('...and stays general when there is no confident category', /confidence >= 0\.5/.test(page));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
