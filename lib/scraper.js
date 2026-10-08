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
require('./httpAgent'); // keep-alive connection reuse
const { cleanTitleWithAI, aiConfigured } = require('./aiTitle');

const REQUEST_TIMEOUT = 15000;
// Backoff between attempts. A 500 or a dropped connection is often
// transient, so we wait longer each time rather than giving up.
const RETRY_DELAYS_MS = [600, 1500, 3000];

/**
 * A small pool of REAL browser identities. Requests rotate through them, and the
 * client-hint headers are derived from the chosen identity so the two always
 * agree — a mismatched pair is itself a bot signal.
 */
const BROWSER_PROFILES = [
  {
    ua:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: '"Windows"',
    mobile: '?0',
  },
  {
    ua:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: '"macOS"',
    mobile: '?0',
  },
  {
    ua:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    platform: '"Windows"',
    mobile: '?0',
  },
  {
    ua:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    platform: '"Android"',
    mobile: '?1',
  },
  {
    ua:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: '"iOS"',
    mobile: '?1',
  },
];

const DESKTOP_UA = BROWSER_PROFILES[0].ua;
const MOBILE_UA = BROWSER_PROFILES[3].ua;

let uaCursor = 0;
/** Next browser identity, rotating through the pool. */
function nextProfile() {
  const p = BROWSER_PROFILES[uaCursor % BROWSER_PROFILES.length];
  uaCursor++;
  return p;
}

/** The client hints that must accompany a given identity. */
function profileHeaders(profile) {
  return {
    'User-Agent': profile.ua,
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': profile.mobile,
    'sec-ch-ua-platform': profile.platform,
  };
}

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

/**
 * Read a REAL image URL off one <img>. Both stores lazy-load, and Amazon ships a
 * JSON map of sizes, so a plain `src` read often yields a placeholder.
 */
function pickRealImage(el) {
  if (!el || !el.length) return null;
  // Amazon: {"url":[w,h], ...} — take the largest.
  const dyn = el.attr('data-a-dynamic-image');
  if (dyn) {
    try {
      const map = JSON.parse(dyn);
      const urls = Object.keys(map);
      if (urls.length) return urls[urls.length - 1].replace(/^http:/i, 'https:');
    } catch (err) {
      /* not JSON — fall through */
    }
  }
  for (const attr of ['data-old-hires', 'data-src', 'srcset', 'src']) {
    let v = el.attr(attr);
    if (!v) continue;
    if (attr === 'srcset') {
      const parts = String(v)
        .split(',')
        .map((piece) => piece.trim().split(/\s+/)[0])
        .filter(Boolean);
      v = parts[parts.length - 1] || null;
    }
    if (!v || /^data:/i.test(v) || !/^https?:\/\//i.test(v)) continue;
    return String(v).replace(/^http:/i, 'https:');
  }
  return null;
}

/**
 * The product photo, in order of reliability: the gallery image elements, then
 * og:image — which both stores set to the product photo and which is immune to
 * their class-name churn and lazy-loading.
 */
function imageFromPage($, cfg) {
  for (const entry of cfg.image) {
    const url = pickRealImage($(entry.sel).first());
    if (url) return url;
  }
  const og =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="og:image"]').attr('content') ||
    $('meta[property="og:image:secure_url"]').attr('content');
  if (og && /^https?:\/\//i.test(og)) return String(og).replace(/^http:/i, 'https:');
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
 * Titles that are the store's own boilerplate rather than a product name —
 * e.g. "Flipkart store 2", "Buy Products Online at Best Price". These appear on
 * store/landing pages and must never be shown as a product title.
 */
function looksGenericTitle(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/flipkart\s+store/i.test(s)) return true;
  if (/online at best price/i.test(s)) return true;
  if (/^flipkart\.com$/i.test(s)) return true;
  if (/^amazon\.[a-z.]+$/i.test(s)) return true;
  if (/^(buy|shop)\s+products?\s+online/i.test(s)) return true;
  if (/^products?(\s+store)?$/i.test(s)) return true;
  if (/^(all categories|home|shop|stores?|categories)$/i.test(s)) return true;
  return false;
}

/** First usable `name` inside a JSON-LD block (including @graph). */
function pickLdName(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.name === 'string' && node.name.trim()) return node.name.trim();
  if (Array.isArray(node['@graph'])) {
    for (const child of node['@graph']) {
      const t = pickLdName(child);
      if (t) return t;
    }
  }
  return null;
}

/**
 * Product name from JSON-LD (schema.org Product). This is the most reliable
 * metadata when a page ships it, and costs nothing extra — the HTML is already
 * downloaded.
 */
/** Recursively dig a price out of schema.org Product/Offer nodes. */
function findLdPrice(nodes) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.offers) {
      const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
      for (const o of offers) {
        if (!o) continue;
        const raw = o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : null;
        const parsed = parsePrice(raw);
        if (parsed != null) return parsed;
      }
    }
    if (node.price != null) {
      const parsed = parsePrice(node.price);
      if (parsed != null) return parsed;
    }
    if (Array.isArray(node['@graph'])) {
      const parsed = findLdPrice(node['@graph']);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

/**
 * Price from JSON-LD (schema.org Product -> offers.price). This is the most
 * reliable source on a store page and does NOT depend on CSS class names, which
 * Flipkart changes constantly — stale classes are why every Flipkart check was
 * returning price_not_found.
 */
function priceFromJsonLd($) {
  try {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      const raw = $(el).contents().text();
      if (!raw) continue;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        continue;
      }
      const parsed = findLdPrice(Array.isArray(data) ? data : [data]);
      if (parsed != null) return parsed;
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/**
 * Best-effort MRP / original price. Returns null when the page does not state
 * one — we never invent it, so the UI can simply hide the strikethrough.
 */
function mrpFromPage($) {
  // JSON-LD sometimes carries highPrice alongside price.
  try {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      const raw = $(el).contents().text();
      if (!raw) continue;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        continue;
      }
      const stack = Array.isArray(data) ? data.slice() : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        const offers = node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]) : [];
        for (const o of offers) {
          if (!o) continue;
          const hi = parsePrice(o.highPrice != null ? o.highPrice : o.listPrice != null ? o.listPrice : null);
          if (hi != null) return hi;
        }
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      }
    }
  } catch (err) {
    /* ignore */
  }
  // A struck-through price element (generic tags first — class names churn).
  for (const sel of ['del', 's', 'strike']) {
    const parsed = parsePrice($(sel).first().text());
    if (parsed != null) return parsed;
  }
  return null;
}

/** Price from meta tags (og:price:amount / product:price:amount / itemprop). */
function priceFromMeta($) {
  const sels = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
    'meta[name="price"]',
  ];
  for (const sel of sels) {
    const parsed = parsePrice($(sel).first().attr('content'));
    if (parsed != null) return parsed;
  }
  return null;
}

function titleFromJsonLd($) {
  try {
    const blocks = $('script[type="application/ld+json"]').toArray();
    for (const el of blocks) {
      const raw = $(el).contents().text();
      if (!raw) continue;
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        continue; // a malformed block must not stop us
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const t = pickLdName(item);
        if (t) return t;
      }
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/**
 * Is the product sold out? We look only at the TOP of the page (the buy area),
 * so "Sold Out" badges in recommendation carousels further down don't fool us.
 */
function detectOutOfStock($) {
  try {
    const head = $('body').text().replace(/\s+/g, ' ').slice(0, 9000).toLowerCase();
    return [
      'currently out of stock',
      'sold out',
      'currently unavailable',
      'temporarily out of stock',
      'out of stock',
    ].some((m) => head.includes(m));
  } catch (err) {
    return false;
  }
}

/**
 * Strip a store's boilerplate from a raw page title, so the REAL product name
 * survives. Flipkart titles read:
 *   "OPPO K14x 5G (64 GB Storage, 4 GB RAM) Online at Best Price On Flipkart.com"
 * — and the name is everything before "Online at Best Price".
 */
function cleanPageTitle(raw, marketplace) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (marketplace === 'amazon') {
    t = t
      .replace(/^Amazon\.[a-z.]+\s*:\s*/i, '')
      .replace(/\s*:\s*Amazon\.[a-z.]+.*$/i, '')
      .replace(/^Amazon\.[a-z.]+\s*[-|]\s*/i, '');
  } else {
    t = t
      .replace(/^Buy\s+/i, '')
      .replace(/\s+Online at Best Price.*$/i, '')
      .replace(/\s+On Flipkart\.com.*$/i, '')
      .replace(/\s*[-|]\s*Flipkart\.com.*$/i, '')
      .replace(/\s*[-|]\s*(Buy|Online at Best Price).*$/i, '');
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 2 ? t : null;
}

/**
 * Last-resort product name: the document <title>, cleaned of the site's
 * boilerplate.
 */
function titleFromDocTitle($, marketplace) {
  const cleaned = cleanPageTitle($('title').first().text(), marketplace);
  if (!cleaned || looksGenericTitle(cleaned)) return null;
  return cleaned;
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
  // '#title' was removed: it is a generic id that matches unrelated elements
  // (feature bullets, A+ copy) and produced nonsense names like
  // "Samsung Moonlight Storage Upgrades Lag Free".
  title: ['#productTitle', 'h1#title', 'span#productTitle'],
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

/**
 * Collect Amazon session cookies from the homepage once, then reuse them. A
 * request that arrives with no session at all looks far more like a bot than one
 * that has at least loaded the store front first. Cached for 10 minutes.
 */
let amazonCookies = null;
let amazonCookiesAt = 0;
async function warmAmazon() {
  const fresh = amazonCookies !== null && Date.now() - amazonCookiesAt < 10 * 60 * 1000;
  if (fresh) return amazonCookies;
  try {
    const res = await axios.get('https://www.amazon.in/', {
      headers: { ...BASE_HEADERS, ...profileHeaders(BROWSER_PROFILES[0]) },
      timeout: REQUEST_TIMEOUT,
      validateStatus: () => true,
    });
    const setCookie = res.headers && res.headers['set-cookie'];
    amazonCookies = Array.isArray(setCookie)
      ? setCookie.map((c) => String(c).split(';')[0]).join('; ')
      : '';
  } catch (err) {
    amazonCookies = '';
  }
  amazonCookiesAt = Date.now();
  return amazonCookies;
}

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

  // NOTE: we deliberately do NOT canonicalise a Flipkart URL up front any more.
  // The page we were handed — even a ?pid= form — serves og:title, whereas the
  // canonical search costs seconds we do not have (and timed the fetch out).
  const targetUrl = productUrl;
  let resolvedUrl = null;

  let cookies = '';
  if (isFlipkart) cookies = await warmFlipkart();
  if (!isFlipkart && /amazon\./i.test(targetUrl)) cookies = await warmAmazon();

  const attempts = [
    { url: targetUrl, ua: DESKTOP_UA },
    { url: targetUrl, ua: DESKTOP_UA },
    { url: targetUrl, ua: MOBILE_UA },
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
    // Rotate identity across attempts, and derive the client hints from it so
    // the User-Agent and sec-ch-ua headers never disagree.
    const profile = i === attempts.length - 1 ? { ua: attempt.ua, platform: '"Android"', mobile: '?1' } : nextProfile();
    const headers = {
      ...BASE_HEADERS,
      ...profileHeaders(profile),
      Referer: isFlipkart ? 'https://www.flipkart.com/' : 'https://www.google.com/search?q=amazon',
    };
    if (cookies) headers.Cookie = cookies;

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
        // Retry the transient ones: 5xx, 429 (rate limited), 408 (timeout).
        const transient = res.status >= 500 || res.status === 429 || res.status === 408;
        if (transient && i < attempts.length - 1) {
          const wait = RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
          console.warn('scrape: ' + res.status + ' on attempt ' + (i + 1) + ' — retrying in ' + wait + 'ms');
          await sleep(wait);
          continue;
        }
        return last;
      }
    } catch (err) {
      last = { ok: false, reason: 'request_failed', error: err.message };
      if (i < attempts.length - 1) {
        const wait = RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
        console.warn('scrape: ' + err.message + ' on attempt ' + (i + 1) + ' — retrying in ' + wait + 'ms');
        await sleep(wait);
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
    // Amazon: og:title is the same canonical name as #productTitle and survives
    // the layouts where #productTitle is renamed, so try it before the generic
    // document <title>.
    if (!title && marketplace === 'amazon') {
      const ogAmz = cleanPageTitle(
        $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content'),
        'amazon'
      );
      if (ogAmz && !looksGenericTitle(ogAmz)) title = ogAmz;
    }
    if (!title) {
      // Open Graph title is the most reliable "real name" when the page loads.
      const og = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
      const cleaned = cleanPageTitle(og, marketplace);
      if (cleaned && !looksGenericTitle(cleaned)) title = cleaned;
    }
    if (!title) {
      // JSON-LD (schema.org Product) — often the cleanest name on the page.
      const ld = cleanPageTitle(titleFromJsonLd($), marketplace);
      if (ld && !looksGenericTitle(ld)) title = ld;
    }
    if (!title) title = titleFromDocTitle($, marketplace);
    // A generic store title is worse than no title — it would be stored as the
    // product name and shown to users.
    if (title && looksGenericTitle(title)) title = null;

    // OPTIONAL last resort: ask a model to pull the name out of the raw page
    // text. Only runs when HF_TOKEN is set, so the fast path is untouched.
    if (!title && aiConfigured()) {
      const raw = [
        $('title').first().text(),
        $('meta[property="og:title"]').attr('content'),
        $('h1').first().text(),
      ]
        .filter(Boolean)
        .join(' | ');
      title = await cleanTitleWithAI(raw);
    }
    // Price, most-trustworthy source first. CSS classes come AFTER the
    // structured data, because Flipkart renames them constantly.
    let price = parsePrice(firstText($, cfg.price));
    if (price == null) price = priceFromJsonLd($);
    if (price == null) price = priceFromMeta($);
    if (price == null) {
      // Last resort: the first ₹ amount near the top of the page (the buy box).
      const head = $.html()
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 25000);
      const m = head.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
      if (m) price = parsePrice(m[1]);
    }

    let mrp = mrpFromPage($);
    // An MRP at or below the selling price is not a real discount — drop it.
    if (mrp != null && price != null && mrp <= price) mrp = null;

    const imageUrl = imageFromPage($, cfg);

    const inStock = !detectOutOfStock($);
    if (price == null) return { ok: false, reason: 'price_not_found', title, resolvedUrl, inStock };

    return {
      ok: true,
      price,
      currency: 'INR',
      title: title || null,
      imageUrl: imageUrl || null,
      mrp: mrp || null,
      resolvedUrl,
      inStock,
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

module.exports = {
  fetchProduct,
  parsePrice,
  looksBlocked,
  looksGenericTitle,
  cleanPageTitle,
  detectOutOfStock,
  titleFromJsonLd,
  priceFromJsonLd,
  priceFromMeta,
  mrpFromPage,
  imageFromPage,
  resolveFlipkartUrl,
  isCanonicalFlipkart,
  resolveProductName,
};
