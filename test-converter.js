/** test-converter.js — mocked test of lib/converter.js (Affiliaters/EarnKaro). */
const Module = require('module');

const calls = [];
let mode = 'ok';
const axiosMock = {
  post: async (url, body, config) => {
    calls.push({ url, body, config });
    if (mode === 'fail') {
      const e = new Error('boom');
      e.response = { data: { error: 'nope' } };
      throw e;
    }
    if (String(url).includes('cuelinks')) {
      return {
        data: {
          data: {
            tracking_url: 'https://linksredirect.com/?cid=456&url=x',
            affiliated: true,
            original_url: 'https://www.myntra.com/x',
            campaign: { id: 101, name: 'Myntra' },
          },
        },
      };
    }
    if (String(url).includes('langsearch')) {
      return {
        status: 200, // real axios always reports a status
        data: {
          code: 200,
          data: {
            webPages: {
              value: [
                { name: 'Amazon.in: Electronics Store', url: 'https://www.amazon.in/electronics', snippet: 'Shop electronics' },
                { name: 'Samsung Galaxy M17 5G (Moonlight Silver, 6GB RAM, 128GB Storage) : Amazon.in: Electronics', url: 'https://www.amazon.in/dp/B0G81TPT89', snippet: 'Samsung Galaxy M17 5G' },
              ],
            },
          },
          usage: { input_tokens: 5, output_tokens: 20 },
        },
      };
    }
    return { data: { deal: '🔥 Great deal https://ekaro.in/abcd1234 grab it' } };
  },
  // Used by resolveShortUrl (manual redirect following).
  get: async (url) => {
    if (url === 'https://dl.flipkart.com/s/Gc4f0cuuuN') {
      return { status: 302, headers: { location: 'https://www.flipkart.com/x/p/itmabc123?pid=MOBX1' }, data: '' };
    }
    return { status: 200, headers: {}, data: '<html></html>' };
  },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return axiosMock;
  return origLoad.apply(this, arguments);
};

const { convertWithProvider, converterConfigured, pickDealText, firstUrl } = require('./lib/converter');
const { convertAffiliateLink } = require('./lib/affiliate');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n); } };

(async () => {
  delete process.env.AFFILIATERS_TOKEN;
  delete process.env.AFFILIATERS_CONVERTER_URL;
  check('no token -> null', (await convertWithProvider('https://www.flipkart.com/x/p/itmabcdef')) === null);
  check('converterConfigured() is false without a token', converterConfigured() === false);

  process.env.AFFILIATERS_TOKEN = 'test-token';
  check('converterConfigured() is true with a token', converterConfigured() === true);

  const out = await convertWithProvider('https://www.flipkart.com/x/p/itmabcdef');
  check('returns the converted link', out === 'https://ekaro.in/abcd1234');

  const sent = calls[calls.length - 1];
  check('posts to the documented endpoint', sent.url === 'https://ekaro-api.affiliaters.in/api/converter/public');
  check('sends the documented payload', sent.body.deal === 'https://www.flipkart.com/x/p/itmabcdef' && sent.body.convert_option === 'convert_only');
  check('sends the Bearer token', sent.config.headers.Authorization === 'Bearer test-token');

  process.env.AFFILIATERS_CONVERTER_URL = 'https://custom.example/convert';
  await convertWithProvider('https://www.flipkart.com/y/p/itmzzzzzz');
  check('endpoint override is honoured', calls[calls.length - 1].url === 'https://custom.example/convert');
  delete process.env.AFFILIATERS_CONVERTER_URL;

  // The real-world case: a Flipkart link with NO recognisable pid. The converter
  // must still be tried — this used to fail with "could not find the product ID".
  const pidless = await convertAffiliateLink('https://www.flipkart.com/dl/item/p/product');
  check('pid-less Flipkart link converts via the converter', pidless.ok === true && pidless.viaConverter === true);
  check('converted link is the EarnKaro link', pidless.affiliateUrl === 'https://ekaro.in/abcd1234');
  check('it still gets a usable product id for tracking', typeof pidless.productId === 'string' && pidless.productId.length > 0);

  // A Flipkart link WITH a pid should also convert.
  const withPid = await convertAffiliateLink('https://www.flipkart.com/apple-iphone-15/p/itm6a3f6c1a2b3c4d?pid=MOBGTAGPXYZ');
  check('pid Flipkart link converts via the converter', withPid.ok === true && withPid.viaConverter === true && withPid.productId === 'MOBGTAGPXYZ');

  // Amazon must NOT go through the converter — it keeps the direct tag.
  const amz = await convertAffiliateLink('https://www.amazon.in/dp/B08N5WRWNW');
  check('Amazon bypasses the converter', amz.ok === true && !amz.viaConverter && amz.affiliateUrl.includes('amazon.in'));

  mode = 'fail';
  check('api failure -> null (never throws)', (await convertWithProvider('https://x.example/y')) === null);

  check('pickDealText handles a nested data.deal', pickDealText({ data: { deal: 'x https://ek.example/1' } }) === 'x https://ek.example/1');
  check('firstUrl finds the link in text', firstUrl('grab https://ek.example/2 now') === 'https://ek.example/2');
  check('firstUrl returns null for junk', firstUrl('no links here') === null);

  // resolveShortUrl must follow the Location header itself (dl.flipkart.com).
  const { resolveShortUrl } = require('./lib/affiliate');
  const finalUrl = await resolveShortUrl('https://dl.flipkart.com/s/Gc4f0cuuuN');
  check(
    'resolveShortUrl follows the Location header itself',
    finalUrl === 'https://www.flipkart.com/x/p/itmabc123?pid=MOBX1'
  );

  // A 200 whose page redirects from INSIDE (canonical link) must also be followed.
  axiosMock.get = async (url) => {
    if (url === 'https://dl.flipkart.com/s/INPAGE') {
      return {
        status: 200,
        headers: {},
        data: '<html><head><link rel="canonical" href="https://www.flipkart.com/ai-plus-pulse-2-fe/p/itmxyz?pid=MOBABC"></head></html>',
      };
    }
    return { status: 200, headers: {}, data: '<html></html>' };
  };
  const inPageUrl = await resolveShortUrl('https://dl.flipkart.com/s/INPAGE');
  check(
    'a 200 with a canonical link is followed',
    inPageUrl === 'https://www.flipkart.com/ai-plus-pulse-2-fe/p/itmxyz?pid=MOBABC'
  );

  // The real-world trick: the converter link redirects to the store URL, and
  // the store then drops the connection from our IP. We must still return the
  // store URL we already learned, so the name can come from its slug.
  axiosMock.get = async (url) => {
    if (url === 'https://ekaro.in/abc') {
      return {
        status: 302,
        headers: { location: 'https://www.flipkart.com/ai-plus-pulse-2-fe/p/itmxyz?pid=MOBABC' },
        data: '',
      };
    }
    throw new Error('socket hang up'); // the store silently drops us
  };
  const furthest = await resolveShortUrl('https://ekaro.in/abc');
  check(
    'returns the furthest URL reached when a later hop times out',
    furthest === 'https://www.flipkart.com/ai-plus-pulse-2-fe/p/itmxyz?pid=MOBABC'
  );

  // If the short link cannot be resolved at all, we must NOT tell the user the
  // link is broken — hand it to the converter instead.
  mode = 'ok';
  axiosMock.get = async () => {
    throw new Error('blocked');
  };
  const fallback = await convertAffiliateLink('https://dl.flipkart.com/s/BLOCKED123');
  check('unresolvable short link falls back to the converter', fallback.ok === true && fallback.viaConverter === true);
  check('fallback still yields a usable product id', typeof fallback.productId === 'string' && fallback.productId.length > 0);

  // The real EarnKaro chain from the Koyeb log: hop 1 is a tracking page whose
  // dl= parameter holds the canonical Flipkart URL (with the name slug).
  const { extractDestinationFromQuery } = require('./lib/affiliate');
  const trackingUrl =
    'https://trackingv3.linkredirect.in/visitretailer/2276?id=2266687&shareid=dujfXDL' +
    '&dl=https%3A%2F%2Fwww.flipkart.com%2Fai-pulse-2-blue-64-gb%2Fp%2Fitm9168504534079%3Fpid%3DMOBHKHPYZFF8KUPC%26lid%3DLSTMOBHKHPYZFF8KUPCODDALK' +
    '&source=Default';
  check(
    'extracts the store URL from the EarnKaro dl= parameter',
    extractDestinationFromQuery(trackingUrl) ===
      'https://www.flipkart.com/ai-pulse-2-blue-64-gb/p/itm9168504534079?pid=MOBHKHPYZFF8KUPC&lid=LSTMOBHKHPYZFF8KUPCODDALK'
  );
  check('no destination in a plain url', extractDestinationFromQuery('https://www.flipkart.com/x/p/itm1') === null);

  // From the Koyeb log: the pid page's canonical is the BARE /product/p/itme.
  // Following it drops the pid and 500s — so it must be refused.
  const { isMoreSpecific } = require('./lib/affiliate');
  const pidUrl = 'https://www.flipkart.com/product/p/itme?pid=MOBHETX6NVUH8VPG&lid=LSTMOBHETX6NVUH8VPGCRWB18';
  check(
    'will NOT follow a canonical that drops the pid',
    isMoreSpecific('https://www.flipkart.com/product/p/itme', pidUrl) === false
  );
  check(
    'WILL follow a genuinely more specific canonical',
    isMoreSpecific('https://www.flipkart.com/ai-pulse-2-blue-64-gb/p/itm9168504534079', pidUrl) === true
  );

  // --- Cuelinks v3 (non-Amazon stores) ---
  mode = 'ok';
  const { convertWithCuelinks, cuelinksConfigured } = require('./lib/cuelinks');
  delete process.env.CUELINKS_API_KEY;
  check('cuelinks disabled without a key', cuelinksConfigured() === false);
  check('cuelinks returns null without a key', (await convertWithCuelinks('https://www.myntra.com/x')) === null);

  process.env.CUELINKS_API_KEY = 'cl_test';
  check('cuelinks enabled with a key', cuelinksConfigured() === true);
  const cl = await convertWithCuelinks('https://www.myntra.com/x');
  check('cuelinks returns the tracking url', Boolean(cl) && cl.link === 'https://linksredirect.com/?cid=456&url=x');
  check('cuelinks reports affiliated', Boolean(cl) && cl.affiliated === true);
  check(
    'cuelinks uses the "Token" auth scheme (not Bearer)',
    calls.some((c) => c.config && c.config.headers && c.config.headers.Authorization === 'Token cl_test')
  );
  check(
    'cuelinks posts to /links/convert',
    calls.some((c) => String(c.url).endsWith('/pub_api/v3/links/convert'))
  );

  // The chain: non-Amazon goes through Cuelinks first.
  const viaCl = await convertAffiliateLink('https://www.myntra.com/some-product/123/buy');
  check('non-Amazon converts via cuelinks', viaCl.ok === true && viaCl.via === 'cuelinks');
  check('converted link is the cuelinks link', viaCl.affiliateUrl === 'https://linksredirect.com/?cid=456&url=x');

  // Amazon must be untouched by any of this.
  const amzKeep = await convertAffiliateLink('https://www.amazon.in/dp/B08N5WRWNW');
  check(
    'Amazon still bypasses cuelinks and keeps its own tag',
    amzKeep.ok === true && !amzKeep.viaConverter && String(amzKeep.affiliateUrl).includes('amazon.in')
  );
  delete process.env.CUELINKS_API_KEY;

  // --- optional search fallback (LangSearch) ---
  mode = 'ok'; // a previous test may have left the mock failing
  const search = require('./lib/search.js');
  delete process.env.LANGSEARCH_API_KEY;
  check('search disabled without a key', search.searchConfigured() === false);
  check('search returns nothing without a key', (await search.webSearch('B0G81TPT89')) .length === 0);
  check('title lookup returns null without a key', (await search.searchProductTitle({ asin: 'B0G81TPT89' })) === null);

  process.env.LANGSEARCH_API_KEY = 'ls_test';
  check('search enabled with a key', search.searchConfigured() === true);
  const results = await search.webSearch('B0G81TPT89 amazon.in', { count: 5, domains: ['amazon.in'] });
  check('search returns results', results.length === 2);
  check(
    'the search request is restricted to amazon.in',
    calls.some((c) => c.body && Array.isArray(c.body.includeDomains) && c.body.includeDomains[0] === 'amazon.in')
  );
  check(
    'snippets are requested by default (cheap in tokens)',
    calls.some((c) => c.url.includes('langsearch') && c.body && !c.body.contents)
  );
  const title = await search.searchProductTitle({ asin: 'B0G81TPT89' });
  check('a category page is skipped in favour of the product', title === 'Samsung Galaxy M17 5G (Moonlight Silver, 6GB RAM, 128GB Storage)');
  check('the trailing ": Amazon.in: Electronics" suffix is stripped', !/: Amazon\.in/i.test(title || ''));
  delete process.env.LANGSEARCH_API_KEY;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
