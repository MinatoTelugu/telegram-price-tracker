/**
 * lib/scraper.js
 * ---------------------------------------------------------------------------
 * Fetch a product page and extract its current price (plus title/image where
 * available). Used by the cron job to record price history.
 *
 * Hard-won findings:
 *   - Flipkart APP SHARE LINKS like
 *       https://www.flipkart.com/product/p/itme?pid=XXXX
 *     do NOT resolve for a plain request (they 500 / return nothing). The
 *     CANONICAL page
 *       https://www.flipkart.com/<slug>/p/<itm-id>?pid=XXXX
 *     works fine. So for Flipkart we resolve the share link to its canonical
 *     URL first (redirect, then <link rel="canonical">, then a pid search) and
 *     report the resolved URL back so it can be cached.
 *   - Amazon serves a "Robot Check" page to datacenter IPs; we detect it and
 *     report reason:'blocked'.
 *   - Both sites dislike cookie-less first requests, so we warm a session and
 *     retry 5xx with backoff, falling back to a mobile User-Agent.
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
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-User': '?1',
  DNT: '1',
  Connection: 'keep-alive',
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

/**
 * Last-resort product name: the document <title>, cleaned of the site's
 * boilerplate. Amazon titles read "Amazon.in: Product Name : Amazon.in";
 * Flipkart's read "Product Name - Buy ... - Flipkart.com".
 */
function titleFromDocTitle($, marketplace) {
  const raw = ($('title').first().text() || '').trim();
  if (!raw) return null;
  let t = raw;
  if (marketplace === 'amazon') {
    t = t
      .replace(/^Amazon\.[a-z.]+\s*:\s*/i, '')
      .replace(/\s*:\s*Amazon\.[a-z.]+.*$/i, '')
      .replace(/^Amazon\.[a-z.]+\s*[-|]\s*/i, '');
  } else {
    t = t
      .replace(/^Buy\s+/i, '')
      .replace(/\s*[-|]\s*(Buy|Online at Best Price).*$/i, '')
      .replace(/\s*[-|]\s*Flipkart\.com.*$/i, '');
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 2 ? t : null;
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

// --- Flipkart session warm-up ---------------------------------------------
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

// --- Flipkart canonical-URL resolution -------------------------------------

/** The /p/itmXXXX id that marks a real product page. Requires a real id —
 * the share-link placeholder "itme" must NOT count. */
function flipkartItmId(pathname) {
  const m = String(pathname || '').match(/\/p\/(itm[a-z0-9]{6,})/i);
  return m ? m[1] : null;
}

function isCanonicalFlipkart(urlStr) {
  try {
    return Boolean(flipkartItmId(new URL(urlStr).pathname));
  } catch (err) {
    return false;
  }
}

/**
 * Turn an app share link (/product/p/itme?pid=...) into a canonical product
 * URL. Tries, in order: following redirects, the page's <link rel="canonical">,
 * then a search for the pid. Returns null if it cannot be resolved.
 */
async function resolveFlipkartUrl(url) {
  if (isCanonicalFlipkart(url)) return url;

  let pid = null;
  try {
    pid = new URL(url).searchParams.get('pid');
  } catch (err) {
    /* not a URL we can parse */
  }

  const headers = { ...BASE_HEADERS, 'User-Agent': DESKTOP_UA, Referer: 'https://www.flipkart.com/' };
  const cookies = await warmFlipkart();
  if (cookies) headers.Cookie = cookies;

  // 1) Follow redirects and capture the final URL / canonical tag.
  try {
    const res = await axios.get(url, {
      headers,
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const finalUrl =
      (res.request && res.request.res && res.request.res.responseUrl) || res.config.url;
    if (finalUrl && isCanonicalFlipkart(finalUrl)) return finalUrl;

    const html = typeof res.data === 'string' ? res.data : '';
    if (html) {
      const $ = cheerio.load(html);
      const canon = $('link[rel="canonical"]').attr('href');
      if (canon && isCanonicalFlipkart(canon)) return canon;
    }
  } catch (err) {
    /* fall through to the search attempt */
  }

  // 2) Search for the pid and take the first product link.
  if (pid) {
    try {
      const res = await axios.get('https://www.flipkart.com/search?q=' + encodeURIComponent(pid), {
        headers,
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      const html = typeof res.data === 'string' ? res.data : '';
      if (html) {
        const $ = cheerio.load(html);
        let href = null;
        $('a[href*="/p/itm"]').each((i, el) => {
          if (href) return;
          const h = String($(el).attr('href') || '').split('?')[0];
          if (flipkartItmId(h)) href = h;
        });
        if (href) return 'https://www.flipkart.com' + (href.startsWith('/') ? href : '/' + href);
      }
    } catch (err) {
      /* give up */
    }
  }

  return null;
}

/**
 * @param {string} productUrl  The clean product URL to fetch.
 * @param {string} marketplace 'amazon' | 'flipkart'
 * @returns {Promise<object>} { ok:true, price, currency, title, imageUrl, resolvedUrl? }
 *                            or { ok:false, reason, status?, snippet?, title? }
 */
async function fetchProduct(productUrl, marketplace) {
  if (!productUrl) return { ok: false, reason: 'no_url' };

  const cfg = marketplace === 'flipkart' ? FLIPKART : AMAZON;
  const isFlipkart = marketplace === 'flipkart';

  // Resolve Flipkart share links to their canonical page first.
  let targetUrl = productUrl;
  let resolvedUrl = null;
  if (isFlipkart && !isCanonicalFlipkart(productUrl)) {
    const resolved = await resolveFlipkartUrl(productUrl);
    if (resolved) {
      targetUrl = resolved;
      resolvedUrl = resolved;
    }
  }

  let cookies = '';
  if (isFlipkart) cookies = await warmFlipkart();

  const attempts = [
    { url: targetUrl, ua: DESKTOP_UA },
    { url: targetUrl, ua: DESKTOP_UA },
    { url: targetUrl, ua: MOBILE_UA },
  ];
  // Amazon's light mobile product page (/gp/aw/d/ASIN) is sometimes served when
  // the desktop /dp/ page is refused. It is a legitimate alternate surface, not
  // an evasion technique — see the note in the README about datacenter IPs.
  if (!isFlipkart && /amazon\./i.test(targetUrl) && /\/dp\//i.test(targetUrl)) {
    attempts.push({ url: targetUrl.replace('/dp/', '/gp/aw/d/'), ua: MOBILE_UA });
  }

  let last = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const headers = {
      ...BASE_HEADERS,
      'User-Agent': attempt.ua,
      Referer: isFlipkart ? 'https://www.flipkart.com/' : 'https://www.google.com/',
    };
    if (isFlipkart && cookies) headers.Cookie = cookies;

    let html = '';
    try {
      const res = await axios.get(attempt.url, {
        headers,
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
      });
      html = typeof res.data === 'string' ? res.data : String(res.data || '');

      // Capture where the request actually LANDED. Amazon usually 301-redirects
      // /dp/ASIN to the canonical /Product-Name/dp/ASIN, and that slug is the
      // product name — so this is how we get a name for Amazon products.
      const finalUrl = (res.request && res.request.res && res.request.res.responseUrl) || null;
      if (finalUrl && !resolvedUrl && finalUrl !== targetUrl) resolvedUrl = finalUrl;

      if (res.status >= 400) {
        last = { ok: false, reason: 'http_' + res.status, status: res.status, snippet: html.slice(0, 120) };
        if (res.status >= 500 && i < attempts.length - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return last;
      }
    } catch (err) {
      last = { ok: false, reason: 'request_failed', error: err.message };
      if (i < attempts.length - 1) {
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
    let title = firstText($, cfg.title);
    if (!title) {
      // Open Graph title is the most reliable "real name" when the page loads.
      const og = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
      if (og && og.trim()) title = og.trim();
    }
    if (!title) title = titleFromDocTitle($, marketplace);
    const price = parsePrice(firstText($, cfg.price));
    const imageUrl = firstAttr($, cfg.image);

    if (price == null) return { ok: false, reason: 'price_not_found', title, resolvedUrl };

    return {
      ok: true,
      price,
      currency: 'INR',
      title: title || null,
      imageUrl: imageUrl || null,
      resolvedUrl,
    };
  }

  return last || { ok: false, reason: 'failed' };
}

/**
 * Try HARD to find a real product name for an already-tracked product.
 *
 * We walk every URL we have for the product (the resolved canonical URL, the
 * cleaned URL, the affiliate URL) and, for Flipkart, the app share URL — which
 * Flipkart itself resolves by pid. For each, fetchProduct both follows the
 * redirect AND reads og:title / <title>, so any page that loads gives a name.
 *
 * @returns {Promise<{title: string|null, resolvedUrl: string|null, reason?: string}>}
 */
async function resolveProductName(opts) {
  const o = opts || {};
  const marketplace = o.marketplace;
  const productId = o.productId;

  const candidates = [o.resolvedUrl, o.cleanUrl, o.affiliateUrl];

  if (marketplace === 'flipkart' && productId) {
    // The app share link is resolved by Flipkart itself from the pid.
    candidates.push('https://www.flipkart.com/product/p/itme?pid=' + encodeURIComponent(productId));
    candidates.push('https://www.flipkart.com/search?q=' + encodeURIComponent(productId));
  }
  if (marketplace === 'amazon' && productId) {
    candidates.push('https://www.amazon.in/dp/' + encodeURIComponent(productId));
  }

  const seen = new Set();
  let lastReason = 'no_candidates';

  for (const url of candidates) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let info = null;
    try {
      info = await fetchProduct(url, marketplace);
    } catch (err) {
      lastReason = 'fetch_failed: ' + err.message;
      continue;
    }
    if (!info) continue;
    if (info.title) return { title: info.title, resolvedUrl: info.resolvedUrl || url };
    if (info.resolvedUrl && info.resolvedUrl !== url) {
      return { title: null, resolvedUrl: info.resolvedUrl, reason: 'no_title_but_resolved' };
    }
    lastReason = info.reason || 'no_title';
  }

  return { title: null, resolvedUrl: null, reason: lastReason };
}

module.exports = { fetchProduct, parsePrice, looksBlocked, resolveFlipkartUrl, isCanonicalFlipkart, resolveProductName };
