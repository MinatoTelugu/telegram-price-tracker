/** test-deals.js — mocked test of lib/deals.js + api/deals.js. Working tree only. */
const Module = require('module');

const cardA =
  '<div class="_75nlfW"><a class="CGtC98" href="/foo/p/itmaaaaaaaaaaaa?pid=AAAA1111" title="Printed Georgette Stitched Flared Gown">' +
  '<img class="DByuf4" src="https://img.example/a.jpg"/></a>' +
  '<div class="KzDlHZ">Printed Georgette Stitched Flared Gown</div><div class="Nx9bqj _4b5DiR">\u20B9459</div>' +
  '<div class="yRaY8j">\u20B9999</div></div>';
const cardB =
  '<div class="_75nlfW"><a class="CGtC98" href="/bar/p/itmbbbbbbbbbb?pid=BBBB2222" title="Levis Mens Slim Fit Jeans">' +
  '<img class="DByuf4" src="https://img.example/b.jpg"/></a>' +
  '<div class="KzDlHZ">Levis Mens Slim Fit Jeans</div><div class="Nx9bqj _4b5DiR">\u20B91,059</div>' +
  '<div class="yRaY8j">\u20B91,349</div><div class="UkUFwK">21% off</div></div>';
const HTML = '<html><body>' + cardA + cardB + '</body></html>';

const calls = [];
const axiosMock = {
  get: async () => ({ status: 200, data: HTML, headers: {}, config: {}, request: {} }),
  post: async (url, body) => { calls.push({ url, body }); return { data: { ok: true } }; },
};

const store = new Map();
const firebaseMock = {
  db: {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: store.has(id) }),
        set: async (d) => { store.set(id, d); },
      }),
    }),
  },
  admin: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
  COLLECTIONS: { DEALS_POSTED: 'deals_posted' },
};

const affiliateMock = {
  convertAffiliateLink: async (u) => ({ ok: true, affiliateUrl: u, cleanUrl: u, marketplace: 'flipkart' }),
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return axiosMock;
  if (request.endsWith('lib/firebase')) return firebaseMock;
  if (request.endsWith('lib/affiliate')) return affiliateMock;
  return origLoad.apply(this, arguments);
};

process.env.BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHANNEL_ID = '-1009999999999'; // must win over the default
process.env.DEALS_MIN_DISCOUNT = '50';
process.env.DEALS_MAX_PER_RUN = '5';

const { discoverDeals } = require('./lib/deals.js');
const handler = require('./api/deals.js');

const fakeRes = () => ({ statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } });

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FAIL:', n); } };

(async () => {
  // 1. discovery + filtering
  const deals = await discoverDeals({ minDiscount: 50 });
  check('only the >=50% deal is returned', deals.length === 1);
  check('discount computed from price/MRP', deals[0] && deals[0].discount === 54);
  check('title parsed', deals[0] && deals[0].title === 'Printed Georgette Stitched Flared Gown');
  check('url parsed', deals[0] && deals[0].url === 'https://www.flipkart.com/foo/p/itmaaaaaaaaaaaa');
  check('image parsed', deals[0] && deals[0].imageUrl === 'https://img.example/a.jpg');

  // 2. dry run does not post
  calls.length = 0;
  let res = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1' } }, res);
  let out = JSON.parse(res.body);
  check('dryRun finds the deal', out.ok && out.dryRun === true && out.found === 1);
  check('dryRun posts nothing', calls.length === 0);

  // 3. real run posts to the channel
  calls.length = 0;
  res = fakeRes();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  out = JSON.parse(res.body);
  check('one deal posted', out.postedCount === 1);
  check('response has success:true (for cron-job.org)', out.success === true);
  check('response has deals_posted count', out.deals_posted === 1);
  check('TELEGRAM_CHANNEL_ID is honoured', out.channel === '-1009999999999');
  check('posted to the configured channel', calls.some((c) => String(c.body && c.body.chat_id) === '-1009999999999'));
  check('sent via sendPhoto with image', calls.some((c) => c.url.includes('/sendPhoto') && c.body.photo === 'https://img.example/a.jpg'));
  // Bitly was REMOVED (monthly quota exhausted), so the affiliate link itself is
  // what gets posted — no shortener stands between the reader and the deal.
  // The link lives in the inline BUTTON, not the caption — a raw URL in the body
  // duplicates what the button already carries. Bitly used to be the only thing
  // that put a URL in the caption; with it removed the caption is text only, and
  // that is the intended shape.
  check('no Bitly short link is posted anywhere',
    !calls.some((c) => c.body && /bit\.ly/.test(JSON.stringify(c.body))));
  check('the deal link is carried by the inline button',
    calls.some((c) => c.body && c.body.reply_markup &&
      /itmaaaaaaaaaaaa|flipkart/.test(JSON.stringify(c.body.reply_markup))));
  check('the caption is text only, with no duplicated raw URL',
    calls.every((c) => !c.body || !c.body.caption || !/https?:\/\//.test(String(c.body.caption))));
  check('caption carries title and price', calls.some((c) => c.body && String(c.body.caption).includes('Printed Georgette Stitched Flared Gown') && String(c.body.caption).includes('459')));

  // 4. second run skips the already-posted deal
  calls.length = 0;
  res = fakeRes();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  out = JSON.parse(res.body);
  check('already-posted deal is skipped', out.postedCount === 0 && out.skippedCount === 1 && out.skipped[0].reason === 'already_posted');

  // 5. threshold: 20% default, and a per-run override
  const savedEnv = process.env.DEALS_MIN_DISCOUNT;
  delete process.env.DEALS_MIN_DISCOUNT;
  delete process.env.MIN_DISCOUNT;
  let resDefault = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1' } }, resDefault);
  check('default minDiscount is 20', JSON.parse(resDefault.body).minDiscount === 20);

  let resOverride = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1', minDiscount: '5' } }, resOverride);
  check('?minDiscount=5 overrides the default', JSON.parse(resOverride.body).minDiscount === 5);

  if (savedEnv === undefined) delete process.env.DEALS_MIN_DISCOUNT;
  else process.env.DEALS_MIN_DISCOUNT = savedEnv;

  // 6. discount parsing must not depend on Flipkart's (ever-changing) classes
  const { parseCard } = require('./lib/deals.js');
  const cheerio = require('cheerio');
  const modernCard = cheerio.load(
    '<div><a href="/some-phone/p/itmabcdef?pid=1" title="Some Phone 128 GB">' +
      '<img src="https://img.example/p.jpg" alt="Some Phone 128 GB"/>' +
      '<div class="totally-new-class-2026">Some Phone 128 GB</div>' +
      '<div class="brand-new-price">₹12,999</div>' +
      '<div class="brand-new-mrp">₹29,999</div>' +
      '<div class="some-new-badge">57% off</div></a></div>'
  );
  const card = parseCard(modernCard, modernCard('a[href*="/p/itm"]').first());
  check('parses a card with no legacy classes', Boolean(card));
  check('extracts the discount from card text ("57% off")', card && card.discount === 57);
  check('extracts price from card text', card && card.price === 12999);
  check('extracts mrp from card text', card && card.mrp === 29999);
  check('57% clears a 20% threshold', card && card.discount >= 20);

  // 7. CHANNEL_ID is the primary name and wins over the legacy variables
  process.env.CHANNEL_ID = '-1001234567890';
  let resChan = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1' } }, resChan);
  check('CHANNEL_ID wins over TELEGRAM_CHANNEL_ID', JSON.parse(resChan.body).channel === '-1001234567890');
  delete process.env.CHANNEL_ID;

  resChan = fakeRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1' } }, resChan);
  check('legacy TELEGRAM_CHANNEL_ID still works as a fallback', JSON.parse(resChan.body).channel === '-1009999999999');

  // 8. image extraction must survive lazy-loading
  const lazyCard = cheerio.load(
    '<div><a href="/x/p/itmzzz?pid=9" title="Lazy Phone">' +
      '<img src="data:image/gif;base64,R0lGOD" srcset="https://rukminim1.flixcart.com/a.jpg 1x, https://rukminim1.flixcart.com/b.jpg 2x" alt="Lazy Phone"/>' +
      '<div class="p">₹1,000</div><div class="m">₹2,000</div><div class="d">50% off</div></a></div>'
  );
  const lazy = parseCard(lazyCard, lazyCard('a[href*="/p/itm"]').first());
  check('image is taken from srcset when src is a placeholder', lazy && lazy.imageUrl === 'https://rukminim1.flixcart.com/b.jpg');
  check('data: URIs are never used as an image', lazy && !String(lazy.imageUrl).startsWith('data:'));

  const noImg = cheerio.load(
    '<div><a href="/y/p/itmqqq?pid=8" title="No Pic"><div class="p">₹500</div><div class="m">₹1,000</div><div class="d">50% off</div></a></div>'
  );
  const noImage = parseCard(noImg, noImg('a[href*="/p/itm"]').first());
  check('a card with no image yields a null imageUrl', noImage && noImage.imageUrl === null);

  // 9. product-page price extraction must not depend on CSS classes
  const scraper = require('./lib/scraper.js');
  check(
    'price from JSON-LD offers.price',
    scraper.priceFromJsonLd(
      cheerio.load('<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"18999"}}</script>')
    ) === 18999
  );
  check(
    'price from JSON-LD inside @graph',
    scraper.priceFromJsonLd(
      cheerio.load('<script type="application/ld+json">{"@graph":[{"@type":"Product","offers":[{"price":24999}]}]}</script>')
    ) === 24999
  );
  check(
    'price from meta product:price:amount',
    scraper.priceFromMeta(cheerio.load('<meta property="product:price:amount" content="1,29,999.00">')) === 129999
  );
  check('no price anywhere -> null', scraper.priceFromJsonLd(cheerio.load('<html></html>')) === null);

  // 10. channel poster: dedup fingerprint, gender split, 80/20 ratio
  const fp = require('./api/deals.js').titleFingerprint;
  const gender = require('./api/deals.js').classifyGender;
  const order = require('./api/deals.js').orderForRatio;

  check(
    'word-order/brand variants share a fingerprint',
    fp('Printed Chiffon Women Multicolor Scarf, Stole, Fancy Scarf') ===
      fp('mss FASHION Printed Chiffon Women Scarf Stole Fancy Scarf')
  );
  check('a different product has a different fingerprint',
    fp('Men Slim Mid Rise Grey Jeans') !== fp('Women Wide Leg High Rise Black Jeans'));

  check('classifies menswear', gender("Men Slim Mid Rise Grey Jeans") === 'men');
  check('classifies boys as men', gender('Boys Cotton T-Shirt Pack') === 'men');
  check('classifies womenswear', gender('Women Wide Leg High Rise Black Jeans') === 'women');
  check('classifies girls as women', gender('Girls Floral Frock') === 'women');
  check('unisex/unknown -> null', gender('Bluetooth Earphones with Mic') === null);

  // Start from a history that is OVER its women's quota, and confirm the next
  // picks swing to men instead of another women's item.
  const cands = [];
  for (let i = 0; i < 10; i++) cands.push({ id: 'm' + i, title: 'Men Slim Fit Shirt ' + i });
  for (let i = 0; i < 10; i++) cands.push({ id: 'w' + i, title: 'Women Floral Kurti ' + i });
  const picked = order(cands, { men: 2, women: 8 }, 10);
  const pickedMen = picked.filter((d) => gender(d.title) === 'men').length;
  const pickedWomen = picked.filter((d) => gender(d.title) === 'women').length;
  check('a women-heavy history swings the next run to men', picked[0].id.startsWith('m'));
  check('the run lands near 8 men / 2 women', pickedMen === 8 && pickedWomen === 2);

  // And with a men-heavy history it must not starve women entirely.
  const picked2 = order(cands, { men: 8, women: 2 }, 10);
  check('a men-heavy history still yields 2 women', picked2.filter((d) => gender(d.title) === 'women').length === 2);
  // The ratio is STRICT: an all-women pool must not post ten women's items.
  const allWomen = order(cands.map((d) => ({ id: d.id, title: 'Women Kurti ' + d.id })), { men: 0, women: 0 }, 10);
  check('an all-women pool cannot exceed the women quota', allWomen.length <= 2);

  // ---------------------------------------------------------------------------
// A listing card's text is not a product name. This is from the live log: the
// channel was about to receive "Add to CompareApple iPhone 17 (Black, 256 GB)
// 4.628,706 Ratin" as a product title.
// ---------------------------------------------------------------------------
{
  const deals = require('./lib/deals');
  const cases = [
    ['Add to CompareApple iPhone 17 (Black, 256 GB)4.628,706 Ratin', 'Apple iPhone 17 (Black, 256 GB)'],
    ['Add to CompareHMD Vibe2 5G (Cosmic Lavender, 128 GB)4.55,725', 'HMD Vibe2 5G (Cosmic Lavender, 128 GB)'],
    ['Add to CompareApple iPhone 17 (White, 256 GB)4.628,706 Ratin', 'Apple iPhone 17 (White, 256 GB)'],
    ['Casual Regular Sleeves Embroidered Women Black Top', 'Casual Regular Sleeves Embroidered Women Black Top'],
    ['Pack of 3 Printed Men Trunk', 'Pack of 3 Printed Men Trunk'],
    ['Printed Georgette Stitched Flared/A-line Gown', 'Printed Georgette Stitched Flared/A-line Gown'],
  ];
  for (const [input, want] of cases) {
    const got = deals.cleanDealTitle(input);
    check('cleans: ' + input.slice(0, 40), got === want, JSON.stringify(got));
  }
  check('the "Add to Compare" control never reaches a caption',
    !/add to compare/i.test(deals.cleanDealTitle('Add to CompareApple iPhone 17 (Black, 256 GB)4.628,706 Ratin') || ''));
  check('no trailing rating reaches a caption',
    !/ratin/i.test(deals.cleanDealTitle('Add to CompareApple iPhone 17 (Black, 256 GB)4.628,706 Ratin') || ''));
  check('an empty title yields null', deals.cleanDealTitle('') === null);
}


// ---------------------------------------------------------------------------
// The channel is a FASHION channel. Flipkart's "top offers" page is not, and
// the log showed makeup, mobiles and appliances arriving alongside the clothing.
// ---------------------------------------------------------------------------
{
  const deals = require('./lib/deals');
  const POST = [
    'Casual Regular Sleeves Embroidered Women Black Top',
    'Printed Georgette Stitched Flared/A-line Gown',
    'Nike Revolution Running Shoes',
    'Levis Mens Slim Fit Jeans',
    'Banarasi Silk Saree',
    'Pack of 3 Printed Men Trunk',
    'Mens Slim Fit Casual Shirt',
    'Womens High Rise Skinny Jeans',
    'Puma Unisex Sneakers',
    'Womens Dresses',
    'Mens Formal Shoes',
    // Consumer tech is WANTED now, like mobiles before it. Earbuds moved from
    // the SKIP list to POST for the same reason phones did.
    'Boat Airdopes 141 Bluetooth Earbuds',
    'JBL Flip 6 Bluetooth Speaker',
    'ASUS TUF Gaming Laptop AMD Ryzen 7',
  ];
  const SKIP = [
    ['Maybelline Matte Lipstick Red', 'makeup'],
    ['Prestige Mixer Grinder 750W', 'appliance'],
    // Mobiles are WANTED now — the channel asked for phone deals, so this
    // moved from the SKIP list to the POST list above.
    ['Godrej 190L Refrigerator', 'appliance'],
    ['Milton Water Bottle 1L', 'bottle'],
    ['Wipro Garnet Smart Bulb', 'not fashion'],
    ['Classmate Notebook Pack', 'stationery'],
    ['Bournvita Health Drink', 'grocery'],
    ['Tata Salt 1kg', 'grocery'],
    ['Wildcraft Backpack 30L', 'luggage'],
  ];
  for (const t of POST) {
    check('fashion: POST ' + t.slice(0, 34), deals.fashionCheck(t).ok === true, JSON.stringify(deals.fashionCheck(t)));
  }
  for (const [t, why] of SKIP) {
    const v = deals.fashionCheck(t);
    check('fashion: SKIP ' + t.slice(0, 34) + ' (' + why + ')', v.ok === false, JSON.stringify(v));
  }
  check('an empty title is never posted', deals.fashionCheck('').ok === false);
  // Phones are a category the channel WANTS, including models that never say the
  // word "mobile" — "iQOO Z11 Lite 5G (Solar Flame, 6GB)" — which is why the phone
  // brands are recognised as well.
  check('a phone with no category word is still POSTED',
    deals.fashionCheck('iQOO Z11 Lite 5G (Solar Flame, 6GB)').ok === true);
  check('...and so is a phone named by brand',
    deals.fashionCheck('Nothing Phone 3a').ok === true);
}


// ---------------------------------------------------------------------------
// From the live log: a women's kaftan was dropped as "not_fashion:unrecognised",
// and every FASHION deal logged image=NONE while phone deals had images. The
// fashion cards lazy-load through srcset/data-src on a bare <img>; only the
// phone-card classes were listed.
// ---------------------------------------------------------------------------
{
  const d = require(__dirname + '/lib/deals.js');
  const f = d.fashionCheck;
  check('a women\'s kaftan is fashion', !!(f('Self Design Cotton Blend Women Kaftan') || {}).ok);
  check('an anarkali suit is fashion', !!(f('Anarkali Suit Set') || {}).ok);
  check('a curtain is still blocked', !((f('153 cm Window Polyester Curtain') || {}).ok));
  check('a laptop backpack is still blocked', !((f('Large 60 L Laptop Backpack') || {}).ok));
  check('a nail polish is still blocked', !((f('Gloss Gel High Shine Nail Polish') || {}).ok));
  check('a phone is still allowed', !!(f('Samsung Galaxy F07 (Green, 64 GB)') || {}).ok);

  const src = fs.readFileSync(__dirname + '/lib/deals.js', 'utf8');
  check('fashion cards\' lazy images are matched', /'img\[srcset\]'/.test(src) && /'img\[data-src\]'/.test(src));
  check('...and placeholders are still rejected', /if \(\/\^data:\/i\.test\(v\)\) continue;/.test(src));
}

// ---------------------------------------------------------------------------
// From the live log: "fashion filter dropped 20 of 20 — e.g. Fire-Boltt Ninja
// Blaze ... (not_fashion:smartwatch)". The bot was FETCHING a smartwatch listing
// page (q=smartwatch is in the source list) and dropping every card on it, so it
// paid for deals it had already decided to throw away and the channel saw
// nothing.
//
// The cause was not the smartwatch word alone. One of those titles reads
// "Built-in Games Smartwatch", and the blocklist holds 'game' — a single
// incidental word rejecting a whole product. A title naming consumer tech IS a
// tech deal, whatever else it mentions.
// ---------------------------------------------------------------------------
{
  const d = require(__dirname + '/lib/deals.js');
  const f = d.fashionCheck;
  const ok = (t) => !!(f(t) || {}).ok;

  check('a smartwatch is a deal', ok('TECHIO H9 PRO MAX SMART WATCH. Smartwatch'));
  check('...even when the title mentions games',
    ok('Fire-Boltt Ninja Blaze 1.83 HD Display Stainless Steel Built-in Games Smartwatch'));
  check('earbuds are a deal', ok('boAt Airdopes 141 TWS Earbuds'));
  check('a speaker is a deal', ok('JBL Flip 6 Bluetooth Speaker'));
  check('a laptop is a deal', ok('ASUS TUF Gaming Laptop AMD Ryzen 7'));
  check('...even a GAMING one, which the word "game" used to reject', ok('Gaming Mouse RGB'));
  check('a monitor is a deal', ok('GEONIX 22-Inch FHD IPS 75Hz Monitor'));
  check('a phone is still a deal', ok('Samsung Galaxy M17 5G Mobile'));

  check('a curtain is still dropped', !ok('153 cm Window Polyester Curtain'));
  check('a study table is still dropped', !ok('Callas ST-40 Wooden Study Table'));
  check('nail polish is still dropped', !ok('Gloss Gel High Shine Nail Polish'));
  check('a suitcase is still dropped', !ok('Safari Magnum Suitcase'));
  check('a dress is still a deal', ok('Printed Georgette Stitched Flared Gown'));

  const src = fs.readFileSync(__dirname + '/lib/deals.js', 'utf8');
  check('tech is checked BEFORE the blocklist', src.indexOf('const tech = TECH.find') < src.indexOf('const blocked = NOT_FASHION.find'));
  check('the blocklist no longer holds smartwatch', !/'smartwatch'/.test(src.split('const FASHION')[0]));
  check('a tech allowlist exists', /const TECH = \[/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();