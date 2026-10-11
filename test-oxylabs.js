/**
 * Oxylabs as the primary provider.
 *
 * The point of this suite is that Oxylabs' Amazon source is a DEDICATED PARSER,
 * not a text scan: price_buybox is the buy box as a FIELD, so it cannot wander
 * onto a recommendation carousel the way "the first rupee figure" did.
 *
 * Run: node test-oxylabs.js
 */
const axios = require('axios');
const Module = require('module');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

// Intercept axios so no request leaves the sandbox.
let seen = [];
let reply = { status: 200, data: { results: [{ content: {} }] } };
const origLoad = Module._load;
Module._load = function (request) {
  // httpAgent patches the real axios (it sets a keep-alive agent), so it must be
  // stubbed too — otherwise it loads the genuine module and the mock is bypassed.
  if (request.endsWith('httpAgent')) return {};
  if (request === 'axios') {
    return {
      post: async (url, body, opts) => { seen.push({ url, body, opts }); return reply; },
      get: async () => ({ status: 200, data: '' }),
    };
  }
  return origLoad.apply(this, arguments);
};

const oxy = require('./lib/oxylabs');

/** The shape Oxylabs' amazon_product parser returns for a real buy box. */
const AMAZON_OK = {
  status: 200,
  data: {
  results: [{
    content: {
      asin: 'B0G81TPT89',
      title: 'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)',
      product_name: 'Samsung Galaxy M17 5G Mobile',
      price: 21999,
      price_buybox: 21999,
      price_initial: 23999,
      price_upper: 23999,
      currency: 'INR',
      stock: 'In stock.',
      buybox: [{ offer_listing_id: null, price: 21999, stock: 'In stock.' }],
      images: ['http://m.media-amazon.com/images/I/71x.jpg'],
    },
    status_code: 200,
    parse_status_code: 12000,
  }],
  },
};

(async () => {
  console.log('--- inert without credentials ---');
  delete process.env.OXYLABS_USERNAME;
  delete process.env.OXYLABS_PASSWORD;
  check('not configured with no credentials', oxy.oxylabsConfigured() === false);
  seen = [];
  check('and performs no request', (await oxy.lookupOxylabs({ url: 'https://www.amazon.in/dp/B0G81TPT89', marketplace: 'amazon' })) === null);
  check('...and nothing was sent', seen.length === 0);

  console.log('--- Amazon: the buy box, as structured fields ---');
  process.env.OXYLABS_USERNAME = 'oxy_user';
  process.env.OXYLABS_PASSWORD = 'oxy_pass';
  check('configured with username + password', oxy.oxylabsConfigured() === true);

  reply = AMAZON_OK;
  seen = [];
  const a = await oxy.lookupOxylabs({ url: 'https://www.amazon.in/dp/B0G81TPT89', marketplace: 'amazon' });

  check('the source is amazon_product', seen[0].body.source === 'amazon_product');
  check('the ASIN is passed as the query', seen[0].body.query === 'B0G81TPT89');
  check('parsing is requested', seen[0].body.parse === true);
  check('the location is India by default', seen[0].body.geo_location === 'India');
  check('authentication is HTTP Basic, not a bare key',
    seen[0].opts.headers.Authorization === 'Basic ' + Buffer.from('oxy_user:oxy_pass').toString('base64'));
  check('the price is the BUY-BOX price', a.price === 21999);
  check('the MRP comes from price_initial', a.mrp === 23999);
  check('stock is read as in stock', a.inStock === true);
  check('the title is carried through', /Samsung Galaxy M17 5G/.test(a.title));
  check('the image is upgraded to https', a.image === 'https://m.media-amazon.com/images/I/71x.jpg');
  check('the source is recorded', a.source === 'oxylabs');

  console.log('--- the sentinel and the fallbacks ---');
  // The parser uses -1 when there is no buy-box price at all.
  const sentinel = oxy.fromAmazonContent({ price: -1, price_buybox: -1, price_initial: 0, stock: 'Currently unavailable.', title: 'X' });
  check('a -1 price is treated as "none", not as a price', sentinel.price === null);
  check('...and the stock still reads correctly', sentinel.inStock === false);

  // price_buybox missing: fall back to price, then to buybox[].
  const viaPrice = oxy.fromAmazonContent({ price: 18999, price_initial: 22999, stock: 'In stock.' });
  check('price is the fallback when price_buybox is absent', viaPrice.price === 18999);
  const viaArray = oxy.fromAmazonContent({ buybox: [{ price: 17500, stock: 'In stock.' }] });
  check('the buybox array is the last fallback', viaArray.price === 17500);

  check('an MRP below the price is dropped',
    oxy.fromAmazonContent({ price: 21999, price_initial: 20000 }).mrp === null);
  check('an empty payload yields null', oxy.fromAmazonContent({}) === null);

  console.log('--- a text scan is NOT used, so a carousel cannot win ---');
  // The real trap: a page whose FIRST rupee figure belongs to another product.
  // The parser gives us price_buybox regardless of what else is on the page.
  const withCarouselNoise = oxy.fromAmazonContent({
    price_buybox: 21999, price: 21999, price_initial: 23999, stock: 'In stock.',
  });
  check('the carousel cannot influence the price — there is no scan to fool',
    withCarouselNoise.price === 21999);

  console.log('--- a non-200 is reported, not thrown ---');
  reply = { status: 401, data: { message: 'Unauthorized' } };
  check('an auth failure yields null', (await oxy.lookupOxylabs({ url: 'https://www.amazon.in/dp/B0G81TPT89', marketplace: 'amazon' })) === null);
  reply = { status: 200, data: { results: [] } };
  check('an empty results array yields null', (await oxy.lookupOxylabs({ url: 'https://www.amazon.in/dp/B0G81TPT89', marketplace: 'amazon' })) === null);

  console.log('--- Flipkart has NO dedicated parser, so HTML is parsed locally ---');
  reply = { status: 200, data: { results: [{ content: '<html><body>' + 'x'.repeat(600) + '</body></html>' }] } };
  seen = [];
  const fk = await oxy.lookupOxylabs({ url: 'https://www.flipkart.com/p/itmabc', marketplace: 'flipkart' });
  check('the flipkart source is used with a url', seen[0].body.source === 'flipkart' && seen[0].body.url === 'https://www.flipkart.com/p/itmabc');
  check('rendering is requested', seen[0].body.render === 'html');
  check('the HTML is handed back for our own parser', typeof fk.html === 'string' && fk.html.length > 500);

  console.log('--- the scraper tries Oxylabs FIRST ---');
  const src = require('fs').readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the scraper imports the Oxylabs module', /require\('\.\/oxylabs'\)/.test(src));
  check('...and consults it before building the direct attempts',
    src.indexOf('oxylabsConfigured()') < src.indexOf('const attempts = ['));
  check('the Amazon result is returned straight away', /source: 'oxylabs'/.test(src));
  check('...and marked as a price the page stated, not a guess',
    /priceKind: 'api',\s*\n\s*guess: false/.test(src));
  check('the Flipkart HTML becomes a pre-fetched first attempt', /oxylabsHtml/.test(src));
  check('...parsed with the same buy-box-scoped reader', /firstBuyboxText\(\$oxy, cfg\.price\)/.test(src));
  check('an implausible Oxylabs price is rejected, not trusted', /ignored the Oxylabs price of/.test(src));

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
