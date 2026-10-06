/**
 * lib/scraper.js
 * ---------------------------------------------------------------------------
 * Fetch a product page and extract its current price (plus title/image where
 * available). Used by the cron job to record price history.
 *
 * Reality check: both marketplaces push back on automated requests.
 *   - Amazon serves a "Robot Check" page to datacenter IPs (Vercel's are
 *     datacenter IPs). We detect it and report reason:'blocked'.
 *   - Flipkart can return HTTP 500 for a cookie-less first request. We warm up
 *     a session (fetch the homepage for cookies), retry 5xx with backoff, and
 *     fall back to a mobile User-Agent.
 *
 * If prices are still unreliable, plug the Product Advertising API or a data
 * provider (e.g. ExtraPe) into fetchProduct() — the return shape stays the same.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const cheerio = require('cheerio');

const REQUEST_TIMEOUT = 15000;
const RETRY_DELAY_MS = 600;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const BASE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Cache-Control': 'no-cache',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  title: ['span.VU-ZEz', 'span.B_NUCI', 'h1 span', 'h1'],
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

// --- Flipkart session warm-up ---------------------------------------------
// A cookie-less first hit often gets a 500; fetching the homepage first and
// reusing the cookies makes the product request look like a normal session.
let flipkartCookies = null;

async function warmFlipkart() {
  if (flipkartCookies !== null) return flipkartCookies;
  try {
    const res = await axios.get('https://www.flipkart.com/', {
      headers: { ...BASE_HEADERS, 'User-Agent': DESKTOP_UA },
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true,
    });
    const setCookie = res.headers && res.headers['set-cookie'];
    flipkartCookies = Array.isArray(setCookie)
      ? setCookie.map((c) => String(c).split(';')[0]).join('; ')
      : '';
  } catch (err) {
    flipkartCookies = '';
  }
  return flipkartCookies;
}

/**
 * @param {string} productUrl  The clean product URL to fetch.
 * @param {string} marketplace 'amazon' | 'flipkart'
 * @returns {Promise<object>} { ok:true, price, currency, title, imageUrl }
 *                            or { ok:false, reason, status?, snippet?, title? }
 */
async function fetchProduct(productUrl, marketplace) {
  if (!productUrl) return { ok: false, reason: 'no_url' };

  const cfg = marketplace === 'flipkart' ? FLIPKART : AMAZON;
  const isFlipkart = marketplace === 'flipkart';

  let cookies = '';
  if (isFlipkart) cookies = await warmFlipkart();

  // Try desktop, then desktop again (after a pause), then mobile.
  const userAgents = [DESKTOP_UA, DESKTOP_UA, MOBILE_UA];
  let last = null;

  for (let i = 0; i < userAgents.length; i++) {
    const headers = {
      ...BASE_HEADERS,
      'User-Agent': userAgents[i],
      Referer: isFlipkart ? 'https://www.flipkart.com/' : 'https://www.google.com/',
    };
    if (isFlipkart && cookies) headers.Cookie = cookies;

    let html = '';
    try {
      const res = await axios.get(productUrl, {
        headers,
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
      });
      html = typeof res.data === 'string' ? res.data : String(res.data || '');

      if (res.status >= 400) {
        last = { ok: false, reason: 'http_' + res.status, status: res.status, snippet: html.slice(0, 120) };
        if (res.status >= 500 && i < userAgents.length - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return last;
      }
    } catch (err) {
      last = { ok: false, reason: 'request_failed', error: err.message };
      if (i < userAgents.length - 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return last;
    }

    if (!html) {
      last = { ok: false, reason: 'empty_body' };
      continue;
    }
    if (looksBlocked(html)) return { ok: false, reason: 'blocked' };

    const $ = cheerio.load(html);
    const title = firstText($, cfg.title);
    const price = parsePrice(firstText($, cfg.price));
    const imageUrl = firstAttr($, cfg.image);

    if (price == null) return { ok: false, reason: 'price_not_found', title };

    return {
      ok: true,
      price,
      currency: 'INR',
      title: title || null,
      imageUrl: imageUrl || null,
    };
  }

  return last || { ok: false, reason: 'failed' };
}

module.exports = { fetchProduct, parsePrice, looksBlocked };
