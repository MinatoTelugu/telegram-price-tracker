/**
 * The reader hands back a whole store page as one blob. This suite pins down
 * that we read OUR product's price and availability out of it, and not a
 * related product's.
 *
 * It reproduces the exact report: the card showed ₹19,999 and OUT OF STOCK for
 * a product Amazon showed at ₹21,999, in stock. Both wrong values were sitting
 * in the page — in the "Products related to this item" carousel.
 *
 * Run: node test-buybox.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

const src = fs.readFileSync(path.join(__dirname, 'lib', 'scraper.js'), 'utf8');

/** Pull a function out of the source by name, matching braces. */
function grab(name) {
  const start = src.search(new RegExp('(?:function )' + name + '\\b'));
  if (start < 0) throw new Error('no ' + name + ' in scraper.js');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

eval(grab('buyboxText'));
eval(grab('availabilityFromText'));
eval(grab('priceFromTextMatch'));
eval(grab('priceFromText'));
eval(grab('parsePrice'));
eval(grab('mrpFromText'));
eval(grab('priceLooksImplausible'));

console.log('--- a realistic Amazon page, related products included ---');

// Shaped like Jina's markdown of an Amazon product page: the buy area first,
// then the carousels. The ₹19,999 and the "currently unavailable" below the
// cut belong to OTHER products — exactly the trap that produced the report.
const AMAZON = [
  'Title: Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)',
  '',
  '# Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)',
  '',
  'M.R.P.: ₹23,999',
  'Deal Price: ₹21,999',
  'You Save: ₹2,000 (8%)',
  'Inclusive of all taxes',
  'In stock',
  'Add to Cart',
  '',
  'Products related to this item',
  '',
  'Samsung Galaxy M17 5G (Sapphire Blue, 4GB RAM, 128GB Storage)',
  '₹18,999',
  'Currently unavailable.',
  '',
  'Samsung Galaxy M06 5G',
  '₹19,999',
  'Currently unavailable.',
  '',
  'Customers also viewed',
  'Some Other Phone ₹9,499 Out of stock',
].join('\n');

const amzBuy = buyboxText(AMAZON);
check('the buy area is cut at the related-products heading',
  !/products related to this item/i.test(amzBuy));
check('...so the carousel prices are not in it', !/18,999|19,999/.test(amzBuy));
check('...and neither is the carousel\'s "currently unavailable"',
  !/currently unavailable/i.test(amzBuy));
check('the buy area keeps the real price', /21,999/.test(amzBuy));

check('price is the store\'s ₹21,999, not the carousel\'s ₹19,999',
  priceFromText(AMAZON) === 21999);
check('MRP is ₹23,999', mrpFromText(AMAZON) === 23999);
check('the product is IN STOCK (false), not out of stock',
  availabilityFromText(AMAZON) === false);
check('...and ₹21,999 against an MRP of ₹23,999 is plausible',
  priceLooksImplausible(21999, 23999) === false);

console.log('--- the price is anchored on M.R.P., not "the first ₹" ---');

// A page that prints a variant's price above the main one. The first ₹ amount
// is the variant's; the one immediately before the M.R.P. is ours.
const VARIANT_FIRST = [
  'Title: Some Phone',
  '₹18,999',
  '₹21,999',
  'M.R.P.: ₹23,999',
  'In stock',
].join('\n');
check('a variant price above the main one does not win',
  priceFromText(VARIANT_FIRST) === 21999);

console.log('--- an explicit in-stock statement is believed ---');

check('"In stock" wins over a stray "out of stock" in the buy area',
  availabilityFromText('In stock\nBuy Now\nOut of stock items are not eligible') === false);

const SOLD_OUT = 'Title: X\n₹5,000\nCurrently unavailable.\nWe don\'t know when or if this item will be back in stock.';
check('a genuinely unavailable product is still out of stock',
  availabilityFromText(SOLD_OUT) === true);

console.log('--- Flipkart, where the reader is the only route ---');

const FLIPKART = [
  'Title: Samsung Galaxy M17 5G (Moonlight Silver, 128 GB)',
  'Special price',
  '₹21,999',
  '₹23,999',
  '8% off',
  'In stock',
  'Add to cart',
  'Similar Products',
  'Some Other Phone ₹7,499 Out of stock',
].join('\n');
check('Flipkart price reads correctly', priceFromText(FLIPKART) === 21999);
check('Flipkart stock reads correctly', availabilityFromText(FLIPKART) === false);

console.log('--- nothing is invented when the page says nothing ---');

check('no price in, no price out', priceFromText('Title: X\nNo numbers here.') === null);
check('no availability in, no availability out',
  availabilityFromText('Title: X\nA page with no stock wording.') === null);
check('an empty blob yields nothing', priceFromText('') === null && availabilityFromText('') === null);

console.log('--- the cut never throws the whole page away ---');

// A page whose only content IS a carousel heading must still be readable — we
// fall back to the whole blob rather than returning nothing.
const SHORT = '₹4,999';
check('a blob shorter than the cut is read whole', buyboxText(SHORT) === SHORT);
check('...and still yields its price', priceFromText(SHORT) === 4999);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
