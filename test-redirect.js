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
Module._load = function (request) {
  if (request === 'axios') return { get: async () => ({ status: 200, data: '', headers: {} }), post: async () => ({ data: {} }) };
  return origLoad.apply(this, arguments);
};
const affiliate = require('./lib/affiliate.js');
Module._load = origLoad;

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
