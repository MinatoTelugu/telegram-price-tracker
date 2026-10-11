/**
 * Bright Data as a structured source for BOTH stores.
 *
 * Run: node test-brightdata.js
 */
const Module = require('module');
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

let seen = [];
let reply = { status: 200, data: [] };
const origLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith('httpAgent')) return {};
  if (request === 'axios') {
    return { post: async (url, body, opts) => { seen.push({ url, body, opts }); return reply; },
             get: async () => ({ status: 200, data: '' }) };
  }
  return origLoad.apply(this, arguments);
};

const bd = require('./lib/brightdata');

(async () => {
  console.log('--- inert without a key ---');
  delete process.env.BRIGHTDATA_API_KEY;
  check('not configured', bd.brightDataConfigured() === false);
  seen = [];
  check('no request is made', (await bd.lookupBrightData({ url: 'https://www.amazon.in/dp/B0G81TPT89', marketplace: 'amazon' })) === null);
  check('...and nothing was sent', seen.length === 0);

  console.log('--- Amazon: one Bearer key, structured fields ---');
  process.env.BRIGHTDATA_API_KEY = 'bd_key';
  reply = { status: 200, data: [{ title: 'iQOO Z11 Lite 5G', asin: 'B0H1WX51F1', initial_price: 38499, final_price: 22499, currency: 'INR', availability: 'In Stock' }] };
  seen = [];
  const a = await bd.lookupBrightData({ url: 'https://www.amazon.in/dp/B0H1WX51F1', marketplace: 'amazon' });
  check('the endpoint is the datasets scrape', /api\.brightdata\.com\/datasets\/v3\/scrape/.test(seen[0].url));
  check('authentication is a Bearer key', seen[0].opts.headers.Authorization === 'Bearer bd_key');
  check('...and NOT Basic', !/^Basic/.test(seen[0].opts.headers.Authorization));
  check('the Amazon products dataset is used', seen[0].opts.params.dataset_id === 'gd_l7q7dkf244hwjntr0');
  check('the url is passed as input', seen[0].body[0].url === 'https://www.amazon.in/dp/B0H1WX51F1');
  check('final_price is the price', a.price === 22499);
  check('initial_price is the M.R.P.', a.mrp === 38499);
  check('availability reads as in stock', a.inStock === true);
  check('the title is carried', a.title === 'iQOO Z11 Lite 5G');

  console.log('--- Flipkart: a dedicated scraper too, which Oxylabs lacks ---');
  process.env.BRIGHTDATA_FLIPKART_DATASET = 'gd_flipkart_test';
  reply = { status: 200, data: [{ name: 'TATSAM Digital Blue Clock', price: 499, original_price: 1299, currency: 'INR', availability: 'In stock' }] };
  seen = [];
  const f = await bd.lookupBrightData({ url: 'https://www.flipkart.com/x/p/itmabc', marketplace: 'flipkart' });
  check('the Flipkart dataset is used', seen[0].opts.params.dataset_id === 'gd_flipkart_test');
  check('Flipkart price reads', f.price === 499);
  check('Flipkart M.R.P. reads', f.mrp === 1299);
  check('Flipkart stock reads', f.inStock === true);
  delete process.env.BRIGHTDATA_FLIPKART_DATASET;
  reply = { status: 200, data: [] };
  check('with no Flipkart dataset configured it declines rather than guessing',
    (await bd.lookupBrightData({ url: 'https://www.flipkart.com/x/p/itmabc', marketplace: 'flipkart' })) === null);

  console.log('--- the equality trap, and stock wording ---');
  check('a price equal to the M.R.P. is refused',
    bd.normalise({ title: 'X', final_price: 40999, initial_price: 40999 }).price === null);
  check('a real price survives', bd.normalise({ title: 'X', final_price: 28998, initial_price: 40999 }).price === 28998);
  check('"Only 2 left in stock" is in stock', bd.stockFromText('Only 2 left in stock (more on the way).') === true);
  check('"Temporarily out of stock" is not', bd.stockFromText('Temporarily out of stock.') === false);
  check('no wording yields null', bd.stockFromText('') === null);
  check('is_available is used when availability is absent',
    bd.normalise({ title: 'X', is_available: true }).inStock === true);

  console.log('--- failure modes are reported, not thrown ---');
  reply = { status: 401, data: { error: 'unauthorized' } };
  check('401 yields null', (await bd.lookupBrightData({ url: 'https://www.amazon.in/dp/B0H1WX51F1', marketplace: 'amazon' })) === null);
  reply = { status: 202, data: { snapshot_id: 's1' } };
  check('202 (still collecting) yields null rather than blocking', (await bd.lookupBrightData({ url: 'https://www.amazon.in/dp/B0H1WX51F1', marketplace: 'amazon' })) === null);

  console.log('--- the scraper tries Bright Data BEFORE Oxylabs ---');
  const src = require('fs').readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  check('the scraper imports it', /require\('\.\/brightdata'\)/.test(src));
  check('...and consults it first', src.indexOf('brightDataConfigured()') < src.indexOf('oxylabsConfigured()'));
  check('...marking the price as stated, not guessed', /source: 'brightdata'/.test(src));

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
