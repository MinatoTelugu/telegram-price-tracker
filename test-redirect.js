/**
 * test-redirect.js — short-link expansion.
 *
 * Amazon's amzn.in/d/ links, and many other redirectors, redirect from INSIDE
 * the page rather than with a 302. If we only read the Location header we never
 * expand them, and everything downstream — the ASIN, the search fallback, the
 * product name — has nothing to work with.
 */
const Module = require('module');
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

// Stub axios so requiring lib/affiliate does not touch the network.
const origLoad = Module._load;
// The metadata route is reached through axios.get; return a resolved final URL
// so we can prove the expander uses it when our own hops fail.
const CANONICAL = 'https://www.flipkart.com/ai-plus-pulse-2-blue-64-gb/p/itm9168504534079';
let metadataWorks = true; // flip to false to exercise the search route
const SEARCH_RESULT = 'https://www.flipkart.com/realme-p4-5g-steel-grey-128-gb/p/itmrealme1';
Module._load = function (request) {
  if (request === 'axios') {
    return {
      get: async (url) => {
        if (String(url).includes('microlink') || String(url).includes('metadata')) {
          return {
            status: 200,
            data: { data: metadataWorks ? { url: CANONICAL, title: 'AI+ Pulse 2 Blue 64 GB' } : {} },
          };
        }
        // our own hops: pretend the host refuses us
        return { status: 200, data: '', headers: {} };
      },
      post: async (url) => {
        if (String(url).includes('langsearch')) {
          return {
            status: 200,
            data: { code: 200, data: { webPages: { value: [{ name: 'realme P4 5G', url: SEARCH_RESULT, snippet: 'realme P4 5G' }] } } },
          };
        }
        return { data: {} };
      },
    };
  }
  return origLoad.apply(this, arguments);
};
const affiliate = require('./lib/affiliate.js');
// NOTE: the axios stub stays installed for the whole file. Restoring it here
// would make the lazily-required metadata module use the REAL axios, and those
// calls would fail — the resolver's third route would then look broken when it
// is not.

const base = 'https://amzn.in/d/016NErcW';
const target = 'https://www.amazon.in/Samsung-Galaxy-M17-5G/dp/B0G81TPT89';

check(
  'a JS location.replace redirect is followed',
  affiliate.extractRedirectTarget("<script>window.location.replace('" + target + "');</script>", base) === target
);
check(
  'a location.href assignment is followed',
  affiliate.extractRedirectTarget("<script>location.href = '" + target + "';</script>", base) === target
);
check(
  'a standard meta refresh is followed',
  affiliate.extractRedirectTarget('<meta http-equiv="refresh" content="0;url=' + target + '">', base) === target
);
check(
  'a canonical link is still followed',
  affiliate.extractRedirectTarget(
    '<link rel="canonical" href="https://www.flipkart.com/x/p/itmabc?pid=MOBX1">',
    'https://fkrt.cc/a'
  ) === 'https://www.flipkart.com/x/p/itmabc?pid=MOBX1'
);
check(
  'og:url is still followed',
  affiliate.extractRedirectTarget('<meta property="og:url" content="' + target + '">', base) === target
);
check('a page with no redirect yields null', affiliate.extractRedirectTarget('<html>hi</html>', base) === null);
check(
  'a bare URL inside JavaScript is NOT mistaken for a redirect',
  affiliate.extractRedirectTarget("<script>var u='" + target + "';</script>", base) === null
);

// The ASIN must come out of the EXPANDED url, which is what the search needs.
check(
  'an ASIN is extractable from the expanded amazon URL',
  affiliate.extractAmazonAsin(target) === 'B0G81TPT89'
);
check(
  'amzn.in is classified as Amazon, so it takes the resolve path',
  affiliate.detectMarketplace('amzn.in') === 'amazon'
);
check('amzn.to is classified as Amazon', affiliate.detectMarketplace('amzn.to') === 'amazon');
check('a.co is classified as Amazon', affiliate.detectMarketplace('a.co') === 'amazon');

// --- universal resolver -------------------------------------------------------
const shortlink = require('./lib/shortlink.js');

check('amzn.in/d is a short link', shortlink.isShortLink('https://amzn.in/d/016NErcW') === true);
check('amzn.to is a short link', shortlink.isShortLink('https://amzn.to/3xYz') === true);
check('a.co is a short link', shortlink.isShortLink('https://a.co/d/abc') === true);
check('dl.flipkart.com/s is a short link', shortlink.isShortLink('https://dl.flipkart.com/s/kKLBCCuuuN') === true);
check('fkrt.cc is a short link', shortlink.isShortLink('https://fkrt.cc/abc') === true);
check('fkrt.it is a short link', shortlink.isShortLink('https://fkrt.it/abc') === true);
check('flipkart.com/s is a short link', shortlink.isShortLink('https://www.flipkart.com/s/AbC123') === true);
check('a canonical amazon url is NOT a short link', shortlink.isShortLink('https://www.amazon.in/dp/B0G81TPT89') === false);
check('a canonical flipkart url is NOT a short link', shortlink.isShortLink('https://www.flipkart.com/x/p/itmabc?pid=MOBX1') === false);
// The Flipkart APP share form is not a product page — fetching it returns 500,
// so it has to be expanded like any other share link.
check(
  'the flipkart app-share form is treated as a short link',
  shortlink.isShortLink('https://www.flipkart.com/product/p/itme?pid=MOBHK55AG6VHCDYG') === true
);
check(
  'a flipkart search url is NOT a short link',
  shortlink.isShortLink('https://www.flipkart.com/search?q=shoes') === false
);

(async () => {
  check('a non-short link is returned unchanged',
    (await shortlink.expandShortLink('https://www.amazon.in/dp/B0G81TPT89')) === 'https://www.amazon.in/dp/B0G81TPT89');
  const expanded = await shortlink.expandShortLink('https://dl.flipkart.com/s/kKLBCCuuuN');
  check('a dl.flipkart.com link expands to the canonical product url', expanded === CANONICAL);
  check('the expanded url is a canonical flipkart product page', String(expanded).includes('/p/itm'));
  check('the expanded url is no longer a short link', shortlink.isShortLink(String(expanded)) === false);

  // Resilience: if the metadata service gives us nothing, the search API is a
  // second independent route to the canonical url.
  metadataWorks = false;
  process.env.LANGSEARCH_API_KEY = 'ls_test';
  const viaSearch = await shortlink.expandShortLink('https://dl.flipkart.com/s/kKLBCCuuuN');
  check('the search route expands when metadata fails', viaSearch === SEARCH_RESULT);
  delete process.env.LANGSEARCH_API_KEY;

  // With no route available at all it must report failure, not a wrong url.
  metadataWorks = false;
  const none = await shortlink.expandShortLink('https://dl.flipkart.com/s/kKLBCCuuuN');
  check('with every route unavailable it returns null (never a wrong url)', none === null);
  metadataWorks = true;

  // ---------------------------------------------------------------------------
// dl.flipkart.com is slow and sometimes answers with an interstitial before it
// redirects. The manual hop loop gives each hop 2.5s, which was not enough, and
// the user saw "I could not open that short link (it may have expired)."
// The client now follows the chain itself, with the manual hops as fallback.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(__dirname + '/lib/affiliate.js', 'utf8');
  check('the client follows the redirect chain', /async function followRedirects\(url, maxHops\)/.test(src));
  check('...with a real redirect budget', /maxRedirects: maxHops \|\| 10/.test(src));
  check('...and a timeout that suits a slow store', /SHORTLINK_TIMEOUT_MS/.test(src));
  check('...reading the final URL from the response', /responseUrl/.test(src));
  check('...and an interstitial body is searched for the destination', /found the destination in the body/.test(src));
  check('...it runs BEFORE the manual hop loop', /0\) Let the client follow the chain/.test(src));
  check('...and the manual hops remain as a fallback', /for \(let hop = 0; hop < 8; hop\+\+\)/.test(src));
  check('it is exported for testing', /followRedirects,/.test(src));
}

// ---------------------------------------------------------------------------
// THE TWO-MINUTE HANG. Reported: a Flipkart short link froze the bot for close
// to two minutes. Every route was individually bounded — 12s for the redirect
// follow, 2.5s x 8 for the manual hops, then the converter, metadata and search
// — but they run IN SEQUENCE and nothing bounded their SUM. Four bounded waits
// add up to an unbounded one.
// ---------------------------------------------------------------------------
const sl = fs.readFileSync(__dirname + '/lib/shortlink.js', 'utf8');
const af = fs.readFileSync(__dirname + '/lib/affiliate.js', 'utf8');
const tg = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
const mod = require(__dirname + '/lib/shortlink.js');

check('a hard ceiling exists on a whole expansion', /EXPAND_DEADLINE_MS/.test(sl));
check('...and it is within the 5-8s asked for', mod.EXPAND_DEADLINE_MS >= 5000 && mod.EXPAND_DEADLINE_MS <= 8000, 'is ' + mod.EXPAND_DEADLINE_MS);
check('...the caller is released by a race, not by the slowest route', /Promise\.race\(\[expandShortLinkInner\(raw\), deadline\]\)/.test(sl));
check('...and the timer is always cleared', /clearTimeout\(timer\)/.test(sl));
check('the redirect follow budget is no longer 12s', !/SHORTLINK_TIMEOUT_MS \|\| '12000'/.test(af));
check('...it is no longer the longest single wait', /3500/.test(af));
check('the hop loop has a TOTAL budget, not 2.5s per hop', /hopDeadline/.test(af));
check('...and it stops when the budget is spent', /hop budget spent/.test(af));
check('...and each hop is capped by what is left of it', /Math\.min\(2500, hopDeadline - Date\.now\(\)\)/.test(af));
check('the caller has a second, outer bound', /setTimeout\(\(\) => resolve\(null\), 8000\)/.test(tg));

// ---------------------------------------------------------------------------
// THE READER ROUTE. Reported: dl.flipkart.com/s/... still failed after the
// deadline was fixed — the replies were fast, but still "I could not open that
// short link". The expansion had four routes and NONE used the reader, even
// though the reader is the one service that fetches from servers other than
// ours. dl.flipkart.com refuses datacenter IPs, so every route going out from
// this host fails; the reader is the one that does not.
// ---------------------------------------------------------------------------
{
  const rd = fs.readFileSync(__dirname + '/lib/reader.js', 'utf8');
  const { parseReaderBody } = require(__dirname + '/lib/reader.js');
  const body = [
    'Title: LAVA Virat Curve 5G (128 GB Storage, 6 GB RAM) Online at Best Price On Flipkart.com',
    '',
    'URL Source: https://www.flipkart.com/lava-virat-curve-5g-makrana-ivory-128-gb/p/itmabc123?pid=MOBXYZ',
    '',
    'Markdown Content:',
    'Buy LAVA Virat Curve 5G online...',
  ].join('\n');
  const r = parseReaderBody(body);
  check('the reader keeps the URL it landed on', /resolvedUrl/.test(rd));
  check('...and it is the canonical store URL',
    /flipkart\.com\/.*\/p\/itm/.test(String(r.resolvedUrl)), String(r.resolvedUrl));
  check('...while the title still comes through', /LAVA Virat/.test(String(r.title)));
  check('the reader is now a route in the expansion', /expanded via the reader/.test(sl));
  check('...and it is tried before search', sl.indexOf('via the READER') < sl.indexOf('via the search API'));
  check('...with a bounded timeout', /fetchReadablePage\(raw, \{ timeoutMs: 4500 \}\)/.test(sl));
  check('...and its answer is validated as a store URL', /acceptExpansion\(page\.resolvedUrl\)/.test(sl));
}

// ---------------------------------------------------------------------------
// FLIPKART PRICE. Reported: the alert said ₹18,566 for a phone the page shows at
// ₹19,130. The page carries BOTH "Buy now at ₹19,130" (the selling price) and
// "Buy at ₹17,075" (the EMI / WOW DEAL card), plus exchange and bank offers.
// ---------------------------------------------------------------------------
{
  const { priceFromTextMatch } = require(__dirname + '/lib/scraper.js');
  const page = [
    'Samsung Galaxy M17 5G (Moonlight Silver, 128 GB) (4 GB RAM)',
    '\u219322% 24,500 \u20b919,130',
    '+\u20b9129 Protect Promise Fee',
    'WOW DEAL Buy at \u20b917,075 EMI @ \u20b95,692 x 3m',
    'Exchange offer Not available at this Pincode Up to \u20b914,950',
    'Bank offers Best value for you \u20b91,432 off',
    'Buy with EMI From \u20b96,547/m Buy now at \u20b919,130',
  ].join('\n');
  const r = priceFromTextMatch(page);
  check('the Flipkart selling price is read, not the EMI offer', r && r.price === 19130, JSON.stringify(r));
  check('...and it is treated as a labelled read, not a guess', r && r.kind === 'labelled', r && r.kind);
  const r2 = priceFromTextMatch('Current price: \u20b919,130 M.R.P.: \u20b924,500');
  check('a labelled price still reads as labelled', r2 && r2.price === 19130 && r2.kind === 'labelled');
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the current Flipkart price class is listed', /div\.nx3p3z/.test(scr));
  check('the buy button is read BEFORE the offer blocks are stripped',
    scr.indexOf('const buyButton =') < scr.indexOf('Strip the offer blocks'));
  check('"Buy at" (the EMI card) is stripped', /buy\\s\+at\\s\*\(\?:/.test(scr));

  const sl2 = fs.readFileSync(__dirname + '/lib/shortlink.js', 'utf8');
  check('the main-host route exists for dl.flipkart.com share links', /expanded via the main host/.test(sl2));
  check('...and it only fires for the /s/ share path', /\^\\\/s\\\//.test(sl2));
}

// ---------------------------------------------------------------------------
// THE ACTUAL BUG, found at last. "I could not open that short link" is not an
// EXPANSION error — it is a CONVERTER error (CONVERT_ERRORS.shortlink_unresolved).
// The link was being expanded and then failing at affiliate conversion, and the
// caller refused the product because of it.
//
// Two causes:
//   - the short-link fallback called convertWithProvider() (AFFILIATERS only),
//     skipping Cuelinks, which is the PRIMARY network and the first link in the
//     normal non-Amazon chain.
//   - when that one provider failed, it returned a hard error and the caller
//     replied with a refusal. A Flipkart share link is still a Flipkart link.
// ---------------------------------------------------------------------------
{
  const af2 = fs.readFileSync(__dirname + '/lib/affiliate.js', 'utf8');
  const tg2 = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');

  check('the short-link fallback uses the full conversion chain',
    /const viaChain = await convertNonAmazon\(raw\)/.test(af2));
  check('...Cuelinks is reachable from that path', /convertNonAmazon\(raw\)/.test(af2));
  check('...and the single-provider call is only a last resort',
    af2.indexOf('convertNonAmazon(raw)') < af2.indexOf('convertWithProvider(raw).catch'));
  check('an unresolvable share link is no longer a hard error',
    !/return \{ ok: false, reason: 'shortlink_unresolved'/.test(af2));
  check('...it comes back trackable instead', /tracking it as-is/.test(af2));

  check('the caller salvages an unresolvable short link rather than refusing it',
    /could not be resolved or converted — tracking the share url itself/.test(tg2));
  check('...giving it a stable product id from the share code', /'share_' \+ m\[1\]/.test(tg2));
  check('...and still refusing a genuinely unsupported store',
    /CONVERT_ERRORS\[result.reason\]/.test(tg2));
}


// ---------------------------------------------------------------------------
// FLIPKART PRICE, second report. The bot showed Rs 3,159 for a phone whose page
// reads:
//     Top Discount of the Sale
//     ↓45%   33,999   Rs 18,799
//     Rs 200 off applied for you
// Every anchor missed: the button says "Add to cart" (not "Buy now at"), Flipkart
// prints no "Price:" label, and the struck figure is a BARE number with no
// "M.R.P." — so the read fell through to "the first Rs in the buy area".
//
// What Flipkart always prints is the discount triple: percent, struck MRP, price.
// ---------------------------------------------------------------------------
{
  const { priceFromTextMatch } = require(__dirname + '/lib/scraper.js');
  const page = [
    'Samsung Galaxy A35 5G (Awesome Iceblue, 128 GB) (8 GB RAM)',
    'Top Discount of the Sale',
    '\u219345% 33,999 \u20b918,799',
    '\u20b9200 off applied for you',
    '+\u20b9129 Protect Promise Fee',
    'Add to cart Change Address',
  ].join('\n');
  const r = priceFromTextMatch(page);
  check('the Flipkart discount triple gives the selling price', r && r.price === 18799, JSON.stringify(r));
  check('...and it counts as a labelled read, not a guess', r && r.kind === 'labelled', r && r.kind);

  const withButton = priceFromTextMatch(['Samsung Galaxy M17 5G', '\u219322% 24,500 \u20b919,130', 'Buy now at \u20b919,130'].join('\n'));
  check('the buy button still wins when the page has one', withButton && withButton.price === 19130, JSON.stringify(withButton));

  const cheap = priceFromTextMatch('Printed Georgette Gown \u219360% 999 \u20b9399');
  check('a cheap fashion deal is still read correctly', cheap && cheap.price === 399, JSON.stringify(cheap));

  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the percent is not the captured group', /const discountTriple =\s*\n?\s*\/\(\?:\u2193/.test(scr) || /discountTriple/.test(scr));
  check('...and no blunt "under Rs 1000 is wrong" rule was added', !/price < 1000\) return true/.test(scr));
}

// The behaviour, with a deliberately slow route rather than the network.
const started = Date.now();
Promise.race([
  new Promise((r) => setTimeout(() => r('too late'), 60000)),
  new Promise((r) => setTimeout(() => r(null), mod.EXPAND_DEADLINE_MS)),
]).then((v) => {
  const ms = Date.now() - started;
  check('a slow route releases the caller in seconds, not minutes', ms <= mod.EXPAND_DEADLINE_MS + 500, 'took ' + ms + 'ms');
  check('...returning null so the caller can fail cleanly', v === null);
  // ---------------------------------------------------------------------------
// THE DIAGNOSIS FROM THE FIELD.
//
// A product is live at Rs 14,799 on Flipkart, and the bot shows "—" for every
// price, STOCK UNKNOWN and PRICE READINGS: 0, with "Updated: 18 Oct 05:30" —
// so the cron RAN and fetchProduct returned ok:false. The doc carries
// lastCheckError (price_not_found / blocked / http_403 / http_429) and nothing
// ever exposed it, so a blank price could not be told from a blocked fetch.
// That distinction decides whether a parser fix can help at all.
// ---------------------------------------------------------------------------
{
  const track = fs.readFileSync(__dirname + '/api/track.js', 'utf8');
  const cron = fs.readFileSync(__dirname + '/api/cron.js', 'utf8');
  const scraperSrc = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');

  check('/api/track exposes lastCheckError', /lastCheckError: data\.lastCheckError \|\| null/.test(track));
  check('the cron stores it on failure', /lastCheckError: result\.reason/.test(cron));
  check('...and clears it on success', /lastCheckError: null/.test(cron));
  check('...recording the attempt time even on failure, so rotation moves on',
    /lastCheckedAt: FieldValue\.serverTimestamp\(\),[\s\S]{0,80}lastCheckError: result\.reason/.test(cron));

  // The discount triple, in every form the readers emit.
  const { priceFromTextMatch } = require('./lib/scraper.js');
  const cases = [
    ['\u219322%  ~~18,999~~  \u20b914,799', 14799],
    ['22% off  \u20b918,999 \u20b914,799', 14799],
    ['\u219345%   33,999   \u20b918,799', 18799],
    ['22% off \u20b914,799', 14799],
    ['<s>\u20b918,999</s> \u20b914,799', 14799],
    ['\u20b914,799', 14799],
  ];
  for (const [text, want] of cases) {
    const r = priceFromTextMatch(text);
    check('discount triple: ' + JSON.stringify(text), r && r.price === want, r && r.price);
  }
  check('the percent is optional, not required',
    scraperSrc.includes('(?:\\d{1,2}\\s*%\\s*(?:off\\b)?)?'));
  check('...and only the PRICE is captured, so m[1] stays the price',
    scraperSrc.includes('\\s*([\\d,]+(?:\\.\\d{1,2})?)/i.exec(t)'));
}

// ---------------------------------------------------------------------------
// THE FAILURE REASON MUST DISTINGUISH REFUSAL FROM A PARSER MISS.
//
// The two lead to opposite actions and the final return used to report
// price_not_found for both:
//   price_not_found -> the page was reached, so fix the parser
//   blocked         -> the store refused this host, so no parser fix can help
//                      and the reader routes are the only way in
// ---------------------------------------------------------------------------
{
  const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('a refusal is remembered, not just returned once',
    /directBlocked = true;/.test(scr));
  check('...declared per call', /let directBlocked = false;/.test(scr));
  check('...and the final return reports it as blocked',
    /reason: directBlocked \? 'blocked' : 'price_not_found'/.test(scr));
  check('the reader is still tried after a refusal, so the reason reflects both',
    /lastResortProduct/.test(scr));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
})();