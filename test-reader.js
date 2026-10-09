/**
 * test-reader.js — the reader-service fallback.
 *
 * Amazon refuses this host, so a reader service (which fetches from its own
 * servers) is the route that can actually see a product page. Its reply begins
 * with a "Title:" line, which is the product name we want.
 */
const Module = require('module');
let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) pass++; else { fail++; console.log('  ✗ FAIL: ' + n); } };

let reply = '';
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return { get: async () => ({ status: 200, data: reply }), post: async () => ({ data: {} }) };
  }
  return origLoad.apply(this, arguments);
};
const reader = require('./lib/reader.js');
Module._load = origLoad;

(async () => {
  reply = 'Title: Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)\n\nURL Source: https://www.amazon.in/dp/B0G81TPT89\n\nMarkdown Content:\nPrice: ₹18,999\n';
  const page = await reader.fetchReadablePage('https://www.amazon.in/dp/B0G81TPT89');
  check('the reader returns a page', Boolean(page));
  check('the Title: line becomes the name',
    page.title === 'Samsung Galaxy M17 5G Mobile (Moonlight Silver, 6GB RAM, 128GB Storage)');
  check('the body text is returned for price extraction', /₹18,999/.test(page.text));

  reply = 'Title: https://www.amazon.in/dp/B0G81TPT89\n\n# Samsung Galaxy M17 5G\n\nsome text here that is long enough to pass the length guard';
  const p2 = await reader.fetchReadablePage('https://www.amazon.in/dp/B0G81TPT89');
  check('a URL echoed as the title is rejected', p2.title === 'Samsung Galaxy M17 5G');

  reply = '';
  const p3 = await reader.fetchReadablePage('https://x.example');
  check('an empty reply yields null', p3 === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
