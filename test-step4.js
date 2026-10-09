/** test-step4.js — mocked test of api/cron.js. Working tree only. */
const Module = require('module');

const calls = { messages: [], history: [], sets: [] };

function makeProductDoc(id, data) {
  const store = Object.assign({}, data);
  const ref = {
    set: async (d) => { calls.sets.push({ id, d }); Object.assign(store, d); },
    collection: () => ({
      add: async (d) => { calls.history.push({ id, d }); },
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [], size: 0 }) }) }),
    }),
  };
  return { id, data: () => store, ref };
}

let productDocs = [];
const db = {
  collection: () => ({
    where: () => ({ limit: () => ({ get: async () => ({ empty: false, docs: productDocs, size: productDocs.length }) }) }),
    // The scan now reads a page directly (no where clause), so the mock needs
    // limit()/get() at the collection level too.
    limit: () => ({ get: async () => ({ empty: productDocs.length === 0, docs: productDocs, size: productDocs.length }) }),
    get: async () => ({ empty: productDocs.length === 0, docs: productDocs, size: productDocs.length }),
    doc: (id) => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
  }),
  batch: () => ({ delete() {}, commit: async () => {} }),
};

const firebaseMock = { db, admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }, COLLECTIONS: { PRODUCTS: 'products', PRICE_HISTORY: 'price_history' } };

let scrapeResult = { ok: true, price: 900, currency: 'INR', title: 'Test Item', imageUrl: null };
const scraperMock = { fetchProduct: async () => scrapeResult };

let sendFailures = 0; // fail this many sends before succeeding
const axiosMock = {
  post: async (url, body) => {
    if (url.includes('/sendMessage')) {
      if (sendFailures > 0) {
        sendFailures--;
        const err = new Error('Request failed with status code 429');
        err.response = { status: 429, data: { parameters: { retry_after: 0 } } };
        throw err;
      }
      calls.messages.push(body);
    }
    return { data: { ok: true } };
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return axiosMock;
  if (request === '../lib/firebase' || request.endsWith('/lib/firebase')) return firebaseMock;
  if (request === '../lib/scraper' || request.endsWith('/lib/scraper')) return scraperMock;
  return origLoad.apply(this, arguments);
};

process.env.BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'sekret';
process.env.PRICE_DROP_THRESHOLD_PERCENT = '1';

const handler = require('./api/cron.js');
const fakeRes = () => ({ statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n); } };

(async () => {
  // 1. auth
  productDocs = [];
  let res = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' }, query: {} }, res);
  check('wrong cron secret -> 401', res.statusCode === 401);

  // 2. price drop -> alerts to both subscribers + history + update
  calls.messages.length = 0; calls.history.length = 0; calls.sets.length = 0;
  productDocs = [makeProductDoc('amazon_B0TEST', {
    marketplace: 'amazon', cleanUrl: 'https://www.amazon.in/dp/B0TEST', lastPrice: 1000,
    subscribers: ['111', '222'], title: 'Test Item', active: true, lastCheckedAt: null,
  })];
  res = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, res);
  const out = JSON.parse(res.body);
  check('summary ok + processed 1', out.ok === true && out.processed === 1);
  check('price drop detected', out.results[0].oldPrice === 1000 && out.results[0].price === 900);
  check('alert sent to 2 subscribers', out.alertsSent === 2 && calls.messages.length === 2);
  check('alert text mentions both prices', calls.messages[0].text.includes('1000') && calls.messages[0].text.includes('900'));
  check('history point appended', calls.history.length === 1 && calls.history[0].d.price === 900);
  check('product doc updated to new price', calls.sets.some((s) => s.d.lastPrice === 900));

  // 3. price RISE -> increase alert (rises now alert too)
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 1500, currency: 'INR', title: 'Test Item', imageUrl: null };
  productDocs = [makeProductDoc('amazon_B0TEST', {
    marketplace: 'amazon', cleanUrl: 'https://www.amazon.in/dp/B0TEST', lastPrice: 1000,
    subscribers: ['111'], title: 'Test Item', active: true, lastCheckedAt: null,
  })];
  res = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, res);
  check('price rise -> increase alert', JSON.parse(res.body).alertsSent === 1);
  check('increase alert says "PRICE INCREASE ALERT"', calls.messages.some((m) => String(m.text).includes('PRICE INCREASE ALERT')));

  // 4. blocked page -> skipped, error recorded
  calls.sets.length = 0;
  scrapeResult = { ok: false, reason: 'blocked' };
  productDocs = [makeProductDoc('amazon_B0TEST', {
    marketplace: 'amazon', cleanUrl: 'https://www.amazon.in/dp/B0TEST', lastPrice: 1000,
    subscribers: ['111'], active: true, lastCheckedAt: null,
  })];
  res = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, res);
  const o4 = JSON.parse(res.body);
  check('blocked product skipped', o4.skipped === 1 && o4.results[0].reason === 'blocked');
  check('skip records lastCheckError', calls.sets.some((s) => s.d.lastCheckError === 'blocked'));

  // 5. query-string key also authorizes
  productDocs = [];
  res = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { key: 'sekret' } }, res);
  check('?key= authorizes', res.statusCode === 200);

  // 5. back in stock -> alert on the TRANSITION only
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 29999, currency: 'INR', title: 'IQOO Z9s 5G', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_IQOOZ9S', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmabc', lastPrice: 29999,
    subscribers: ['111'], title: 'IQOO Z9s 5G', active: true, lastCheckedAt: null, inStock: false,
  })];
  let resStock = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resStock);
  check('out-of-stock -> in-stock sends an alert', JSON.parse(resStock.body).alertsSent === 1);
  check(
    'restock alert says "BACK IN STOCK ALERT"',
    calls.messages.some((m) => String(m.text).includes('BACK IN STOCK ALERT'))
  );
  check(
    'restock alert mentions it was previously out of stock',
    calls.messages.some((m) => String(m.text).includes('Previously Out of Stock'))
  );
  check('product doc records the new stock state', calls.sets.some((s) => s.d.inStock === true));

  // Already in stock -> no repeat alert.
  calls.messages.length = 0;
  productDocs = [makeProductDoc('flipkart_IQOOZ9S', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmabc', lastPrice: 29999,
    subscribers: ['111'], title: 'IQOO Z9s 5G', active: true, lastCheckedAt: null, inStock: true,
  })];
  resStock = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resStock);
  check('no repeat restock alert when it was already in stock', JSON.parse(resStock.body).alertsSent === 0);

  // 6. out-of-stock must RECORD the stock state even with no price, so the
  //    later restock transition can be detected at all.
  calls.sets.length = 0;
  calls.messages.length = 0;
  scrapeResult = { ok: false, reason: 'price_not_found', inStock: false, title: 'IQOO Z9s 5G' };
  productDocs = [makeProductDoc('flipkart_IQOOZ9S', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmabc', lastPrice: 18999,
    subscribers: ['111'], title: 'IQOO Z9s 5G', active: true, lastCheckedAt: null,
  })];
  let resOut = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resOut);
  check('out-of-stock skip records inStock=false', calls.sets.some((s) => s.d.inStock === false));

  // ...and the NEXT run, when it is back in stock with a price, must alert.
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 18999, currency: 'INR', title: 'IQOO Z9s 5G', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_IQOOZ9S', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmabc', lastPrice: 18999,
    subscribers: ['111'], title: 'IQOO Z9s 5G', active: true, lastCheckedAt: null, inStock: false,
  })];
  let resBack = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resBack);
  check('the restock alert fires after an out-of-stock record', JSON.parse(resBack.body).alertsSent === 1);
  check(
    'restock alert carries the product and the new price',
    calls.messages.some((m) => String(m.text).includes('BACK IN STOCK ALERT') && String(m.text).includes('18999'))
  );

  // 7. a product with NO `active` field must still be checked (the old query
  //    filtered on active == true and silently found nothing).
  calls.sets.length = 0;
  scrapeResult = { ok: true, price: 900, currency: 'INR', title: 'Legacy Item', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_LEGACY1', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmlegacy', lastPrice: 1000,
    subscribers: ['111'], title: 'Legacy Item', lastCheckedAt: null,
    // note: NO `active` field at all
  })];
  let resLegacy = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resLegacy);
  const legacyBody = JSON.parse(resLegacy.body);
  check('a product with no active field is still scanned', legacyBody.scanned === 1);
  check('and it is actually checked', legacyBody.checked === 1);
  check('and its drop alert fires', legacyBody.alertsSent === 1);

  // An explicitly stopped product must NOT be checked.
  productDocs = [makeProductDoc('flipkart_STOPPED1', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmstop', lastPrice: 1000,
    subscribers: [], title: 'Stopped', lastCheckedAt: null, active: false,
  })];
  let resStopped = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resStopped);
  check('an explicitly stopped product is skipped', JSON.parse(resStopped.body).scanned === 0);

  // 8. CRON_SECRET must not lock out our own internal callers.
  process.env.CRON_SECRET = 'topsecret';
  productDocs = [makeProductDoc('flipkart_AUTH1', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmauth', lastPrice: 1000,
    subscribers: ['111'], title: 'Auth Item', active: true, lastCheckedAt: null,
  })];
  scrapeResult = { ok: true, price: 1000, currency: 'INR', title: 'Auth Item', imageUrl: null, inStock: true };

  let resNoAuth = fakeRes();
  await handler({ method: 'GET', headers: {}, query: {} }, resNoAuth);
  check('no auth -> 401', resNoAuth.statusCode === 401);

  let resAuth = fakeRes();
  await handler(
    { method: 'GET', headers: { authorization: 'Bearer topsecret' }, query: {} },
    resAuth
  );
  const authBody = JSON.parse(resAuth.body);
  check('with the secret -> ok', authBody.ok === true);
  check('with the secret -> products are actually scanned', authBody.scanned === 1);
  delete process.env.CRON_SECRET;

  // 9. Flipkart app share links are recognised so they can be expanded
  const isShort = require('./api/cron.js').isFlipkartShortLink;
  check('dl.flipkart.com/s/ is a short link', isShort('https://dl.flipkart.com/s/1U0FmLNNNN') === true);
  check('fkrt.cc is a short link', isShort('https://fkrt.cc/abc123') === true);
  check('fkrt.it is a short link', isShort('https://fkrt.it/abc123') === true);
  check('flipkart.com/s/ is a short link', isShort('https://www.flipkart.com/s/AbC123') === true);
  check('a canonical product url is NOT a short link', isShort('https://www.flipkart.com/ai-pulse-2-blue-64-gb/p/itm9168504534079') === false);

  // 10. EVERY alert must carry the four action buttons.
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 900, currency: 'INR', title: 'Drop Item', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_BTN1', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmbtn',
    affiliateUrl: 'https://fkrt.clnk.in/ABC', lastPrice: 1000, subscribers: ['111'],
    title: 'Drop Item', active: true, lastCheckedAt: null,
  })];
  let resBtn = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resBtn);
  const alertMsg = calls.messages[0] || {};
  const kb = JSON.stringify(alertMsg.reply_markup || {});
  check('price-drop alert carries a keyboard', Boolean(alertMsg.reply_markup));
  check('alert button: Buy Now (affiliate url)', kb.includes('Buy Now') && kb.includes('https://fkrt.clnk.in/ABC'));
  check('alert button: Stop Tracking', kb.includes('Stop Tracking') && kb.includes('untrack:flipkart_BTN1'));
  check(
    'alert button: Price History opens the web chart',
    kb.includes('Price History') && kb.includes('/?id=flipkart_BTN1')
  );
  check('the chart link has a real web base', kb.includes('https://aipricealertbot.koyeb.app/?id='));
  check("alert button: Today's Deals", kb.includes("Today's Deals"));

  // Restock alerts must carry it too.
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 18999, currency: 'INR', title: 'Back Item', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_BTN2', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmbtn2',
    affiliateUrl: 'https://fkrt.clnk.in/XYZ', lastPrice: 18999, subscribers: ['111'],
    title: 'Back Item', active: true, lastCheckedAt: null, inStock: false,
  })];
  let resBtn2 = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resBtn2);
  check('restock alert carries the same keyboard', Boolean((calls.messages[0] || {}).reply_markup));
  check(
    'restock keyboard has all four actions',
    (function () {
      const k = JSON.stringify((calls.messages[0] || {}).reply_markup || {});
      return k.includes('Buy Now') && k.includes('Stop Tracking') && k.includes('Price History') && k.includes("Today's Deals");
    })()
  );

  // A product with NO affiliate url still gets all four (Buy falls back to the clean url).
  const { alertKeyboard } = require('./api/cron.js');
  const kbNoAff = JSON.stringify(alertKeyboard('flipkart_BTN3', { cleanUrl: 'https://www.flipkart.com/x/p/itmbtn3' }));
  check('no affiliate link -> Buy Now still present (clean url)', kbNoAff.includes('Buy Now') && kbNoAff.includes('https://www.flipkart.com/x/p/itmbtn3'));
  check('no affiliate link -> still four actions', kbNoAff.includes('Stop Tracking') && kbNoAff.includes('Price History') && kbNoAff.includes("Today's Deals"));

  // 11. Alert DELIVERY: a transient failure must not cost the user their alert.
  calls.messages.length = 0;
  scrapeResult = { ok: true, price: 900, currency: 'INR', title: 'Drop Item', imageUrl: null, inStock: true };
  productDocs = [makeProductDoc('flipkart_RETRY1', {
    marketplace: 'flipkart', cleanUrl: 'https://www.flipkart.com/x/p/itmretry',
    affiliateUrl: 'https://fkrt.clnk.in/R', lastPrice: 1000, subscribers: ['111'],
    title: 'Drop Item', active: true, lastCheckedAt: null,
  })];

  sendFailures = 1; // one transient failure, then success
  let resRetry = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resRetry);
  check('a transient send failure is retried and the alert lands', JSON.parse(resRetry.body).alertsSent === 1);
  check('the retried alert reached the subscriber', calls.messages.length === 1);

  // A hard failure (blocked bot) must be given up on, not retried forever.
  calls.messages.length = 0;
  sendFailures = 99;
  let resDead = fakeRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer sekret' }, query: {} }, resDead);
  check('a permanently failing send is reported, not counted as sent', JSON.parse(resDead.body).alertsSent === 0);
  sendFailures = 0;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
