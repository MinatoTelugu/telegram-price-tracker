/**
 * test-reader.js
 * ---------------------------------------------------------------------------
 * The reader services, and the HTML stripping the generic ones need.
 *
 * Reported: a Flipkart product showed "—" for every price, STOCK UNKNOWN,
 * "Updated: not yet checked" and PRICE READINGS: 0. That is not a rendering
 * fault — no price was ever fetched. For Flipkart there is no hosted API, so the
 * reader is the ONLY route that can reach a page the store refuses us directly,
 * and it was a single service answering "empty body".
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const reader = require('./lib/reader.js');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const src = fs.readFileSync(path.join(__dirname, 'lib/reader.js'), 'utf8');
const svcs = reader.readerServices();

check('more than one reader service exists', svcs.length >= 2, 'got ' + svcs.length);
check('...Jina is still first', svcs[0].name === 'jina');
check('...and there is a keyless proxy behind it', svcs.some((s) => s.name !== 'jina'));
check('...all of them are free endpoints, no keys',
  svcs.every((s) => /^https:\/\//.test(s.url('https://example.com')) && !/key=|token=|api_key/i.test(s.url('https://example.com'))));
check('a custom READER_API_URL pins a single service',
  (function () {
    const before = process.env.READER_API_URL;
    process.env.READER_API_URL = 'https://my.reader/';
    const one = reader.readerServices();
    if (before === undefined) delete process.env.READER_API_URL; else process.env.READER_API_URL = before;
    return one.length === 1 && one[0].name === 'custom';
  })());
check('the loop walks every service, not just the first',
  /for \(const svc of services\)/.test(src));
check('...and does not give up after one empty body',
  /svc\.name !== 'jina'\) console\.log\('reader: text came from/.test(src));

// The HTML stripping, which the generic proxies require.
const html = [
  '<html><head><style>.x{color:red}</style>',
  '<script>var price=999999;</script></head>',
  '<body><div>Samsung Galaxy M17 5G</div>',
  '<div><span>\u20b919,130</span></div>',
  '<div>M.R.P.: \u20b924,500</div></body></html>',
].join('');
const text = reader.htmlToText(html);
check('script contents are removed', !text.includes('999999'));
check('style contents are removed', !text.includes('color:red'));
check('the visible text survives', text.includes('Samsung Galaxy M17 5G'));
check('the rupee figure survives', text.includes('19,130'));
check('...and the price parser can read it',
  (function () {
    const { priceFromTextMatch } = require('./lib/scraper.js');
    const m = priceFromTextMatch(text);
    return m && m.price === 19130;
  })());
check('entities are decoded', reader.htmlToText('<div>&#8377;99 &amp; up</div>').includes('\u20b9'));
check('block elements become newlines, so clauses split',
  reader.htmlToText('<div>a</div><div>b</div>').split('\n').length >= 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
