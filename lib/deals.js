/**
 * lib/deals.js
 * ---------------------------------------------------------------------------
 * Discover current deals by scraping Flipkart search/listing pages — free, no
 * API key. Flipkart is far more permissive than Amazon for this.
 *
 * For each product card we read the title, price, MRP, image and link, then
 * compute the discount OURSELVES from price vs MRP. That is more reliable than
 * trusting the "N% off" label, which is often absent.
 *
 * Source pages are configurable via DEALS_SOURCE_URLS (comma-separated) so the
 * categories can be tuned without touching code.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { parsePrice } = require('./scraper');
const { categoryFromTitle, sourcesForCategory } = require('./category');

const REQUEST_TIMEOUT = 8000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  Referer: 'https://www.flipkart.com/',
};

/**
 * The listing pages scraped when DEALS_SOURCE_URLS is not set.
 *
 * ORDER IS PRIORITY, not decoration: the run takes DEALS_MAX_PER_RUN items from
 * everything it finds, sorted by discount, so a category with more source pages
 * contributes more deals. Electronics and phones were one line out of three,
 * which is why the channel read as a fashion feed with the occasional phone —
 * the fashion pages simply had twice the representation. They now lead, and
 * there are more of them.
 */
const DEFAULT_SOURCES = [
  // Electronics and phones first — the highest-demand categories.
  'https://www.flipkart.com/search?q=mobile&sort=popularity',
  'https://www.flipkart.com/search?q=smartphone%20under%2015000&sort=popularity',
  'https://www.flipkart.com/search?q=5g%20mobile&sort=popularity',
  'https://www.flipkart.com/search?q=laptop&sort=popularity',
  'https://www.flipkart.com/search?q=earbuds&sort=popularity',
  'https://www.flipkart.com/search?q=smartwatch&sort=popularity',
  'https://www.flipkart.com/search?q=smart%20tv&sort=popularity',
  // Then fashion, which the channel also wants.
  'https://www.flipkart.com/search?q=fashion%20sale&sort=popularity',
  'https://www.flipkart.com/search?q=top%20offers&sort=popularity',
];

// Flipkart changes class names over time, so each field lists fallbacks.
const CARD_SELECTORS = ['div._75nlfW', 'div.tUxRFH', 'div._1AtVbE', 'div._13oc-S', 'div.cPHDOP'];
const TITLE_SELECTORS = ['div.KzDlHZ', 'div._4rR01T', 'div.syl9yP', 'div._2WkVRV', 'div.IRpwTa'];
const PRICE_SELECTORS = ['div.Nx9bqj._4b5DiR', 'div.Nx9bqj', 'div._30jeq3._1_WHN1', 'div._30jeq3'];
const MRP_SELECTORS = ['div.yRaY8j', 'div._3I9_wc'];
const DISC_SELECTORS = ['div.UkUFwK', 'div._3Ay6Sb'];
// Flipkart uses different image markup per card type: the phone cards carry
// img.DByuf4, while fashion cards lazy-load through srcset/data-src on a bare
// <img>. Only the phone classes were listed, so every fashion deal logged
// image=NONE and posted without a picture. The attribute selectors below catch
// the lazy-loaded ones; pickImageUrl still rejects placeholders and data: URIs,
// so widening the net cannot let a 1x1 through.
const IMG_SELECTORS = [
  'img.DByuf4',
  'img._396cs4',
  'img._2r_T1I',
  'img[srcset]',
  'img[data-src]',
  'img[loading="lazy"]',
  'img',
];

function textOf(scope, selectors) {
  for (const sel of selectors) {
    const el = scope.find(sel).first();
    if (el && el.length) {
      const t = el.text().trim();
      if (t) return t;
    }
  }
  return null;
}

function attrOf(scope, selectors, attr) {
  for (const sel of selectors) {
    const el = scope.find(sel).first();
    if (el && el.length) {
      const v = el.attr(attr);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Read a usable image URL off one <img>. Flipkart lazy-loads its cards, so the
 * plain `src` is frequently a 1x1 placeholder or a data: URI while the real URL
 * sits in `srcset` / `data-src`. Sending a placeholder is why Telegram answered
 * "failed to get HTTP URL content" and the post fell back to text.
 */
function pickImageUrl(el) {
  if (!el || !el.length) return null;
  for (const attr of ['srcset', 'data-src', 'data-old-hires', 'src']) {
    let v = el.attr(attr);
    if (!v) continue;
    if (attr === 'srcset') {
      // "a.jpg 1x, b.jpg 2x" -> the last entry is usually the largest
      const parts = String(v)
        .split(',')
        .map((piece) => piece.trim().split(/\s+/)[0])
        .filter(Boolean);
      v = parts[parts.length - 1] || null;
    }
    if (!v) continue;
    if (/^data:/i.test(v)) continue; // inline placeholder, not a real image
    if (!/^https?:\/\//i.test(v)) continue;
    return String(v).replace(/^http:\/\//i, 'https://');
  }
  return null;
}

/** First card image that yields a real URL. */
function imageFromCard(scope) {
  for (const sel of IMG_SELECTORS) {
    const el = scope.find(sel).first();
    if (!el || !el.length) continue;
    const url = pickImageUrl(el);
    if (url) return url;
  }
  return null;
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function sourceUrls() {
  const fromEnv = (process.env.DEALS_SOURCE_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_SOURCES;
}

/** Extract one product from a card element (works for a card div or an anchor). */
/**
 * A listing card's text is not a product name.
 *
 * Flipkart wraps the whole card — the "Add to Compare" control, the title, the
 * rating — in one <a>, and cheerio's .text() concatenates with no separator, so
 * the title came out as:
 *
 *   "Add to CompareApple iPhone 17 (Black, 256 GB)4.628,706 Ratin"
 *
 * That was posted verbatim to the deals channel. Strip the furniture:
 */
/**
 * Is this a piece of FASHION, or is it the makeup, the mixer-grinder and the
 * phone case that Flipkart's "top offers" page is also full of?
 *
 * The channel is a fashion channel. The log showed what was coming through
 * unfiltered: "Pack of 3 Printed Men Trunk" next to mobile listings and whatever
 * else the source pages happened to surface. A deals bot that posts a random
 * assortment reads as a spam feed; one that posts only clothing reads as a
 * fashion channel.
 *
 * The rule is a BLOCKLIST first, then an ALLOWLIST. A blocklist alone lets
 * anything unrecognised through — including the appliances — so the allowlist is
 * what actually decides. The blocklist only catches the near-misses.
 */

// Never fashion. Matched as whole words so "shirt" inside "shirtless" or
// "phone" inside "headphone" cannot sneak through the wrong way.
const NOT_FASHION = [
  // beauty and personal care
  'makeup', 'lipstick', 'lipbalm', 'kajal', 'eyeliner', 'mascara', 'foundation',
  'nail', 'nailpolish', 'perfume', 'deodorant', 'shampoo', 'conditioner', 'hair',
  'serum', 'cream', 'lotion', 'sunscreen', 'facewash', 'trimmer', 'shaver',
  'razor', 'sanitary', 'diaper', 'baby',
  // home and kitchen
  'mixer', 'grinder', 'cooker', 'kettle', 'toaster', 'oven', 'refrigerator',
  'washing', 'vacuum', 'iron', 'fan', 'cooler', 'heater', 'geyser', 'chimney',
  'sofa', 'mattress', 'bedsheet', 'pillow', 'curtain', 'carpet', 'rug',
  // A laptop BAG is luggage, not a laptop. 'backpack' and friends must beat the
  // 'laptop' allowlist word, so they belong on the blocklist.
  'backpack', 'rucksack', 'suitcase', 'trolley', 'luggage', 'bag', 'wallet',
  'cookware', 'bottle', 'flask', 'lunchbox', 'storage', 'container', 'cleaner',
  'detergent', 'mop', 'dustbin', 'towel', 'utensil',
  // electronics and everything else.
  //
  // 'mobile' and 'smartphone' were removed from this list first: the channel
  // WANTS phone deals, and blocking the word blocked the whole category.
  //
  // The same mistake was then made with SMARTWATCHES, and the live log caught it
  // in the worst way: a smartwatch listing page was being FETCHED and every card
  // on it was then dropped — "fashion filter dropped 20 of 20 ... smartwatch",
  // from a source list that includes q=smartwatch. The bot was paying to fetch
  // deals it had already decided to throw away, and the channel saw nothing.
  //
  // Watches, earbuds and speakers are consumer tech the channel wants, so they
  // come off the blocklist too. What stays blocked is the general-purpose
  // hardware and the non-tech categories, which is what the filter is for.
  'laptop', 'tablet',
  'charger', 'cable', 'powerbank', 'camera', 'printer', 'router',
  'tv', 'television', 'monitor', 'keyboard', 'mouse', 'pendrive', 'harddisk',
  'book', 'novel', 'toy', 'game', 'puzzle', 'stationery', 'pen', 'notebook',
  'grocery', 'snack', 'chocolate', 'coffee', 'tea', 'oil', 'rice', 'atta',
  'medicine', 'supplement', 'protein', 'vitamin', 'mask', 'sanitizer',
  'tool', 'drill', 'helmet', 'tyre', 'car', 'bike', 'pet', 'seed', 'plant',
];

// Fashion. One of these must be present for a deal to be posted.
// Consumer tech the channel wants alongside fashion. These are checked with the
// same allowlist, because the filter is blocklist-then-ALLOWLIST: simply removing
// 'smartwatch' from the blocklist would have left it dropped as
// "not_fashion:unrecognised", which is exactly what the log showed.
const TECH = [
  'smartwatch', 'smart watch', 'earbuds', 'earbud', 'earphone', 'headphone',
  'headset', 'speaker', 'soundbar', 'neckband', 'powerbank', 'power bank',
  'charger', 'smartphone', 'mobile', 'tablet', 'camera', 'printer',
  // The rest of the consumer electronics the channel asked for. A "Gaming
  // Laptop" was being rejected by the 'game' blocklist word and a "Gaming Mouse"
  // by 'mouse' — both are exactly what "electronics and tech gadgets" means.
  'laptop', 'macbook', 'chromebook', 'monitor', 'television',
  'smart tv', 'projector', 'keyboard', 'mouse', 'router', 'pendrive', 'ssd',
  'hard disk', 'harddisk', 'graphics card', 'processor', 'console',
  'playstation', 'xbox', 'drone', 'gimbal', 'microphone', 'webcam', 'tv',
];

const FASHION = [
  'tshirt', 't-shirt', 'tee', 'shirt', 'polo', 'top', 'blouse', 'tunic',
  'kurta', 'kurti', 'saree', 'sari', 'lehenga', 'salwar', 'chudidar', 'dupatta',
  'kaftan', 'caftan', 'abaya', 'kameez', 'anarkali', 'nighty', 'nightwear',
  'co-ord', 'coord', 'jumpsuit', 'romper', 'poncho', 'cape', 'stole', 'shawl',
  'dress', 'gown', 'frock', 'skirt', 'jeans', 'trouser', 'pant', 'chino',
  'cargo', 'jogger', 'short', 'capri', 'legging', 'trackpant', 'palazzo',
  'jacket', 'blazer', 'coat', 'sweater', 'sweatshirt', 'hoodie', 'pullover',
  'cardigan', 'shrug', 'waistcoat', 'sherwani', 'suit',
  'shoe', 'sneaker', 'sandal', 'slipper', 'flipflop', 'flip-flop', 'loafer',
  'heel', 'boot', 'footwear', 'sports shoe', 'running shoe',
  'bag', 'handbag', 'backpack', 'wallet', 'belt', 'cap', 'hat', 'scarf',
  'stole', 'watch', 'sunglass', 'goggle', 'jewellery', 'jewelry', 'earring',
  'necklace', 'bangle', 'bracelet', 'ring', 'anklet', 'pendant',
  // Phones are a category the channel wants in its own right. A listing often
  // names the model without the word "mobile" anywhere — "iQOO Z11 Lite 5G
  // (Solar Flame, 6GB)" — so the brands are recognised too.
  'mobile', 'smartphone', '5g phone', 'mobile phone', 'smart phone',
  'iqoo', 'redmi', 'realme', 'poco', 'vivo', 'oppo', 'oneplus', 'nothing phone',
  'infinix', 'tecno', 'lava', 'motorola', 'honor', 'iphone', 'galaxy',
  // The boys' casual combos the channel asked for: relaxed denim with shirts,
  // cargo with tees, trousers with polos. Each PIECE has to be recognisable,
  // because a listing names one item, not the outfit.
  'denim', 'cargo', 'chino', 'trouser', 'polo', 'henley', 'oversized',
  'outfit', 'ethnic', 'western', 'casual', 'formal', 'sportswear', 'nightwear',
  'innerwear', 'brief', 'trunk', 'vest', 'sock', 'nightie', 'pyjama', 'pajama',
];

function wordHit(text, word) {
  // A phrase (contains a space) is a plain substring; a single word is bounded.
  if (word.indexOf(' ') >= 0) return text.indexOf(word) >= 0;
  // The optional trailing "s" matters more than it looks: "sneakers", "shirts"
  // and "jeans" are how listings are actually titled, and a list that only knew
  // the singular quietly dropped real fashion while letting the singular-only
  // blocklist entries through.
  return new RegExp('(?:^|[^a-z])' + word + '(?:s|es)?(?:[^a-z]|$)').test(text);
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function fashionCheck(rawTitle) {
  const t = String(rawTitle || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { ok: false, reason: 'no_title' };

  // TECH IS CHECKED FIRST, BEFORE THE BLOCKLIST.
  //
  // The log showed a page of smartwatches dropped 20 of 20, and the reason was
  // not the smartwatch word at all: one of those titles reads "Built-in Games
  // Smartwatch", and the blocklist holds 'game'. A single incidental word was
  // rejecting the whole product. A title that names a piece of consumer tech IS
  // a tech deal, whatever else it mentions — a "Gaming Laptop" is exactly the
  // kind of thing the channel wants, and 'game' was silently excluding it too.
  // LUGGAGE BEATS TECH. "Large 60 L Laptop Backpack" names a laptop, so the tech
  // allowlist would claim it — but the product is a bag. A container word has to
  // win over a contents word, or every laptop bag rides in on 'laptop'.
  const container = ['backpack', 'rucksack', 'suitcase', 'trolley', 'luggage', 'bag'].find((w) => wordHit(t, w));
  if (container) return { ok: false, reason: 'not_fashion:' + container };

  const tech = TECH.find((w) => wordHit(t, w));
  if (tech) return { ok: true };

  const blocked = NOT_FASHION.find((w) => wordHit(t, w));
  if (blocked) return { ok: false, reason: 'not_fashion:' + blocked };

  const allowed = FASHION.find((w) => wordHit(t, w));
  if (allowed) return { ok: true };

  return { ok: false, reason: 'not_fashion:unrecognised' };
}

function cleanDealTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Leading controls Flipkart puts inside the same link.
  t = t.replace(/^(?:add to compare|compare|add to cart|sponsored|assured)\s*/gi, '');
  // A trailing rating block: "4.6" then "28,706 Ratings" concatenated — and the
  // word itself is sometimes TRUNCATED to "Ratin", so match the stem.
  t = t.replace(/\s*\d(?:\.\d)?\s*[\d,]*\s*ratin\w*.*$/i, '');
  t = t.replace(/\s*\d(?:\.\d)?\s*[\d,]*\s*(?:reviews?|stars?)\b.*$/i, '');
  // A bare trailing "4.628,706" with the word lost entirely.
  t = t.replace(/\s*\d\.\d[\d,]{3,}\s*$/, '');
  // Same store furniture cleanProductName removes.
  t = t.split(/\s*\|\s*/)[0];
  t = t.replace(/\s+(?:online at best price|price in india|buy online|free shipping).*$/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

function parseCard($, el) {
  let scope = $(el);
  if (scope.is('a[href*="/p/itm"]')) {
    const container = scope.closest(CARD_SELECTORS.join(', '));
    scope = container.length ? container : scope.parent();
  }

  const linkEl = scope.find('a[href*="/p/itm"]').first().length
    ? scope.find('a[href*="/p/itm"]').first()
    : scope.find('a').first();
  const href = linkEl && linkEl.attr('href');
  if (!href || !/\/p\/itm/i.test(href)) return null;

  const url = 'https://www.flipkart.com' + href.split('?')[0];

  let title = textOf(scope, TITLE_SELECTORS);
  if (!title && linkEl) title = linkEl.attr('title') || linkEl.text().trim() || null;
  if (!title) {
    const imgAlt = attrOf(scope, IMG_SELECTORS, 'alt');
    if (imgAlt) title = imgAlt;
  }
  // Never post the card's furniture as a product name.
  title = cleanDealTitle(title);
  if (!title) return null;

  // The card's whole text. Flipkart renames its CSS classes constantly, so we
  // fall back to patterns over this text rather than trusting a class name.
  //
  // IMPORTANT: cheerio's .text() concatenates nested elements with NO separator,
  // so "<div>₹29,999</div><div>57% off</div>" reads as "₹29,99957% off" — which
  // parses as mrp 2999957 and discount 957. Stripping tags to a SPACE keeps the
  // values separate.
  const cardText = $.html(scope).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

  let price = parsePrice(textOf(scope, PRICE_SELECTORS));
  let mrp = parsePrice(textOf(scope, MRP_SELECTORS));

  // Fallback: pull ₹ amounts straight out of the card text. The first is the
  // selling price, the second (the struck-through one) is the MRP.
  if (price == null || mrp == null) {
    const rupees = (cardText.match(/₹\s*[\d,]+/g) || [])
      .map((t) => parsePrice(t))
      .filter((n) => n != null);
    if (price == null && rupees.length) price = rupees[0];
    if (mrp == null && rupees.length > 1) mrp = rupees[1];
  }

  // Discount, three ways in order of trust:
  //   1. the discount badge element
  //   2. a regex over the card text — "68% off" (the durable path)
  //   3. derived from price vs MRP
  let discount = null;
  let discRaw = null;

  const discText = textOf(scope, DISC_SELECTORS);
  if (discText) {
    discRaw = discText;
    const m = discText.match(/(\d{1,3})\s*%/);
    if (m) discount = parseInt(m[1], 10);
  }
  if (discount == null) {
    const m = cardText.match(/(\d{1,3})\s*%\s*off/i) || cardText.match(/(\d{1,3})\s*%/);
    if (m) {
      discount = parseInt(m[1], 10);
      discRaw = m[0];
    }
  }
  if (discount == null && price && mrp && mrp > price) {
    discount = Math.round(((mrp - price) / mrp) * 100);
    discRaw = 'derived from price/mrp';
  }

  const imageUrl = imageFromCard(scope);

  return {
    id: hashId(url),
    marketplace: 'flipkart',
    title: title.replace(/\s+/g, ' ').trim(),
    url,
    price: price || null,
    mrp: mrp || null,
    discount: discount,
    discRaw: discRaw || null,
    imageUrl: imageUrl || null,
  };
}

/**
 * Fetch and parse ONE listing page. Never throws.
 * Returns { deals, status, cards, matched, error } so the caller can log WHY a
 * source produced nothing instead of failing silently.
 */
async function fetchSource(src, minDiscount) {
  const out = [];
  const stats = { url: src, status: null, cards: 0, matched: 0, error: null };
  try {
    const res = await axios.get(src, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
    });
    stats.status = res.status;
    if (res.status >= 400) {
      stats.error = 'http_' + res.status;
      console.warn('deals source skipped', src, 'status', res.status);
      return { deals: out, ...stats };
    }
    const html = typeof res.data === 'string' ? res.data : '';
    if (!html) {
      stats.error = 'empty_body';
      return { deals: out, ...stats };
    }

    const $ = cheerio.load(html);
    let cards = [];
    for (const sel of CARD_SELECTORS) {
      const c = $(sel);
      if (c.length) {
        cards = c.toArray();
        break;
      }
    }
    if (!cards.length) cards = $('a[href*="/p/itm"]').toArray();
    stats.cards = cards.length;

    const samples = [];
    let parsed = 0;
    for (const el of cards) {
      const deal = parseCard($, el);
      if (!deal) continue;
      parsed++;
      // Keep a few raw parses so a 0-match run is diagnosable from the JSON.
      if (samples.length < 3) {
        samples.push({
          title: String(deal.title).slice(0, 60),
          price: deal.price,
          mrp: deal.mrp,
          discount: deal.discount,
          discRaw: deal.discRaw,
          image: deal.imageUrl ? String(deal.imageUrl).slice(0, 70) : null,
        });
      }
      // Keep anything at or ABOVE the threshold: 20% passes, 19.9% does not.
      // Written as an explicit >= so a missing/NaN discount can never slip in.
      if (!(Number(deal.discount) >= Number(minDiscount))) continue;
      out.push(deal);
    }
    stats.parsed = parsed;
    stats.samples = samples;
    stats.matched = out.length;
  } catch (err) {
    stats.error = err.message;
    console.warn('deals source failed', src, err.message);
  }
  return { deals: out, ...stats };
}

/**
 * @param {object} opts
 * @param {number} [opts.minDiscount=50]  only return deals at least this % off
 * @param {number} [opts.limit=10]        max deals to return
 * @param {string[]} [opts.sourceUrls]    override the listing pages
 * @returns {Promise<Array>} deals sorted by discount (highest first)
 */
/**
 * Same as discoverDeals, but also returns per-source diagnostics so the caller
 * can log exactly which listing page failed and why.
 * @returns {Promise<{deals: Array, sources: Array, ms: number}>}
 */
async function discoverDealsDetailed({ minDiscount = 20, limit = 10, sourceUrls: override, category } = {}) {
  const started = Date.now();
  // A category steers WHICH listing pages are scraped. When we have pages for
  // it, they replace the default set entirely — that is what makes the section
  // relevant to the product being viewed rather than generically popular.
  let urls = override && override.length ? override : sourceUrls();
  let steered = false;
  if (category) {
    const forCategory = sourcesForCategory(category);
    if (forCategory && forCategory.length && !(override && override.length)) {
      urls = forCategory;
      steered = true;
    }
  }
  const found = new Map();

  const results = await Promise.all(urls.map((src) => fetchSource(src, minDiscount)));
  for (const r of results) {
    for (const deal of r.deals) {
      if (!found.has(deal.id)) found.set(deal.id, deal);
    }
  }

  let deals = Array.from(found.values()).sort((a, b) => b.discount - a.discount);

  // When the section is steered to a category, drop anything that does not
  // belong to it — a "Trending Deals" strip headed Mobile Phones should not
  // carry a study table. If that leaves too few to fill the strip, keep the
  // most relevant and top up with the rest rather than showing an empty section.
  if (steered) {
    const inCat = deals.filter((d) => categoryFromTitle(d.title || '').id === category);
    const rest = deals.filter((d) => categoryFromTitle(d.title || '').id !== category);
    deals = inCat.length >= 3 ? inCat : inCat.concat(rest);
  }

  deals = deals.slice(0, limit);

  return {
    deals,
    sources: results.map((r) => ({
      url: r.url,
      status: r.status,
      cards: r.cards,
      parsed: r.parsed,
      matched: r.matched,
      error: r.error,
      samples: r.samples || [],
    })),
    ms: Date.now() - started,
  };
}

async function discoverDeals({ minDiscount = 20, limit = 10, sourceUrls: override } = {}) {
  const urls = override && override.length ? override : sourceUrls();
  const found = new Map();

  // Fetch every source IN PARALLEL. Sequentially this could take 3x the
  // timeout and make the endpoint hang; in parallel the whole run is bounded
  // by a single timeout.
  const results = await Promise.all(urls.map((src) => fetchSource(src, minDiscount)));
  for (const r of results) {
    for (const deal of r.deals) {
      if (!found.has(deal.id)) found.set(deal.id, deal);
    }
  }

  return Array.from(found.values())
    .sort((a, b) => b.discount - a.discount)
    .slice(0, limit);
}

module.exports = {
  fashionCheck,
  TECH,
  cleanDealTitle, discoverDeals, discoverDealsDetailed, parseCard, hashId };
