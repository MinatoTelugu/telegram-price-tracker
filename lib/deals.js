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

const REQUEST_TIMEOUT = 8000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  Referer: 'https://www.flipkart.com/',
};

const DEFAULT_SOURCES = [
  'https://www.flipkart.com/search?q=top%20offers&sort=popularity',
  'https://www.flipkart.com/search?q=mobile&sort=popularity',
  'https://www.flipkart.com/search?q=fashion%20sale&sort=popularity',
];

// Flipkart changes class names over time, so each field lists fallbacks.
const CARD_SELECTORS = ['div._75nlfW', 'div.tUxRFH', 'div._1AtVbE', 'div._13oc-S', 'div.cPHDOP'];
const TITLE_SELECTORS = ['div.KzDlHZ', 'div._4rR01T', 'div.syl9yP', 'div._2WkVRV', 'div.IRpwTa'];
const PRICE_SELECTORS = ['div.Nx9bqj._4b5DiR', 'div.Nx9bqj', 'div._30jeq3._1_WHN1', 'div._30jeq3'];
const MRP_SELECTORS = ['div.yRaY8j', 'div._3I9_wc'];
const DISC_SELECTORS = ['div.UkUFwK', 'div._3Ay6Sb'];
const IMG_SELECTORS = ['img.DByuf4', 'img._396cs4', 'img._2r_T1I', 'img'];

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
  if (!title) return null;

  const price = parsePrice(textOf(scope, PRICE_SELECTORS));
  const mrp = parsePrice(textOf(scope, MRP_SELECTORS));

  let discount = null;
  const discText = textOf(scope, DISC_SELECTORS);
  if (discText) {
    const m = discText.match(/(\d+)\s*%/);
    if (m) discount = parseInt(m[1], 10);
  }
  if (discount == null && price && mrp && mrp > price) {
    discount = Math.round(((mrp - price) / mrp) * 100);
  }

  let imageUrl = attrOf(scope, IMG_SELECTORS, 'src');
  if (!imageUrl && linkEl) imageUrl = null;

  return {
    id: hashId(url),
    marketplace: 'flipkart',
    title: title.replace(/\s+/g, ' ').trim(),
    url,
    price: price || null,
    mrp: mrp || null,
    discount: discount,
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

    for (const el of cards) {
      const deal = parseCard($, el);
      if (!deal) continue;
      if (deal.discount == null || deal.discount < minDiscount) continue;
      out.push(deal);
    }
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
async function discoverDealsDetailed({ minDiscount = 50, limit = 10, sourceUrls: override } = {}) {
  const started = Date.now();
  const urls = override && override.length ? override : sourceUrls();
  const found = new Map();

  const results = await Promise.all(urls.map((src) => fetchSource(src, minDiscount)));
  for (const r of results) {
    for (const deal of r.deals) {
      if (!found.has(deal.id)) found.set(deal.id, deal);
    }
  }

  const deals = Array.from(found.values())
    .sort((a, b) => b.discount - a.discount)
    .slice(0, limit);

  return {
    deals,
    sources: results.map((r) => ({
      url: r.url,
      status: r.status,
      cards: r.cards,
      matched: r.matched,
      error: r.error,
    })),
    ms: Date.now() - started,
  };
}

async function discoverDeals({ minDiscount = 50, limit = 10, sourceUrls: override } = {}) {
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

module.exports = { discoverDeals, discoverDealsDetailed, parseCard, hashId };
