/**
 * test-amazonapi.js — the hosted Amazon product API routes.
 *
 * This is the LAST fallback: the page is refused, and the metadata service, the
 * reader and the search API have all come back empty. Two providers are
 * supported (RapidAPI, 1,000 free calls/month; Omkar Cloud direct, 100–200), and
 * whichever keys are configured get used. It must stay inert with no keys.
 */
const Module = require('module');
let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) pass++; else { fail++; console.log('  ✗ FAIL: ' + n); } };

let reply = { status: 200, data: null };
const seen = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return {
      get: async (url, opts) => { seen.push({ url, opts }); return reply; },
      post: async () => ({ data: {} }),
    };
  }
  return origLoad.apply(this, arguments);
};
const api = require('./lib/amazonapi.js');
Module._load = origLoad;

const RAPID_PAYLOAD = {
  status: 200,
  data: {
    asin: 'B0G81TPT89',
    title: 'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)',
    price: { amount: 18999, currency: 'INR', list_price: 24999 },
    availability: { text: 'In Stock', is_in_stock: true },
    images: [{ link: 'http://m.media-amazon.com/images/I/x.jpg', variant: 'MAIN' }],
  },
};

// Omkar's own API returns a single object, and may use a different image field.
const OMKAR_PAYLOAD = {
  status: 200,
  data: {
    asin: 'B0G81TPT89',
    title: 'Samsung Galaxy M17 5G',
    price: { amount: 17999, currency: 'INR', list_price: 22999 },
    availability: { is_in_stock: false },
    images: [{ large: 'http://m.media-amazon.com/images/I/y.jpg', variant: null }],
  },
};

(async () => {
  // --- inert without keys -----------------------------------------------------
  delete process.env.RAPIDAPI_KEY;
  delete process.env.OMKAR_API_KEY;
  check('inert without any key', api.amazonApiConfigured() === false);
  check('and returns null without a key', (await api.lookupAsin('B0G81TPT89')) === null);

  // --- RapidAPI ---------------------------------------------------------------
  process.env.RAPIDAPI_KEY = 'rp_test';
  reply = RAPID_PAYLOAD;
  const a = await api.lookupAsin('B0G81TPT89');
  check('RapidAPI: title', a.title === 'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)');
  check('RapidAPI: price', a.price === 18999);
  check('RapidAPI: list price as MRP', a.mrp === 24999);
  check('RapidAPI: stock', a.inStock === true);
  check('RapidAPI: image upgraded to https', a.image === 'https://m.media-amazon.com/images/I/x.jpg');
  check('RapidAPI: key header', seen[seen.length - 1].opts.headers['X-RapidAPI-Key'] === 'rp_test');
  check('RapidAPI: host header', Boolean(seen[seen.length - 1].opts.headers['X-RapidAPI-Host']));
  check('RapidAPI: asks for amazon.in by default', seen[seen.length - 1].opts.params.country === 'IN');
  check('RapidAPI: reports its source', a.source === 'rapidapi');

  // --- Omkar direct (single object, `large` image field) ----------------------
  delete process.env.RAPIDAPI_KEY;
  process.env.OMKAR_API_KEY = 'om_test';
  reply = OMKAR_PAYLOAD;
  const b = await api.lookupAsin('B0G81TPT89');
  check('Omkar: a single object is accepted', b.title === 'Samsung Galaxy M17 5G');
  check('Omkar: price', b.price === 17999);
  check('Omkar: the `large` image field is used', b.image === 'https://m.media-amazon.com/images/I/y.jpg');
  check('Omkar: out of stock', b.inStock === false);
  check('Omkar: key header', seen[seen.length - 1].opts.headers['API-Key'] === 'om_test');
  check('Omkar: country_code param', seen[seen.length - 1].opts.params.country_code === 'IN');
  check('Omkar: reports its source', b.source === 'omkar');

  // --- RapidAPI preferred when both are set ----------------------------------
  process.env.RAPIDAPI_KEY = 'rp_test';
  reply = RAPID_PAYLOAD;
  const c = await api.lookupAsin('B0G81TPT89');
  check('with both keys the larger free tier (RapidAPI) is tried first', c.source === 'rapidapi');

  // --- edge cases -------------------------------------------------------------
  reply = { status: 429, data: { message: 'quota' } };
  check('a quota error yields null, not a crash', (await api.lookupAsin('B0G81TPT89')) === null);

  reply = { status: 200, data: { title: 'X Product 128GB', price: { amount: 999, list_price: 999 } } };
  const flat = await api.lookupAsin('B0G81TPT89');
  check('an MRP equal to the price is dropped', flat.mrp === null);

  reply = { status: 200, data: {} };
  check('an empty payload yields null', (await api.lookupAsin('B0G81TPT89')) === null);

  delete process.env.RAPIDAPI_KEY;
  delete process.env.OMKAR_API_KEY;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
