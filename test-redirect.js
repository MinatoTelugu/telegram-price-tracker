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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
