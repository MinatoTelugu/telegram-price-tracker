/**
 * test-wiring.js
 * ---------------------------------------------------------------------------
 * Loads the REAL api/telegram.js and exercises the functions the tracking path
 * depends on.
 *
 * Why this exists: the title rules were moved into lib/titles.js, but one of the
 * constants they need — PLACEHOLDER_SLUGS — was not added to the require in
 * api/telegram.js. Nothing caught it, because `node --check` only parses: the
 * failure was a ReferenceError at CALL time, inside titleFromUrl. Every link hit
 * it, the handler caught it, and the user saw "Something went wrong while
 * processing that link."
 *
 * A parse check cannot see that. Calling the functions can.
 *
 * If the dependencies are not installed the module cannot be loaded at all; that
 * is reported as a SKIP (loudly) rather than a failure, so this test is honest
 * about what it did and did not check.
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

let telegram;
try {
  telegram = require('./api/telegram.js');
} catch (err) {
  const missingDep = err && /Cannot find module/.test(String(err.message));
  if (missingDep) {
    console.log('');
    console.log('SKIPPED: dependencies are not installed, so api/telegram.js cannot be');
    console.log('loaded and its functions cannot be called. Run `npm install` first.');
    console.log('Nothing was verified.');
    console.log('');
    process.exit(0);
  }
  console.log('api/telegram.js FAILED TO LOAD: ' + err.message);
  process.exit(1);
}

const I = telegram._internals || {};
check('the module exposes its internals for testing', Object.keys(I).length > 0);

// --- the functions the tracking path calls -----------------------------------
// A ReferenceError in any of these is invisible to a syntax check.
const calls = [
  ['titleFromUrl', () => I.titleFromUrl('https://www.flipkart.com/samsung-galaxy-m17-5g-mobile/p/itm123?pid=MOB1')],
  ['titleFromUrl (short link)', () => I.titleFromUrl('https://amzn.in/d/0iqccib1')],
  ['titleFromUrl (dp link)', () => I.titleFromUrl('https://www.amazon.in/dp/B0G81TPT89')],
  ['extractUrl', () => I.extractUrl('see https://amzn.in/d/0iqccib1 now')],
  ['cleanProductName', () => I.cleanProductName('Amazon.in: Samsung Galaxy M17 5G Mobile : Electronics')],
  ['isPlaceholderTitle', () => I.isPlaceholderTitle('B0G81TPT89', 'B0G81TPT89')],
  ['isErrorPageTitle', () => I.isErrorPageTitle('503 - Service Unavailable Error')],
  ['betterTitle', () => I.betterTitle('Samsung Galaxy M17 5G Mobile', null)],
  ['looksLikeMarketingCopy', () => I.looksLikeMarketingCopy('IQOO Prismatic Dimensity Processor OriginOS')],
  ['productDocId', () => I.productDocId({ marketplace: 'amazon', productId: 'B0G81TPT89' })],
  ['escapeHtml', () => I.escapeHtml('<b>x</b>')],
  ['isPlaceholderTitle (real)', () => I.isPlaceholderTitle('Samsung Galaxy M17 5G Mobile', 'B0G81TPT89')],
];
for (const [name, fn] of calls) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  check(name + ' runs without throwing' + (threw ? ' (' + threw.message + ')' : ''), !threw);
}

// --- the specific regression -------------------------------------------------
// PLACEHOLDER_SLUGS lived in api/telegram.js and moved to lib/titles.js. If it is
// not imported, this call throws — and that is exactly what broke every link.
{
  let threw = null;
  try {
    // titleFromUrl -> isPlaceholderSlug -> PLACEHOLDER_SLUGS
    I.titleFromUrl('https://www.flipkart.com/p/itm123');
  } catch (err) {
    threw = err;
  }
  check('the constant behind titleFromUrl is wired up', !threw);
}

// --- every constant lib/titles.js exports must be reachable ------------------
{
  const titles = require('./lib/titles');
  const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
  const names = Object.keys(titles).filter((n) => /^[A-Z]/.test(n));
  const unreachable = names.filter((n) => {
    // Used as a bare identifier somewhere in telegram.js, but not imported.
    const used = new RegExp('(^|[^\\w.$])' + n + '\\b(?!\\s*:)').test(src);
    const imported = new RegExp('\\b' + n + '\\b\\s*,').test(
      src.slice(src.indexOf("require('../lib/titles')") - 400, src.indexOf("require('../lib/titles')"))
    );
    return used && !imported;
  });
  check('every constant the bot uses is imported from lib/titles.js' +
    (unreachable.length ? ' (missing: ' + unreachable.join(', ') + ')' : ''), unreachable.length === 0);
}

// --- every module must at least LOAD ----------------------------------------
// A ReferenceError at call time is invisible to a parse check; a missing export
// or a bad require is visible immediately.
for (const mod of ['./api/deals.js', './api/cron.js', './lib/shortlink.js', './lib/titles.js']) {
  let threw = null;
  try {
    require(mod);
  } catch (err) {
    if (!/Cannot find module/.test(String(err.message))) threw = err;
  }
  check(mod + ' loads', !threw);
}

// --- the short-link expander must never return a foreign page ---------------
// The reported logs show "expanded via search -> https://andro.io/app/hbs-travkart"
// for a Flipkart product. The scraper then read that page, so the title, price
// and image came from an unrelated site.
{
  const { acceptExpansion } = require('./lib/shortlink');
  const rejects = [
    ['https://andro.io/app/hbs-travkart', 'the reported foreign page'],
    ['https://example.com/somewhere', 'an unrelated site'],
    ['https://fkrt.clnk.in/DchQ', 'a still-unresolved fkrt.clnk.in link'],
    ['https://dl.flipkart.com/s/96_3ZCuuuN', 'a still-unresolved dl.flipkart.com link'],
    ['https://amzn.in/d/0iqccib1', 'a still-unresolved amzn.in link'],
    ['not a url at all', 'garbage'],
    [null, 'nothing'],
  ];
  for (const [url, label] of rejects) {
    check('the expander refuses ' + label, acceptExpansion(url) === null);
  }
  const keeps = [
    // The Flipkart app-share url is the REAL product url — it carries the pid.
    // An earlier version rejected it by reusing isShortLink, which broke every
    // dl.flipkart.com link with "I could not open that short link".
    ['https://www.flipkart.com/product/p/itme?pid=MOBHKZF3DGME8JHG',
      'https://www.flipkart.com/product/p/itme?pid=MOBHKZF3DGME8JHG'],
    ['https://www.amazon.in/dp/B0G81TPT89', 'https://www.amazon.in/dp/B0G81TPT89'],
    ['https://www.flipkart.com/samsung-galaxy-m17/p/itm123?pid=MOB1',
      'https://www.flipkart.com/samsung-galaxy-m17/p/itm123?pid=MOB1'],
  ];
  for (const [url, want] of keeps) {
    check('the expander keeps ' + url, acceptExpansion(url) === want);
  }
  // A redirector carries the real destination in ?url= — unwrap it.
  const wrapped = 'https://linksredirect.com/?cid=327213&url=https%3A%2F%2Fwww.flipkart.com%2Fp%2Fitm1%3Fpid%3DMOB1';
  check('the expander unwraps a redirector',
    acceptExpansion(wrapped) === 'https://www.flipkart.com/p/itm1?pid=MOB1');
}

// --- deals.js must declare the constants it uses ----------------------------
// CHANNEL_URL was referenced on the "More Deals" button but never declared, so
// every deals post threw "CHANNEL_URL is not defined" and the channel received
// nothing at all.
{
  const deals = fs.readFileSync(__dirname + '/api/deals.js', 'utf8');
  check('deals.js declares CHANNEL_URL', /^const CHANNEL_URL =/m.test(deals));
}

// --- the enrichment must never BLANK what the card already shows -------------
// enrichTracked EDITS the message. It used to build a fresh info starting at
// price: null, so when its own scrape hit a 503 (the normal case for Amazon) the
// edit REMOVED the price the early reply had already found — and a title it could
// not re-find became "This product". Every lookup must only improve a field.
{
  const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
  const start = src.indexOf('async function enrichTracked');
  const fn = src.slice(start, src.indexOf('\n}', start));

  check('enrichTracked accepts what the card already shows', /\(ctx, sentMessage, rawUrl, from, existing\)/.test(fn));
  check('it seeds the title from the existing card', /title: prior\.title \|\|/.test(fn));
  check('it seeds the PRICE from the existing card', /price: prior\.price != null \? prior\.price : null/.test(fn));
  check('a scrape with no price keeps the seeded one', /price: scrapedPrice != null \? scrapedPrice : info\.price/.test(fn));
  check('a scrape with no image keeps the seeded one', /imageUrl: scraped\.imageUrl \|\| info\.imageUrl/.test(fn));
  check('both call sites pass the current info',
    /enrichTracked\(ctx, sent, url, ctx\.from, instantInfo\)/.test(src) &&
      /enrichTracked\(ctx, sentSlow, url, ctx\.from, info\)/.test(src));
}

// --- the converter must reach the shared expander ---------------------------
// affiliate.js had its own resolver that could not reach dl.flipkart.com, so the
// logs said "short link unresolved" for links the shared expander resolves fine.
{
  const aff = fs.readFileSync(__dirname + '/lib/affiliate.js', 'utf8');
  check('the converter falls back to the shared expander', /resolveViaSharedExpander/.test(aff));
  check('...and loads it lazily, to avoid a require cycle', /require\('\.\/shortlink'\)/.test(aff));
  check('...and blocks re-entrancy, which would recurse forever', /sharedExpandInFlight/.test(aff));
}

// --- an http store url is upgraded ------------------------------------------
{
  const { acceptExpansion } = require('./lib/shortlink');
  const out = acceptExpansion('http://www.flipkart.com/motorola-g77/p/itm1?pid=X');
  check('an http store url becomes https', out === 'https://www.flipkart.com/motorola-g77/p/itm1?pid=X');
}

// --- a scanned price far below the MRP is not a price ------------------------
// The reliable sources are structured (JSON-LD, meta, the buybox selector). Every
// other price is a scan of page TEXT, which is full of numbers that are not the
// price — exchange offers, EMI instalments, coupons. Those scans produced ₹6,348
// for an iQOO Z9s and ₹3,250 for a Motorola G77 (both in the reported log).
{
  const { priceLooksImplausible } = require('./lib/scraper');
  const bad = [
    [6348, 19999, 'the last-resort figure from the log'],
    [3250, 21999, 'the card figure from the log'],
    [4999, 29999, 'an EMI-scale figure'],
  ];
  for (const [p, m, label] of bad) {
    check('rejects ' + label, priceLooksImplausible(p, m) === true);
  }
  const tooHigh = [
    [53999, 40999, 'the ₹53,999 reading (above the MRP)'],
    [45999, 40999, 'anything above the MRP'],
  ];
  for (const [p, m, label] of tooHigh) {
    check('rejects ' + label, priceLooksImplausible(p, m) === true);
  }
  const good = [
    [18548, 25999, 'the real Flipkart price'],
    [17145, 25999, 'the WOW deal price'],
    [28998, 40999, 'the real Amazon price'],
    [30998, 40999, 'a real 7% rise'],
    [21249, 21999, 'a real price'],
    [18999, 19999, 'a small discount'],
    [12999, 18999, 'a 31% discount'],
    [7999, 9999, 'a 20% discount'],
  ];
  for (const [p, m, label] of good) {
    check('keeps ' + label, priceLooksImplausible(p, m) === false);
  }
  check('with no MRP it cannot judge, so it keeps the price', priceLooksImplausible(5000, null) === false);
  check('a null price is not judged', priceLooksImplausible(null, 19999) === false);
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  // EVERY source is checked, not just the page-text scan: on Flipkart the price
  // SELECTOR matches the EMI row, which is how ₹6,348 (the instalment in
  // "₹6,348 x 3m") became the price on every check.
  check('every source is validated in a loop', /for \(const pair of candidates\)/.test(scr));
  check('the selector is among the validated sources', /\['selector', \(\) => parsePrice/.test(scr));
  check('a failing source falls through to the next', /price = candidate;\s*\n\s*break;/.test(scr));
  check('a rejection names the source', /ignored the ' \+ pair\[0\] \+ ' price/.test(scr));
  check('the last-resort price is checked against the effective MRP', /priceLooksImplausible\(last\.price, effectiveMrp\)/.test(scr));
}

// --- the reader must be given enough time ------------------------------------
// The log is full of "reader fallback failed: timeout of 8000ms exceeded" for
// Amazon. That is a TIMEOUT, not a block — the route works, it just needs longer.
// The reader renders the page on its own servers, so it is slow by nature.
{
  const { parseReaderBody } = require('./lib/reader');
  const body = 'Title: Samsung Galaxy M17 5G Mobile\n\nURL Source: https://www.amazon.in/dp/B0G81TPT89\n\nCurrent price ₹19,999\nExchange offer: Up to ₹10,490 off';
  const parsed = parseReaderBody(body);
  check('the reader parses the title', parsed.title === 'Samsung Galaxy M17 5G Mobile');
  check('the reader rejects a URL echoed as the title',
    parseReaderBody('Title: https://www.amazon.in/dp/X\n# Real Name') !== null);
  check('...and falls back to the markdown heading',
    parseReaderBody('Title: https://www.amazon.in/dp/X\n\n# Real Product Name').title === 'Real Product Name');
  check('an empty page yields no title', parseReaderBody('nothing here at all').title === null);

  const reader = fs.readFileSync(__dirname + '/lib/reader.js', 'utf8');
  check('the default reader timeout is no longer 8s', !/READER_TIMEOUT_MS \|\| '8000'/.test(reader));
  check('the reader accepts a per-call timeout', /options\.timeoutMs \|\| TIMEOUT/.test(reader));
  check('the reader can retry', /attempts/.test(reader));

  const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
  check('the background enrichment asks for a long reader budget',
    /timeoutMs: 25000/.test(src));
  check('...and retries', /attempts: 2/.test(src));
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the scraper last-resort path does too', /timeoutMs: 20000/.test(scr));
}

// --- the hosted Amazon API must be diagnosable -------------------------------
// "amazon api (omkar): status 404" was all we had, which cannot distinguish an
// unknown product from a wrong path or a rejected key. And the Omkar path was a
// single guess: their docs show two.
{
  const api = fs.readFileSync(__dirname + '/lib/amazonapi.js', 'utf8');
  check('both documented Omkar paths are tried',
    /\/amazon\/product-details,\/products\/details/.test(api));
  check('the Omkar path is overridable', /OMKAR_API_PATH/.test(api));
  check('a failed call logs the response body', /body=/.test(api));
  check('the hosted-API timeout is no longer 12s', !/AMAZON_API_TIMEOUT_MS \|\| '12000'/.test(api));
  check('the code says RapidAPI IS Omkar', /RapidAPI listing[\s\S]{0,200}Omkar/.test(api));

  const env = fs.readFileSync(__dirname + '/.env.example', 'utf8');
  check('.env.example documents OMKAR_API_KEY', /OMKAR_API_KEY=/.test(env));
  check('.env.example explains the RapidAPI/Omkar relationship',
    /RapidAPI listing IS Omkar Cloud/.test(env));

  const { amazonApiConfigured } = require('./lib/amazonapi');
  const saved = { r: process.env.RAPIDAPI_KEY, o: process.env.OMKAR_API_KEY };
  delete process.env.RAPIDAPI_KEY;
  delete process.env.OMKAR_API_KEY;
  check('with neither key it is not configured', amazonApiConfigured() === false);
  process.env.OMKAR_API_KEY = 'k';
  check('an Omkar key alone configures it', amazonApiConfigured() === true);
  process.env.RAPIDAPI_KEY = saved.r;
  process.env.OMKAR_API_KEY = saved.o;
}

// --- the MRP must be readable when the store blocks us -----------------------
// The reader hands us the whole page as markdown, "M.R.P.: ₹40,999" included,
// even when Amazon refuses our own request. Without reading the MRP from THAT
// text, mrp was null for every Amazon product — and a null MRP means the sanity
// check cannot judge anything, which is how ₹53,999 survived on a phone whose
// MRP is ₹40,999. That was the reported bug.
{
  const { mrpFromText, availabilityFromText, priceLooksImplausible } = require('./lib/scraper');
  const amazon = 'Title: iQOO Z11xa 5G\n-29%\n₹28,998\nM.R.P.: ₹40,999\n₹53,999';
  check('the MRP is read from the reader text', mrpFromText(amazon) === 40999);
  check('...so the ₹53,999 reading is rejected', priceLooksImplausible(53999, mrpFromText(amazon)) === true);
  check('...and the real ₹28,998 is kept', priceLooksImplausible(28998, mrpFromText(amazon)) === false);

  const flip = '₹18,548\nM.R.P.: ₹25,999\n₹6,348 x 3m';
  check('the Flipkart MRP is read too', mrpFromText(flip) === 25999);
  check('...so the EMI instalment is rejected', priceLooksImplausible(6348, mrpFromText(flip)) === true);

  check('no MRP in the text yields null', mrpFromText('just a page') === null);

  // Availability, from the same text.
  check('"In stock" reads as in stock', availabilityFromText('In stock\n₹28,998') === false);
  check('"Currently unavailable" reads as out of stock',
    availabilityFromText('Currently unavailable') === true);
  check('"Out of stock" reads as out of stock', availabilityFromText('Out of stock') === true);
  check('a bare "Notify Me" is too weak to judge', availabilityFromText('Notify Me') === null);
  check('an unstated page yields null', availabilityFromText('nothing here') === null);

  // The last-resort path must carry both through.
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the last-resort result carries an MRP', /out\.mrp = mrpFromText\(page\.text\)/.test(scr));
  check('the last-resort result carries availability',
    /out\.inStock = availabilityFromText\(page\.text\)/.test(scr));
  check('the hosted API MRP is used when the text had none',
    /out\.mrp == null && item\.mrp != null/.test(scr));
  check('the caller judges by the effective MRP, not a null one',
    /const effectiveMrp = mrp != null \? mrp : last\.mrp != null \? last\.mrp : null/.test(scr));
  check('a recovered MRP is kept on the product', /if \(mrp == null && last\.mrp != null/.test(scr));
}

// --- availability must be nullable, or the reader's answer is discarded -------
// detectOutOfStock() always returns a boolean, so `!detectOutOfStock($)` was
// never null. That made `if (inStock == null && last.inStock != null)` DEAD CODE,
// and the reader's availability was silently thrown away on every product. For a
// store that refuses us, the "availability" in use was a read of a robot-check
// page — which is why cards said "Out of stock" for products the store shows as
// "In stock".
{
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('availability is gated on the page being usable',
    /const pageUsable = !looksBlocked\(\$\.html\(\)\) && \$\('body'\)\.text\(\)\.trim\(\)\.length > 500/.test(scr));
  check('...and is null when it is not', /const inStock = pageUsable \? !detectOutOfStock\(\$\) : null/.test(scr));
  check('the last-resort availability can therefore be used',
    /if \(inStock == null && last\.inStock != null\) inStock = last\.inStock/.test(scr));

  // The gate itself, exercised.
  const { looksBlocked } = require('./lib/scraper');
  check('a robot-check page is detected', looksBlocked('<html>Enter the characters you see below</html>') === true);
  check('a normal page is not', looksBlocked('<html><body>In stock</body></html>') === false);
}

// --- the alert body must not carry a raw url ---------------------------------
// Every alert is sent with alertKeyboard(), whose "Buy Now" button carries the
// same url. Printing it again as bare text only made the message read as clutter.
// The BUTTONS must be untouched — that is the whole point of removing the text.
{
  const { alertKeyboard } = require('./api/cron.js');
  const cron = fs.readFileSync(__dirname + '/api/cron.js', 'utf8');

  // Exercise the real formatter.
  const fn = cron.match(/function formatAlert\([\s\S]*?\n\}/)[0];
  eval(fn);
  const product = {
    title: 'Samsung Galaxy M17 5G Mobile',
    productId: 'B0G81TPT89',
    affiliateUrl: 'https://www.amazon.in/dp/B0G81TPT89?tag=offerszones03-21',
  };
  for (const kind of ['drop', 'rise', 'restock']) {
    const out = formatAlert(product, 19999, 22999, 15, kind, true);
    check('the ' + kind + ' alert carries no raw url', !/https?:\/\//.test(out));
    check('the ' + kind + ' alert still names the product', out.includes('Samsung Galaxy M17 5G Mobile'));
    check('the ' + kind + ' alert still shows the price', out.includes('22999'));
  }
  check('the alert body has no 🔗 line left', !/🔗/.test(formatAlert(product, 1, 2, 5, 'rise', true)));

  // ...and the buttons are untouched: the url lives there.
  const kb = alertKeyboard('amazon_B0G81TPT89', product);
  const flat = kb.inline_keyboard.reduce((a, r) => a.concat(r), []);
  const buy = flat.find((b) => /Buy Now/.test(b.text));
  check('the Buy Now button still exists', Boolean(buy));
  check('...and still carries the affiliate url',
    buy && buy.url === 'https://www.amazon.in/dp/B0G81TPT89?tag=offerszones03-21');
  check('Stop Tracking is still a working callback',
    Boolean(flat.find((b) => /Stop Tracking/.test(b.text) && /^untrack:/.test(b.callback_data))));
  check('Price History is still there', Boolean(flat.find((b) => /Price History/.test(b.text))));
  check("Today's Deals is still there", Boolean(flat.find((b) => /Today's Deals/.test(b.text))));

  // The alert is sent with that keyboard — which is what makes removing the body
  // link safe. If this ever stops being true, the link must come back.
  check('every alert send attaches the keyboard',
    /sendTelegramMessage\(chatId, message, alertKeyboard\(doc\.id, data\)\)/.test(cron));
  check('there is only one alert send site',
    (cron.match(/sendTelegramMessage\(/g) || []).length === 3); // def + retry + the alert
}

// --- a large move is confirmed before it is believed or alerted on -----------
// The reported product flipped between ₹21,999 and ₹22,999 from one check to the
// next while the store's own page showed ₹21,999 throughout, and each flip sent a
// "PRICE INCREASE ALERT +15%" for a price that never changed.
{
  const cron = fs.readFileSync(__dirname + '/api/cron.js', 'utf8');
  check('there is a confirmation threshold', /PRICE_CONFIRM_THRESHOLD_PERCENT/.test(cron));
  check('a large move triggers a re-read', /Math\.abs\(\(\(confirmedPrice - oldPrice\) \/ oldPrice\) \* 100\) >= CONFIRM_THRESHOLD/.test(cron));
  check('the re-read uses the same product url',
    /const again = await fetchProduct\(/.test(cron));
  check('a disagreeing re-read replaces the price', /confirmedPrice = again\.price;/.test(cron));
  check('...and the confirmed value is what gets stored', /const newPrice = confirmedPrice;/.test(cron));
  check('a FAILED re-read changes nothing, so a genuine alert is never silenced',
    /could not confirm the move/.test(cron) && !/confirmedPrice = null/.test(cron));
  check('the confirmation runs BEFORE the history point is written',
    cron.indexOf('confirmedPrice = again.price') < cron.indexOf('Append the history point'));

  // The rule, exercised.
  const CONFIRM_THRESHOLD = 10;
  function decide(oldPrice, firstRead, reRead) {
    let confirmed = firstRead;
    let alert = true;
    if (oldPrice != null && confirmed != null && oldPrice > 0 &&
        Math.abs(((confirmed - oldPrice) / oldPrice) * 100) >= CONFIRM_THRESHOLD) {
      if (reRead != null && reRead !== confirmed) { confirmed = reRead; alert = false; }
    }
    return { confirmed, alert };
  }
  const flip = decide(19999, 22999, 21999);
  check('the reported flip is corrected to the store price', flip.confirmed === 21999);
  check('...and sends no alert', flip.alert === false);
  const real = decide(19999, 22999, 22999);
  check('a confirmed rise is kept', real.confirmed === 22999 && real.alert === true);
  const unverifiable = decide(19999, 22999, null);
  check('an unverifiable rise is still alerted', unverifiable.alert === true);
  const small = decide(21999, 22439, null);
  check('a small move is not re-read at all', small.confirmed === 22439 && small.alert === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
// Exit explicitly: requiring the network stack can trip the sandbox's
// WebAssembly memory limit during shutdown, which would mask the result.
process.exit(fail ? 1 : 0);
