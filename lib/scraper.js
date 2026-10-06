/**
 * lib/scraper.js
 * ---------------------------------------------------------------------------
 * Fetch a product page and extract its current price (plus title/image where
 * available). Used by the cron job to record price history.
 *
 * Reality check: Amazon aggressively blocks datacenter IPs (Vercel's are
 * datacenter IPs). We therefore detect the "Robot Check" page and report
 * reason:'blocked' instead of recording a bogus price. Flipkart is more
 * permissive. If you need rock-solid Amazon prices, plug the Product
 * Advertising API or a data provider (e.g. ExtraPe) into fetchProduct() later
 * — the return shape stays the same.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const cheerio = require('cheerio');

const REQUEST_TIMEOUT = 15000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/** Pull the first plausible price out of a string like "₹1,29,999.00". */
function parsePrice(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/[,\s]/g, '').match(/\d+(?:\.\d{1,2})?/);
  if (!m) return null;
  const value = parseFloat(m[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function firstText($, selectors) {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el && el.length) {
      const t = el.text().trim();
      if (t) return t;
    }
  }
  return null;
}

function firstAttr($, pairs) {
  for (const { sel, attr } of pairs) {
    const el = $(sel).first();
    if (el && el.length) {
      const v = el.attr(attr);
      if (v) return v;
    }
  }
  return null;
}

const AMAZON = {
  price: [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    'span.a-price-whole',
    '.a-price .a-offscreen',
  ],
  title: ['#productTitle', '#title'],
  image: [
    { sel: '#landingImage', attr: 'data-old-hires' },
    { sel: '#landingImage', attr: 'src' },
    { sel: '#imgTagWrapperId img', attr: 'src' },
  ],
};

const FLIPKART = {
  price: [
    'div.Nx9bqj.CxhGGd',
    'div._30jeq3._16Jk6d',
    'div._30jeq3',
    'div.Nx9bqj',
    'div._16Jk6d',
  ],
  title: ['span.VU-ZEz', 'span.B_NuCI', 'h1 span', 'h1'],
  image: [
    { sel: 'img.DByuf4', attr: 'src' },
    { sel: 'img._396cs4', attr: 'src' },
    { sel: 'img._2r_T1I', attr: 'src' },
    { sel: 'img', attr: 'src' },
  ],
};

function looksBlocked(html) {
  return /api-services-support@amazon\.com|Enter the characters you see below|Robot Check|Sorry, we just need to make sure/i.test(
    html
  );
}

/**
 * @param {string} productUrl  The clean product URL to fetch.
 * @param {string} marketplace 'amazon' | 'flipkart'
 * @returns {Promise<object>} { ok:true, price, currency, title, imageUrl }
 *                            or { ok:false, reason, ... }
 */
async function fetchProduct(productUrl, marketplace) {
  if (!productUrl) return { ok: false, reason: 'no_url' };

  let html;
  try {
    const res = await axios.get(productUrl, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
    });
    if (res.status >= 400) return { ok: false, reason: 'http_' + res.status };
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
  } catch (err) {
    return { ok: false, reason: 'request_failed', error: err.message };
  }

  if (!html) return { ok: false, reason: 'empty_body' };
  if (looksBlocked(html)) return { ok: false, reason: 'blocked' };

  const $ = cheerio.load(html);
  const cfg = marketplace === 'flipkart' ? FLIPKART : AMAZON;

  const title = firstText($, cfg.title);
  const price = parsePrice(firstText($, cfg.price));
  let imageUrl = firstAttr($, cfg.image);

  if (price == null) return { ok: false, reason: 'price_not_found', title };

  return {
    ok: true,
    price,
    currency: 'INR',
    title: title || null,
    imageUrl: imageUrl || null,
  };
}

module.exports = { fetchProduct, parsePrice, looksBlocked };
