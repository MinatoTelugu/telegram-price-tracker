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

eval(grab('looksLikeMarketingCopy'));
eval(grab('betterTitle'));
eval(grab('isGenericStoreTitle'));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
