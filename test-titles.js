/**
 * test-titles.js — the product-name rules.
 *
 * Two failures this guards against:
 *
 *  1. A feature BULLET being used as the product name. Amazon pages carry A+
 *     copy like "Samsung Moonlight Storage Upgrades Lag Free" — no model number,
 *     no size, no spec. That is not a product name, and using it makes the card
 *     look broken (Telegram's own preview shows the real title beside it).
 *     Such a title is treated as WEAK, so the metadata and search fallbacks run.
 *
 *  2. A stray page fragment beating the name derived from the URL. The URL slug
 *     comes from the store's canonical link, so it can never be random copy.
 *
 * The functions are lifted out of api/telegram.js and evaluated, so the code
 * under test is the real code — loading the whole handler would drag in Telegraf
 * and Firebase, which this does not need.
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

const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
function grab(name) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('could not extract ' + name + ' from api/telegram.js');
  return m[0];
}

// The error-page/placeholder guards need their constant sets too.
const constSrc =
  src.slice(src.indexOf('const PLACEHOLDER_SLUGS'), src.indexOf('const ERROR_PAGE_TITLES')) +
  src.slice(src.indexOf('const ERROR_PAGE_TITLES'), src.indexOf('function isErrorPageTitle')) +
  src.slice(src.indexOf('const STORE_NAMES'), src.indexOf('function isGenericStoreTitle'));
eval(constSrc.replace(/^const /gm, 'var '));
eval(grab('isErrorPageTitle'));
eval(grab('isPlaceholderTitle'));
eval(grab('displayTitle'));
eval(grab('looksLikeMarketingCopy'));
eval(grab('betterTitle'));
eval(grab('isGenericStoreTitle'));
eval(grab('cleanProductName'));
eval(grab('priceFromText'));
// firstRealPrice and parsePrice live in the scraper, so read that file too.
const scraperSrc = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
function grabScraper(name) {
  const m = scraperSrc.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('could not extract ' + name + ' from lib/scraper.js');
  return m[0];
}
eval(grabScraper('parsePrice'));
eval(grabScraper('firstRealPrice'));

// --- marketing copy vs a real product name -----------------------------------
check(
  'the Amazon A+ bullet is flagged as marketing copy',
  looksLikeMarketingCopy('Samsung Moonlight Storage Upgrades Lag Free') === true
);
check(
  'another bullet is flagged too',
  looksLikeMarketingCopy('Segment Toughest Display Brightest') === true
);
check(
  'the real Amazon title is NOT flagged',
  looksLikeMarketingCopy(
    'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage) | 50MP OIS Triple Camera'
  ) === false
);
check(
  'a title with a model number is not flagged',
  looksLikeMarketingCopy('Samsung Galaxy S24 Ultra 256GB') === false
);
check(
  'a title with a spec token is not flagged',
  looksLikeMarketingCopy('Boat Rockerz Bluetooth Headphones') === false
);
check(
  'a short fragment is not flagged (too little to judge)',
  looksLikeMarketingCopy('Samsung') === false
);
check('a missing title is not flagged', looksLikeMarketingCopy(null) === false);

// --- which name wins ---------------------------------------------------------
check(
  'marketing copy loses to a real name',
  betterTitle('Samsung Moonlight Storage Upgrades Lag Free', 'Samsung Galaxy M17 5G Mobile') ===
    'Samsung Galaxy M17 5G Mobile'
);
check(
  'a fuller genuine name is kept',
  betterTitle('Samsung Galaxy M17 5G Mobile (Moonlight Silver, 4GB RAM)', 'Samsung Galaxy M17 5G Mobile') ===
    'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 4GB RAM)'
);
check(
  'with no URL name the scraped name is used',
  betterTitle('Samsung Galaxy M17 5G Mobile', null) === 'Samsung Galaxy M17 5G Mobile'
);
check(
  'with no scraped name the URL name is used',
  betterTitle(null, 'Samsung Galaxy M17 5G Mobile') === 'Samsung Galaxy M17 5G Mobile'
);
check(
  'marketing copy alone still beats nothing',
  betterTitle('Samsung Moonlight Storage Upgrades Lag Free', null) ===
    'Samsung Moonlight Storage Upgrades Lag Free'
);

// --- a store-page name is never a product name -------------------------------
check('"Amazon.in" is a generic store title', isGenericStoreTitle('Amazon.in') === true);
check('"Amazon India" is generic', isGenericStoreTitle('Amazon India') === true);
check('"Flipkart" is generic', isGenericStoreTitle('Flipkart') === true);
check('"Online Shopping" is generic', isGenericStoreTitle('Online Shopping') === true);
check('a real product name is NOT generic',
  isGenericStoreTitle('Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM)') === false);
check('an empty title counts as generic', isGenericStoreTitle('') === true);

check('a store title loses to the URL name',
  betterTitle('Amazon.in', 'Samsung Galaxy M17 5G Mobile') === 'Samsung Galaxy M17 5G Mobile');
check('a store title alone yields null, not a wrong name',
  betterTitle('Amazon.in', null) === null);
check('a store title never beats a real scraped name',
  betterTitle('Samsung Galaxy M17 5G Mobile', 'Amazon.in') === 'Samsung Galaxy M17 5G Mobile');

// --- the CLEAN product name --------------------------------------------------
// Stores bury the name in spec spam, boilerplate and bracketed variants. The
// card must show the product's actual name.
check(
  'Amazon spec spam after a pipe is dropped',
  cleanProductName('Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage) | 50MP OIS Triple Camera | Super AMOLED Display') ===
    'Samsung Galaxy M17 5G Mobile'
);
check(
  'Flipkart boilerplate is dropped',
  cleanProductName('Samsung Galaxy M17 5G (128 GB Storage, 4 GB RAM) Online at Best Price On Flipkart.com') ===
    'Samsung Galaxy M17 5G'
);
check(
  'a trailing colour and size is dropped',
  cleanProductName('Samsung Galaxy M17 5G Moonlight Silver 128 GB') === 'Samsung Galaxy M17 5G'
);
check(
  'bracketed variant details are dropped',
  cleanProductName('Samsung Galaxy S24 Ultra (Titanium Grey, 12GB RAM, 256GB Storage)') ===
    'Samsung Galaxy S24 Ultra'
);
check('a trailing colour is dropped', cleanProductName('Apple iPhone 15 Blue') === 'Apple iPhone 15');
check(
  'a name with no variant is left alone',
  cleanProductName('Boat Rockerz 255 Pro+') === 'Boat Rockerz 255 Pro+'
);
check('an empty title yields null', cleanProductName('') === null);
check('a null title yields null', cleanProductName(null) === null);

// --- the price read out of a page's TEXT -------------------------------------
// Deterministic (a regex over text we received), so unlike a model it cannot
// invent a number that is not there.
check('a price beside the word "price" wins',
  priceFromText('Samsung Galaxy M17 5G. Current Price: ₹18,999. Free delivery.') === 18999);
check('otherwise the first rupee amount is used',
  priceFromText('Buy now. ₹1,299 only.') === 1299);
check('the Rs. form is understood', priceFromText('Offer Price Rs. 14999 today') === 14999);
check('a decimal rounds correctly, not into a huge number',
  priceFromText('price ₹1,499.50') === 1500);
check('a page with no price yields null', priceFromText('no prices here') === null);
check('empty text yields null', priceFromText('') === null);

// --- the price on a page full of offers --------------------------------------
// A Flipkart page carries exchange, EMI, coupon and sponsored figures. Taking
// the first rupee amount reported a ₹19,999 phone as dropping to ₹10,490.
const reportPage =
  'Infinix Note 50s 5G+ (Titanium Grey, 128 GB) (6 GB RAM) ₹19,999. +₹129 Protect Promise Fee. ' +
  'WOW! DEAL Apply offers for maximum savings ₹18,999 Lowest price for you. OR ₹6,845 x 3m Pay ₹20,534. ' +
  'Exchange offer: Up to ₹10,490 off on your old phone. Notify Me';
check('the exchange figure is NOT taken as the price', firstRealPrice(reportPage) !== 10490);
check('the real price is taken from that page', firstRealPrice(reportPage) === 19999);
check('a bare price works', firstRealPrice('₹19,999') === 19999);
check('an exchange-only string yields null, not a wrong number',
  firstRealPrice('Exchange offer: Up to ₹10,490 off') === null);
check('a cashback clause is skipped', firstRealPrice('Cashback ₹2,000. ₹18,999 Lowest price for you') === 18999);
check('a protection-fee clause is skipped', firstRealPrice('₹129 Protect Promise Fee. ₹19,999') === 19999);
check('no price at all yields null', firstRealPrice('no prices here') === null);

// --- an error page must never become the product name ------------------------
// When a store refuses our host it answers with a 503 / robot-check page, and
// that page's <title> was stored as the product name. A card read
// "☀️ 503 - Service Unavailable Error".
check('a 503 page title is rejected', isErrorPageTitle('503 - Service Unavailable Error') === true);
check('a 403 page title is rejected', isErrorPageTitle('403 Forbidden') === true);
check('an Access Denied page is rejected', isErrorPageTitle('Access Denied') === true);
check('a robot check page is rejected', isErrorPageTitle('Robot Check') === true);
check('a Cloudflare interstitial is rejected', isErrorPageTitle('Just a moment...') === true);
check('a bare store domain is rejected', isErrorPageTitle('Amazon.in') === true);
check('a real product name is NOT rejected', isErrorPageTitle('Samsung Galaxy M17 5G') === false);
check('a name merely containing "error" is NOT rejected',
  isErrorPageTitle('Error Correction Code Memory 16GB') === false);

check('isPlaceholderTitle rejects an error page too',
  isPlaceholderTitle('503 - Service Unavailable Error', 'B0G81TPT89') === true);

// The card must not reprint a bad title that is ALREADY stored on a doc.
check('displayTitle never shows an error page',
  displayTitle('503 - Service Unavailable Error', 'B0G81TPT89') === 'This product');
check('displayTitle falls back rather than showing an ASIN',
  displayTitle('B0G81TPT89', 'B0G81TPT89') === 'This product');
const marketingBlob =
  'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage) | 50MP OIS Triple Camera | ' +
  'Super AMOLED Display | Gorilla Glass Victus | 6 Gen OS Upgrades | MONSTER CAMERA - Turn moments into monster stories';
check('displayTitle cuts the marketing bullets off a good name',
  displayTitle(marketingBlob, 'B0G81TPT89') === 'Samsung Galaxy M17 5G Mobile');
check('displayTitle passes a clean name through',
  displayTitle('Samsung Galaxy M17 5G', 'B0G81TPT89') === 'Samsung Galaxy M17 5G');

// --- no message may go out with its HTML tags showing ------------------------
// The photo-card upgrade spread the keyboard WITHOUT parse_mode, so the caption
// rendered as literal <b>…</b> and <a href="…">…</a>.
{
  const kb = src.match(/function buildTrackKeyboard[\s\S]*?\n\}/)[0];
  check('the keyboard carries parse_mode', /parse_mode:\s*'HTML'/.test(kb));
  const photoUpgrade = src.slice(src.indexOf('upgraded the card to a photo card') - 900,
                                src.indexOf('upgraded the card to a photo card'));
  check('the photo-card caption sets parse_mode', /parse_mode:\s*'HTML'/.test(photoUpgrade));
  const convertErr = src.slice(src.indexOf('CONVERT_ERRORS[result.reason]') - 200,
                               src.indexOf('CONVERT_ERRORS[result.reason]') + 200);
  check('the conversion-error reply sets parse_mode (its text has <b>)',
    /parse_mode:\s*'HTML'/.test(convertErr));
  check('the conversion-error strings really do contain markup',
    /unsupported_store:[\s\S]{0,120}<b>/.test(src));
}

// --- an og:title with a store prefix is a REAL title -------------------------
// THE bug behind "This product" on every Amazon card: isGenericStoreTitle
// matched any title that merely STARTED with a store name, and Amazon's
// og:title reads "Amazon.in: <real product title> : Electronics". So a perfectly
// good name was discarded and the card fell back to the placeholder.
const OG = 'Amazon.in: Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage) : Electronics';
check('an og:title with a store prefix is NOT a store page', isGenericStoreTitle(OG) === false);
check('the same title with the store name at the end is NOT a store page',
  isGenericStoreTitle('Samsung Galaxy M17 5G Mobile : Amazon.in') === false);
check('a bare store name IS a store page', isGenericStoreTitle('Amazon.in') === true);
check('a store name with only "Electronics" after it IS a store page',
  isGenericStoreTitle('Amazon.in: Electronics') === true);
check('"Online Shopping" IS a store page', isGenericStoreTitle('Online Shopping') === true);
check('a Flipkart store page IS a store page', isGenericStoreTitle('Flipkart') === true);
// An Amazon-BRANDED product must not be mistaken for the store page.
check('an Amazon-branded product is NOT a store page',
  isGenericStoreTitle('Amazon Basics HDMI Cable') === false);
check('...even with the og:title prefix',
  isGenericStoreTitle('Amazon.in: Amazon Basics HDMI Cable : Electronics') === false);

check('cleanProductName strips the store prefix and suffix',
  cleanProductName(OG) === 'Samsung Galaxy M17 5G Mobile');
check('cleanProductName keeps an Amazon-branded product name',
  cleanProductName('Amazon.in: Amazon Basics HDMI Cable : Electronics') === 'Amazon Basics HDMI Cable');

// --- a short-link slug must never become the name ----------------------------
check('a short-link slug is rejected as a title', isPlaceholderTitle('016NErcW', 'B0G81TPT89') === true);
check('...and displayTitle falls back rather than showing it',
  displayTitle('016NErcW', 'B0G81TPT89') === 'This product');
check('a real single-word name is still accepted',
  isPlaceholderTitle('Airdopes', 'B0G81TPT89') === false);

// --- displayTitle shows the og:title, which is the whole point ---------------
check('displayTitle shows the real name from an og:title',
  displayTitle(OG, 'B0G81TPT89') === 'Samsung Galaxy M17 5G Mobile');

// --- the reader's price scan must be exchange-aware --------------------------
// It had the same bug the scraper had: with no "price" keyword nearby it took
// the FIRST rupee figure, which on a store page is often an exchange offer.
const offerPage =
  'Exchange offer: Up to ₹10,490 off on your old phone. ' +
  'Current price ₹19,999.';
check('the reader price scan skips an exchange figure', priceFromText(offerPage) === 19999);
check('the reader price scan still finds a plain price', priceFromText('Price ₹1,499.50') === 1500);
check('the reader price scan finds a labelled price', priceFromText('Deal price: ₹2,999') === 2999);

// --- the metadata service's price is passed through, when it has one ---------
{
  const meta = fs.readFileSync(__dirname + '/lib/metadata.js', 'utf8');
  check('fetchMetadata reads a price when the service publishes one', /data\.price/.test(meta));
  check('fetchMetadata returns the price', /\n\s*price,/.test(meta));
  check('a metadata price is used in the enrichment', /price recovered via metadata/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
