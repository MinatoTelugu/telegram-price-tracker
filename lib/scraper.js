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
const { lookupAsin, paapiConfigured } = require('./paapi');
const { searchProductTitle, searchConfigured } = require('./search');
const { fetchReadablePage } = require('./reader');
const { lookupAsin: lookupAsinApi, amazonApiConfigured } = require('./amazonapi');
const { expandShortLink, isShortLink } = require('./shortlink');

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

/**
 * Containers that hold OTHER products: recommendation carousels, "similar
 * products", "customers also viewed", sponsored rows.
 *
 * A store page is mostly these. Reading a price out of one is how the card
 * showed ₹19,999 for a product the store listed at ₹21,999 — the figure was real,
 * it just belonged to the phone in the next carousel along.
 */
const RELATED_SELECTOR = [
  '#similarities_feature_div',
  '#anonCarousel',
  '#similar',
  '[id*="similar"]',
  '[id*="carousel"]',
  '[id*="recommend"]',
  '[id*="sponsored"]',
  '[class*="similar"]',
  '[class*="carousel"]',
  '[class*="recommend"]',
  '[class*="sponsored"]',
  '[data-a-carousel]',
  '[data-cel-widget*="similar"]',
  '[data-cel-widget*="sponsored"]',
  '.a-carousel',
  '.a-carousel-viewport',
].join(',');

/** Is this element, or anything above it, part of a related-products block? */
function isInRelatedBlock($, el) {
  try {
    return $(el).closest(RELATED_SELECTOR).length > 0;
  } catch (err) {
    return false;
  }
}

/**
 * The first NON-EMPTY text matching the selectors, SKIPPING anything inside a
 * related-products block.
 *
 * firstText() takes the first match in document order wherever it lives, which
 * is fine for a title and wrong for a price. This is the price reader: it walks
 * every match and returns the first that is genuinely in the buy area.
 */
/**
 * Containers that hold a price the customer does NOT pay.
 *
 * Amazon prints the M.R.P. struck through beside the selling price, and both
 * live inside the same price block — so a selector like
 * `#corePriceDisplay_desktop_feature_div span.a-price-whole` matches BOTH, and
 * `.first()` can land on the M.R.P.
 *
 * That is the reported bug, exactly: Amazon showed ₹22,999 with an M.R.P. of
 * ₹23,999, and the card showed ₹23,999 as the CURRENT price. The equality guard
 * could not catch it either, because ₹23,999 is not equal to ₹22,999 — the two
 * numbers are different, we had simply picked the wrong one.
 *
 * A struck-through figure is a legal declaration of what the item does NOT cost.
 * It is never the answer, whatever a selector says.
 */
/**
 * Containers holding the OTHER variants' prices and stock.
 *
 * A variant row carries a real price and a real "Currently unavailable", so
 * every guard we already have passes it: it is not struck through, not in a
 * carousel, not above the MRP, not equal to the MRP. It is simply a DIFFERENT
 * product. The only thing that distinguishes it is where it sits in the DOM.
 *
 * Amazon's twister is the variant selector; the expander holds the "See N
 * options" list. Both are excluded here, exactly as related-products are.
 */
/**
 * Flipkart's variant rows. The screenshot that prompted this shows:
 *   128 GB + 4 GB   ₹19,949
 *   128 GB + 6 GB   Out of stock
 *   256 GB + 8 GB   Out of stock
 * — three per-variant stock claims. Reading any of them as the listing's status
 * is the same bug that was fixed on Amazon, so they are stripped before the buy
 * area is examined. The class names are hashed, so this keys off structure and
 * the visible "Out of stock" text rather than a class.
 */
const FLIPKART_VARIANT_SELECTOR = [
  '[class*="swatch"]',
  '[class*="variant"]',
  '[class*="size"]',
  '[class*="Seller"]',
].join(',');

const VARIANT_SELECTOR = [
  '#twister',
  '[id*="twister"]',
  '[id^="variation_"]',
  '[id*="variation_"]',
  '#inline-twister-expander-content',
  '[id*="inline-twister"]',
  '#buyingOptionsTwister',
  '[id*="buyingOptions"]',
  '#aod-offer-list',
  '[id*="aod-"]',
  '[class*="twister"]',
  '#seeMoreOptions',
  '[id*="seeMoreOptions"]',
  '[id*="va-"]',
  '#variationSelectors',
].join(',');

/** Is this element — or anything above it — part of the variant/options table? */
function isInVariantBlock($, el) {
  try {
    return $(el).closest(VARIANT_SELECTOR).length > 0;
  } catch (err) {
    return false;
  }
}

const STRUCK_SELECTOR = [
  '.a-text-price',            // Amazon's struck-through list price wrapper
  '[data-a-strike="true"]',
  '.priceBlockStrikePriceString',
  '.a-price.a-text-price',
  's', 'del', 'strike',
  '[style*="line-through"]',
].join(',');

/** Is this element — or anything above it — a struck-through price? */
function isStruckThrough($, el) {
  try {
    return $(el).closest(STRUCK_SELECTOR).length > 0;
  } catch (err) {
    return false;
  }
}

function firstBuyboxText($, selectors) {
  for (const sel of selectors) {
    const els = $(sel);
    const n = els.length || 0;
    for (let i = 0; i < n; i++) {
      const el = els.eq(i);
      if (isInRelatedBlock($, el)) continue;
      // Not another variant's price. See VARIANT_SELECTOR above.
      if (isInVariantBlock($, el)) continue;
      // Never the struck-through M.R.P. See STRUCK_SELECTOR above.
      if (isStruckThrough($, el)) continue;
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

/**
 * Is this price actually a price?
 *
 * The reliable sources are the structured ones — JSON-LD, the meta tags, the
 * buybox selector. Everything else is a scan of page TEXT, and a store page is
 * full of numbers that are not the price: exchange offers ("Up to ₹6,348 off"),
 * EMI instalments, coupons, accessories. Those scans produced ₹10,490 for a
 * ₹19,999 phone, ₹6,348 for an iQOO Z9s and ₹3,250 for a Motorola G77.
 *
 * The page usually states its MRP, so use it: a scanned price under 40% of the
 * MRP is not a selling price. Refusing it means the card shows no price, which is
 * honest — far better than a wrong one that sends the user chasing a deal that
 * does not exist.
 */
/**
 * The MRP, from page TEXT.
 *
 * The reader gives us the whole page as markdown — "M.R.P.: ₹40,999" included —
 * even when Amazon refuses our own request. Without this the MRP was null for
 * every Amazon product, and a null MRP means priceLooksImplausible() cannot judge
 * anything: that is how a ₹53,999 reading survived on a phone whose MRP is
 * ₹40,999.
 */
/**
 * Availability, from page TEXT.
 *
 * Same reason as mrpFromText: when a store refuses us, the reader's copy of the
 * page is the only evidence we have, and the card was reporting "Out of stock"
 * for products the store showed as in stock.
 *
 * @returns {boolean|null} true = out of stock, false = in stock, null = unstated
 */
/**
 * The part of the reader's markdown that describes THIS product.
 *
 * The reader hands back the whole page as one long blob. On a store page that
 * blob carries the "Products related to this item", "Customers also viewed" and
 * "Similar Products" carousels too, each with its own price and its own
 * availability. Reading the blob whole is how a £19,999 from a DIFFERENT phone
 * became this product's price, and how a "currently unavailable" in a
 * recommendation marked a product that was in stock as out of stock.
 *
 * So we cut the blob at the first related-products heading and read only what
 * comes before it — the buy area, which is where a page states its own price.
 *
 * @returns {string} the buy-area text, or the whole text when no heading is found
 */
function buyboxText(text) {
  const t = String(text || '');
  if (!t) return '';
  const cutters = [
    /\bproducts related to this item\b/i,
    /\bmore items to explore\b/i,
    /\bcustomers (?:also|who) (?:viewed|bought|saw)\b/i,
    /\bcompare with similar items\b/i,
    /\bsimilar products\b/i,
    /\brecently viewed\b/i,
    /\byou might also like\b/i,
    /\brecommended for you\b/i,
  ];
  let cut = -1;
  for (const re of cutters) {
    const m = re.exec(t);
    if (m && (cut < 0 || m.index < cut)) cut = m.index;
  }
  const head = cut > 200 ? t.slice(0, cut) : t;
  // The buy area is the top of the page, so a generous cap keeps the read
  // bounded and stops a runaway page from costing us a second of CPU.
  return head.slice(0, 20000);
}

function availabilityFromText(text) {
  // Read the BUY AREA only. Scanning the whole blob marked products out of
  // stock because a related item or another variant said so further down.
  const t = buyboxText(text).toLowerCase();
  if (!t) return null;

  // 1) The store's own definitive statement that it is NOT available. These
  //    exact phrases are the buybox wording, so they outrank a stray "in stock"
  //    appearing in boilerplate.
  if (/currently unavailable|currently out of stock|temporarily out of stock/.test(t)) return true;

  // 2) A plain "in stock". The lookbehind matters: "back in stock" is a
  //    sentence about the item being UNAVAILABLE, and it contains the phrase.
  if (/(?<!back )\bin stock\b/.test(t)) return false;

  // 3) The remaining, weaker wording.
  //
  // "notify me" alone, not just "notify me when": Flipkart's out-of-stock CTA is
  // a button reading exactly "Notify Me" — it replaces "Buy Now" — and the page
  // that prompted this had no "when" anywhere. The narrower pattern missed it,
  // which is why a plainly out-of-stock listing came back STOCK UNKNOWN.
  if (/\bout of stock\b|\bsold out\b|\bnotify me\b|back in stock/.test(t)) return true;
  return null;
}

function mrpFromText(text) {
  const t = buyboxText(text);
  if (!t) return null;
  const patterns = [
    /(?:m\.?\s?r\.?\s?p\.?|maximum retail price|list price)[^\d₹]{0,40}(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)[^\d]{0,20}(?:m\.?\s?r\.?\s?p\.?)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) {
      const v = parsePrice(m[1]);
      if (v != null && v > 0) return v;
    }
  }
  return null;
}

/**
 * The lowest price any real listing can carry, in rupees.
 *
 * Every other guard needs something else to be correct first — the MRP, the
 * selector, the surrounding wording. On the Galaxy M17 page the scraper read
 * ₹4 as the price and ₹4 as the LOWEST, and the MRP comparison did not catch it
 * because the MRP was read from the same wrong place. A floor does not depend on
 * any of that. Nothing sold on Amazon or Flipkart costs four rupees; the cheapest
 * thing either store lists is a phone case, and not for ₹4.
 */
const ABSOLUTE_MIN_PRICE = Math.max(1, parseInt(process.env.MIN_PLAUSIBLE_PRICE || '20', 10));

function priceLooksImplausible(price, mrp) {
  if (price == null || !isFinite(price) || price <= 0) return false;

  // The floor first, because it needs nothing else to be right.
  if (price < ABSOLUTE_MIN_PRICE) return true;

  // A price far below the MRP is already caught below, but only when an MRP was
  // read. Where the MRP is missing, compare against the largest figure on the
  // page: a "price" under a fifth of it is not a selling price. That is what
  // turned a Rs 18,799 phone into a Rs 3,159 reading on a page where the MRP
  // (33,999) was printed as a bare number with no label.
  // (a flat "under Rs 1000 is wrong" rule was considered and rejected here:
  //  the channel posts fashion deals at Rs 199-899 all day, so it would
  //  throw away real products to catch one bad read. The discount triple
  //  is the fix; this stays out.)

  if (mrp == null || !isFinite(mrp) || mrp <= 0) return false;
  // Below 40% of the MRP: an exchange offer or an EMI instalment. Above the MRP:
  // not a selling price at all. Both were seen in the wild — ₹6,348 (the
  // instalment in "₹6,348 x 3m") and ₹53,999 on a phone whose MRP is ₹40,999.
  if (price < mrp * 0.4 || price > mrp * 1.02) return true;

  // EQUAL to the MRP is the third way this goes wrong, and it is the one that
  // slipped through: on a phone whose M.R.P. is ₹40,999 and whose selling price
  // is ₹28,998, a reading of ₹40,999 was accepted — because ₹40,999 is not
  // "above" ₹40,999, and above-the-MRP was the only comparison being made. The
  // result was a "PRICE INCREASE ALERT +41%" for a price that had not moved,
  // and the M.R.P. shown as the deal.
  //
  // A price equal to the M.R.P. is the M.R.P. wearing the price's name. A store
  // strikes the M.R.P. through precisely because it is not what you pay. A
  // listing genuinely sold at full price is not a deal and not a price move
  // either, so there is nothing here worth recording.
  if (Math.abs(price - mrp) < 0.5) return true;

  return false;
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
/**
 * Availability from the page's structured data, when it states one.
 * @returns {boolean|null} true = out of stock, false = in stock, null = unstated
 */
function availabilityFromJsonLd($) {
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
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const offers = item && item.offers;
        const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const o of list) {
          const a = o && o.availability;
          if (typeof a === 'string') {
            if (/outofstock|soldout|discontinued/i.test(a)) return true;
            if (/instock|limitedavailability|onlineonly|presale|preorder/i.test(a)) return false;
          }
        }
      }
    }
  } catch (err) {
    /* fall through to the page text */
  }
  return null;
}

function detectOutOfStock($) {
  try {
    // 1) Structured availability, when the page states it — but only a claim
    //    about THIS product. A variant page carries an offer per variant, and a
    //    single OutOfStock among them is not the listing's status. So an
    //    out-of-stock verdict from structured data is only believed when the buy
    //    box agrees; an IN-STOCK verdict is believed outright, because that is
    //    the direction that cannot hurt anyone.
    const structured = availabilityFromJsonLd($);

    const strong = [
      'currently out of stock',
      'temporarily out of stock',
      'out of stock',
      'sold out',
      'currently unavailable',
      'notify me', // Flipkart's out-of-stock CTA — it replaces "Buy Now"
    ];

    // 2) The BUYBOX is where availability is actually stated.
    // Read the buy box WITHOUT the variant table.
    //
    // The containers below can contain the twister, and a variant row says
    // "Currently unavailable" in its own right. Joining their raw text therefore
    // lets ANOTHER variant's stock status become this product's status — which is
    // exactly the false OUT OF STOCK that was reported for a phone whose tracked
    // variant was in stock. Each container is cloned and the variant subtree
    // removed before its text is read.
    // AMAZON's buy box.
    const amazonBuybox = [
      '#availability',
      '#buybox',
      '#addToCart',
      '#desktop_buybox',
      '#partialBuybox',
      '.buybox',
    ]
      .map((sel) => {
        try {
          const node = $(sel).first();
          if (!node || !node.length) return '';
          const copy = node.clone();
          copy.find(VARIANT_SELECTOR).remove();
          return copy.text();
        } catch (err) {
          return '';
        }
      })
      .join(' ');

    // FLIPKART's own signals.
    //
    // Flipkart does not have a stable buy-box id — its class names are hashed and
    // change between builds — so the reliable markers are the BUTTONS, which are
    // stable because they are the customer-facing control:
    //   "Notify Me"      -> the out-of-stock CTA; it REPLACES "Buy Now"
    //   "Buy Now" / "Add to cart" -> in stock
    // plus the "Out of stock" text in the buy area.
    //
    // The variant table is stripped first, exactly as for Amazon: a single
    // out-of-stock variant must not mark the whole listing.
    let flipkartSignals = '';
    try {
      const body = $('body').clone();
      body.find(FLIPKART_VARIANT_SELECTOR).remove();
      const buttons = body
        .find('button, a[role="button"], ._2KpZ6l')
        .map((i, el) => $(el).text())
        .get()
        .join(' ');
      flipkartSignals = buttons;
    } catch (err) {
      flipkartSignals = '';
    }

    const buybox = (amazonBuybox + ' ' + flipkartSignals)
      .replace(/\s+/g, ' ')
      .toLowerCase();

    // AN ACTION BEATS A LABEL. CHECKED FIRST, AND THIS ORDER IS THE BUG FIX.
    //
    // Reported: a Flipkart page showing "Add to cart" on the selected variant,
    // "1 left", and the price — marked OUT OF STOCK by the bot. The page also
    // shows "Out of stock" twice, but both are about OTHER things: a colour
    // swatch that is unavailable, and the 256 GB variant.
    //
    // The old order asked "does any text say out of stock?" BEFORE "is there a
    // buy button?". The variant rows are supposed to be stripped first, but
    // Flipkart hashes its class names, so FLIPKART_VARIANT_SELECTOR misses them —
    // and a variant's "Out of stock" won.
    //
    // A purchase button is not a label that can be borrowed by a sibling variant.
    // If the page offers "Add to cart" or "Buy now", the product in front of you
    // is purchasable, and that settles it.
    const hasBuyAction = /\b(add to cart|buy now|buy at|go to cart)\b/.test(buybox);
    if (hasBuyAction) return false;

    const buyboxSaysOut = Boolean(buybox) && strong.some((m) => buybox.includes(m));
    if (buyboxSaysOut) return true;
    // The buy box states in-stock explicitly: believe it over a variant's offer.
    if (buybox && /\bin stock\b/.test(buybox)) return false;

    // Flipkart prints "Out of stock" in the product's own area as well, outside
    // any button. Check the buy AREA (above the reviews and recommendations)
    // rather than the whole body, so a recommendation for an unavailable item
    // cannot mark this one out of stock.
    //
    // The count matters here. One "Out of stock" in the buy area is almost always
    // a sibling variant or an unavailable colour — the page above had exactly
    // two, both for other things. The listing's OWN status appears on its own
    // and, when it is out of stock, the purchase button is gone — which the
    // check above has already established is not the case here.
    try {
      const area = $('#container, ._1YokD2, ._2tsrJ1, main').first();
      if (area && area.length) {
        const copy = area.clone();
        copy.find(FLIPKART_VARIANT_SELECTOR).remove();
        const txt = copy.text().replace(/\s+/g, ' ').toLowerCase();
        // If the page offers NO way to buy, any out-of-stock wording in the buy
        // area is about the listing itself. If it DOES offer one, we have
        // already returned false above — so reaching here means there is no
        // purchase button, and a strong signal is decisive.
        const anyStrong = strong.some((m) => txt.includes(m));
        if (anyStrong) return true;
      }
    } catch (err) {
      /* fall through */
    }

    // Structured data said out of stock and the buy box did not contradict it.
    if (structured === true) return true;

    // 3) NO WHOLE-PAGE FALLBACK.
    //
    // There used to be one here, scanning the body for "currently unavailable"
    // and friends. It is what produced the false OUT OF STOCK ALERT on an item
    // Amazon plainly showed as in stock: the product page carries a variant
    // picker, and an unavailable VARIANT states "Currently unavailable" in its
    // own row. A body scan cannot tell that row from the product's own status,
    // so an out-of-stock colourway marked the whole listing out of stock.
    //
    // The buy box is where a page states ITS OWN availability. If the buy box
    // says nothing and the structured data says nothing, then we do not know —
    // and "we do not know" must not be spelled "out of stock".
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * The first ₹ amount that is actually the PRODUCT's price.
 *
 * A page carries many rupee figures: "Exchange offer: Up to ₹10,490 off",
 * "₹6,845 x 3m", cashback, coupons, sponsored rows. Taking the first one picked
 * an EXCHANGE value and reported a ₹19,999 phone as dropping to ₹10,490. So any
 * figure sitting next to exchange / EMI / coupon wording is skipped.
 */
function firstRealPrice(text) {
  const t = String(text || '');
  if (!t) return null;

  // Judged by ITS OWN wording, not by a wide window: a wide window skipped the
  // real price simply because an exchange line sat nearby.
  const BAD = /\b(exchange|emi|per month|cashback|coupon|off\b|savings?|protect(?:ion)?|assured|bank offer|pay\s*₹|x\s*\d+\s*m\b)\b/i;
  const FIG = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/gi;

  // Work one clause at a time, so a figure is read in its own context.
  const clauses = t.split(/[.!?|·\n]+|\s{2,}/);
  for (const clause of clauses) {
    let m;
    FIG.lastIndex = 0;
    while ((m = FIG.exec(clause)) !== null) {
      const near = clause.slice(Math.max(0, m.index - 30), m.index + 30);
      if (BAD.test(near)) continue;
      const v = parsePrice(m[1]);
      if (v != null) return v;
    }
  }
  return null;
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
  // Every selector is SCOPED to the buy box. The bare 'span.a-price-whole' and
  // '.a-price .a-offscreen' that used to be here match EVERY price on the page —
  // the "Products related to this item" carousels included — and firstText takes
  // the first match in document order, so a neighbouring phone's price could be
  // read as this product's. That is the bug, not one product's bad luck.
  price: [
    // The explicit "price to pay" first — it exists precisely to say which of
    // the figures on the page the customer actually pays.
    '#apexPriceToPay .a-offscreen',
    '#apexPriceToPay span.a-price-whole',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePriceDisplay_desktop_feature_div span.a-price-whole',
    '#corePrice_feature_div span.a-price-whole',
    '#buybox span.a-price-whole',
    '#desktop_buybox span.a-price-whole',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '#ppd span.a-price-whole',
    '#ppd .a-price .a-offscreen',
  ],
  // '#title' was removed: it is a generic id that matches unrelated elements
  // (feature bullets, A+ copy) and produced nonsense names like
  // "Samsung Moonlight Storage Upgrades Lag Free".
  title: ['#productTitle', 'span#productTitle'],
  image: [
    { sel: '#landingImage', attr: 'data-old-hires' },
    { sel: '#landingImage', attr: 'src' },
    { sel: '#imgTagWrapperId img', attr: 'src' },
  ],
};

const FLIPKART = {
  // Same story: these classes appear in the "Similar Products" rows as well as in
  // the buy box, so the read is scoped and carousel matches are skipped below.
  price: [
    // The CURRENT generation of Flipkart class names. Flipkart hashes its
    // classes and reissues them between builds, so this list is append-only:
    // the old names stay in case a page still serves them, and the new ones go
    // in front. The class the user reported (nx3p3z) is the selling price.
    'div.nx3p3z',
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
/**
 * Turn a raw page title into the CLEAN product name.
 * Stores bury the name in spec spam and bracketed variants; the card should
 * show the product's actual name ("Samsung Galaxy M17 5G"), not that pile.
 */
function cleanProductName(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.split(/\s*\|\s*/)[0];
  t = t.replace(/\s*[:\-–]\s*(buy\b|amazon\.in|flipkart\.com|online at best price|price in india).*$/i, '');
  t = t.replace(/\s+(online at best price|price in india|buy online|free shipping|at best price).*$/i, '');
  t = t.replace(
    /\s*\((?:[^()]*(?:\d+\s*(?:gb|tb)|ram|rom|colour|color|silver|black|blue|grey|gray|white|gold|green|purple|pink|titanium)[^()]*)\)/gi,
    ''
  );
  t = t.replace(
    /\s+(?:[A-Za-z]+\s+)*(?:silver|black|blue|grey|gray|white|gold|green|purple|pink|titanium|midnight|graphite|starlight)\b(?:\s+\d+\s*(?:gb|tb))?\s*$/i,
    ''
  );
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

/** A store's own page name is not a product name. */
function isStoreTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return true;
  return /^(amazon(\.in|\.com|\.co\.uk| india)?|flipkart|myntra|ajio|nykaa|meesho|snapdeal|shop online|online shopping|electronics store|buy online)\b/i.test(t);
}

/** The first plausible price in a page's TEXT (deterministic — cannot invent). */
/**
 * As priceFromText, but also saying HOW the number was obtained.
 *
 * 'labelled' and 'mrp-anchored' are the page stating its own price — we can
 * stand behind those. 'first' is a bare "first ₹ in the buy area": a guess, and
 * the one that produced ₹19,999 for a product the store showed at ₹21,999. The
 * caller is told which it got so a guess is never recorded as a reading.
 */
function priceFromTextMatch(text) {
  // Buy area only — a related product's price must never become ours.
  let t = buyboxText(text);
  if (!t) return null;

  // THE BUY BUTTON FIRST, before anything is stripped.
  //
  // "Buy now at ₹19,130" is the page stating the price in the clearest terms,
  // and it belongs to the action the customer takes. It has to be read before
  // the offer blocks are removed, because the strip below reaches past the
  // promo line and would take this with it.
  //
  // Deliberately not matched: "Buy at ₹17,075" (the EMI / WOW DEAL card) and
  // "Buy with EMI". The word "now" is the whole distinction.
  const raw = t;
  const buyButton = /buy\s+now\s+at\s*(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(raw);

  // Strip the offer blocks before scanning the rest, so an instalment, an
  // exchange valuation or a bank-offer discount cannot be read as the price.
  // These sit ABOVE the buy button on a Flipkart page and were a real source of
  // a wrong number (the alert said ₹18,566 for a phone selling at ₹19,130).
  t = t
    .replace(/wow\s*deal[\s\S]{0,120}/gi, ' ')
    .replace(/buy\s+at\s*(?:₹|rs\.?|inr)[\s\S]{0,40}/gi, ' ')
    .replace(/emi[\s\S]{0,60}/gi, ' ')
    .replace(/exchange\s+offer[\s\S]{0,80}/gi, ' ')
    .replace(/bank\s+offers?[\s\S]{0,120}/gi, ' ')
    .replace(/protect\s+promise[\s\S]{0,40}/gi, ' ');

  // 1) A LABELLED price is the page telling us the answer outright.
  const labelled =
    /(?:current price|offer price|deal price|special price|selling price|price)\s*:?\s*(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(t);

  // 1b) THE FLIPKART DISCOUNT TRIPLE: "<percent>% <struck MRP> <price>".
  //
  //     ↓45%  33,999  ₹18,799
  //
  //     Checked before the generic anchors because it is the layout Flipkart uses
  //     on every product page, in a fixed order. The price is the LAST figure in
  //     the triple — the one that follows the struck MRP — and the discount
  //     percent in front of it is what identifies the triple as the real price
  //     block rather than a promo.
  // The percent is matched but NOT captured — m[1] must be the price, because
  // the caller reads m[1]. Capturing the percent first made the price read as
  // "45", which is the kind of bug that looks like a parser fault and is really
  // an off-by-one in the group numbering.
  const discountTriple =
    /(?:↓|⬇|▼|\bdown\b)?\s*(?:\d{1,2})\s*%\s*(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?\s*(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(t);

  // 2) Amazon prints the selling price immediately BEFORE the M.R.P. That
  //    pairing is the most reliable anchor on the page and, unlike "the first ₹
  //    amount", it cannot wander onto a variant or an instalment.
  const beforeMrp =
    /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)[^₹]{0,60}?(?:m\.?\s?r\.?\s?p\.?|maximum retail price)/i.exec(t);

  // 3) The first ₹ in the buy area — the last resort, and the one that guessed
  //    wrong. It is kept only so a page with no labels at all still yields
  //    something, and the caller treats it as unconfirmed.
  const any = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(t);

  const m = buyButton || discountTriple || labelled || beforeMrp || any;
  if (!m) return null;
  const n = Math.round(parseFloat(String(m[1]).replace(/,/g, '')));
  if (!Number.isFinite(n) || n <= 0) return null;
  const kind =
    m === buyButton ? 'labelled'
      : m === discountTriple ? 'labelled'
        : m === labelled ? 'labelled'
          : m === beforeMrp ? 'mrp-anchored'
            : 'first';
  return { price: n, kind };
}

function priceFromText(text) {
  const m = priceFromTextMatch(text);
  return m ? m.price : null;
}

/**
 * Last-resort data for a store that refuses this host (Amazon).
 *
 * A reader service fetches the page from ITS servers, and a hosted product API
 * answers directly — neither is affected by our IP being blocked. Both are
 * optional and best-effort: any failure returns null.
 */
async function lastResortProduct(url, marketplace) {
  const out = { title: null, price: null, priceKind: null, image: null, inStock: null, mrp: null };

  // FOR AMAZON, THE HOSTED API COMES FIRST — and this order is the whole point.
  //
  // It returns the BUYBOX price and availability as structured fields, which is
  // exactly what a page parser is trying to approximate. The reader, by contrast,
  // hands back the page as free text and we have to guess which number is the
  // price. The reported product made the cost of getting this order wrong plain:
  // the store showed ₹21,999, the card showed ₹22,999, and neither ₹22,999 nor the
  // ₹19,999 before it appears anywhere on the page at all — because they came from
  // the text scan, which is a guess.
  //
  // So when the API is configured we ask it FIRST and take its price and stock as
  // authoritative; the reader is still used for the title, image and MRP, which it
  // does reliably.
  if (marketplace === 'amazon' && amazonApiConfigured()) {
    const asin = /\/dp\/([A-Z0-9]{10})/i.exec(url) || /\/([A-Z0-9]{10})(?:[/?]|$)/.exec(url);
    const item = asin && asin[1] ? await lookupAsinApi(asin[1]).catch(() => null) : null;
    if (item) {
      if (item.title && !isStoreTitle(item.title)) out.title = item.title;
      out.price = item.price;
      if (item.price != null) out.priceKind = 'api';
      out.image = item.image;
      out.inStock = item.inStock;
      out.mrp = item.mrp;
      console.log(
        'scrape: amazon buybox from the hosted API — price=' + (item.price != null ? item.price : 'none') +
          ' inStock=' + (item.inStock != null ? item.inStock : 'unknown')
      );
    }
  }

  // The reader fills in whatever the API could not supply — and for Flipkart,
  // where there is no hosted API, it is the only route.
  const page = await fetchReadablePage(url, { timeoutMs: 20000, attempts: 2 }).catch(() => null);
  if (page) {
    if (!out.title && page.title && !isStoreTitle(page.title)) out.title = page.title;
    if (out.price == null) {
      const pm = priceFromTextMatch(page.text);
      if (pm) { out.price = pm.price; out.priceKind = pm.kind; }
    }
    if (out.mrp == null) out.mrp = mrpFromText(page.text);
    if (out.inStock == null) out.inStock = availabilityFromText(page.text);
    if (!out.image) {
      const img = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)/.exec(page.text || '');
      if (img) out.image = img[1].replace(/^http:/i, 'https:');
    }
  }

  return out.title || out.price != null || out.image ? out : null;
}

async function fetchProduct(productUrl, marketplace) {
  if (!productUrl) return { ok: false, reason: 'no_url' };

  const cfg = marketplace === 'flipkart' ? FLIPKART : AMAZON;
  const isFlipkart = marketplace === 'flipkart';

  // NOTE: we deliberately do NOT canonicalise a Flipkart URL up front any more.
  // The page we were handed — even a ?pid= form — serves og:title, whereas the
  // canonical search costs seconds we do not have (and timed the fetch out).
  let targetUrl = productUrl;
  // A share link carries no product identity, and the Flipkart APP form
  // (/product/p/itme?pid=…) is not a product page at all — fetching it returns
  // HTTP 500. Expand it first, here, so EVERY caller benefits.
  if (isShortLink(targetUrl)) {
    const expanded = await expandShortLink(targetUrl).catch(() => null);
    if (expanded && expanded !== targetUrl) {
      console.log('scrape: expanded ' + String(targetUrl).slice(0, 45) + ' -> ' + String(expanded).slice(0, 70));
      targetUrl = expanded;
    }
  }
  let resolvedUrl = null;

  let cookies = '';
  if (isFlipkart) cookies = await warmFlipkart();
  if (!isFlipkart && /amazon\./i.test(targetUrl)) cookies = await warmAmazon();

  // ---- Amazon via the OFFICIAL API -----------------------------------------
  // Amazon refuses page requests from this host, so scraping it is a dead end.
  // PA-API is authenticated and meant for servers, so it is not blocked and
  // returns the title, price, MRP, image and availability directly.
  if (marketplace === 'amazon' && paapiConfigured()) {
    const asin = /\/dp\/([A-Z0-9]{10})/i.exec(targetUrl) || /\/([A-Z0-9]{10})(?:[/?]|$)/.exec(targetUrl);
    if (asin && asin[1]) {
      const item = await lookupAsin(asin[1]);
      if (item) {
        console.log('scrape: amazon ' + asin[1] + ' resolved via PA-API');
        return {
          ok: item.price != null,
          reason: item.price != null ? null : 'price_not_found',
          marketplace: 'amazon',
          title: item.title,
          price: item.price,
          currency: 'INR',
          mrp: item.mrp,
          imageUrl: item.image,
          inStock: item.inStock,
          resolvedUrl: 'https://www.amazon.in/dp/' + asin[1],
          source: 'paapi',
        };
      }
    }
  }

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

    // OPTIONAL: when the page gave us no usable name — Amazon refuses this host
    // — ask a licensed search API for Amazon results and read the name from
    // them. Snippets only, so the token cost is tiny.
    if (!title && searchConfigured()) {
      let asinMatch = /\/dp\/([A-Z0-9]{10})/i.exec(targetUrl) || /\/([A-Z0-9]{10})(?:[/?]|$)/.exec(targetUrl);
      let searchUrl = targetUrl;

      // A short link (amzn.in/d/…, amzn.to/…) carries NO ASIN, so searching for
      // it finds nothing useful. Expand it first and take the ASIN from the
      // resolved product URL.
      if (!asinMatch) {
        try {
          const { resolveShortUrl } = require('./affiliate');
          const expanded = await resolveShortUrl(targetUrl);
          if (expanded && expanded !== targetUrl) {
            searchUrl = expanded;
            asinMatch =
              /\/dp\/([A-Z0-9]{10})/i.exec(expanded) || /\/([A-Z0-9]{10})(?:[/?]|$)/.exec(expanded);
            console.log('scrape: expanded ' + targetUrl.slice(0, 40) + ' -> ' + expanded.slice(0, 70));
          }
        } catch (err) {
          /* search by the URL we have */
        }
      }

      const fromSearch = await searchProductTitle({
        asin: asinMatch ? asinMatch[1] : null,
        url: searchUrl,
      });
      if (fromSearch && !looksGenericTitle(fromSearch)) {
        title = fromSearch;
        console.log('scrape: name recovered via search — ' + String(fromSearch).slice(0, 70));
      }
    }

    // The HuggingFace title fallback that used to sit here has been REMOVED.
    // api-inference.huggingface.co no longer resolves — HuggingFace retired that
    // host — so whenever HF_TOKEN was set this was a guaranteed-failing call on
    // every weak title. See the note in .env.example.
    // The MRP is read FIRST, because it is the yardstick every candidate price is
    // measured against.
    let mrp = mrpFromPage($);

    // EVERY source is validated — including the CSS selector and the structured
    // data. "Structured" does not mean "right": on Flipkart the price selector
    // matches the EMI row, which is how ₹6,348 — the instalment in
    // "₹6,348 x 3m" — came to be recorded as the price on every single check, and
    // the page's own history then read ₹6,348 for current, high, low AND average.
    // A source that fails the check falls through to the next.
    const candidates = [
      ['selector', () => parsePrice(firstBuyboxText($, cfg.price))],
      ['json-ld', () => priceFromJsonLd($)],
      ['meta', () => priceFromMeta($)],
      [
        'page text',
        () => {
          const head = $.html().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 40000);
          return firstRealPrice(head);
        },
      ],
    ];

    let price = null;

    let priceKind = null;
    for (const pair of candidates) {
      let candidate = null;
      try {
        candidate = pair[1]();
      } catch (err) {
        candidate = null;
      }
      if (candidate == null) continue;
      if (priceLooksImplausible(candidate, mrp)) {
        console.warn(
          'scrape: ignored the ' + pair[0] + ' price ' + candidate + ' — ' +
            (candidate > mrp ? 'above the MRP ' + mrp : 'under 40% of the MRP ' + mrp) +
            ' (an EMI, exchange or variant figure, not the selling price)'
        );
        continue;
      }
      price = candidate;
      break;
    }
    // The HuggingFace price fallback has been REMOVED: the endpoint it called is
    // gone. A price now has to come from a real source.

    // An MRP at or below the selling price is not a real discount — drop it.
    if (mrp != null && price != null && mrp <= price) mrp = null;

    // let, not const: both of these are REASSIGNED below when the page was too
    // thin to supply them and the reader/hosted API fills the gap. Declaring them
    // const threw "Assignment to constant variable" and took the whole product
    // check down with it — the log showed 'product FAILED … Assignment to
    // constant variable' right after a successful name recovery.
    let imageUrl = imageFromPage($, cfg);

    // Availability, from our own page — but ONLY when the page actually loaded.
    //
    // detectOutOfStock() always returns a boolean, so `!detectOutOfStock($)` was
    // never null. That made the line below — `if (inStock == null && last.inStock
    // != null)` — DEAD CODE, and the reader's answer was silently discarded on
    // every product. For a store that refuses us, the "availability" being used
    // was therefore a read of a robot-check page, which is why cards said
    // "Out of stock" for products the store plainly shows as "In stock".
    //
    // Leaving it null when the page is unusable is what lets the reader's copy of
    // the page supply the answer instead.
    const pageUsable = !looksBlocked($.html()) && $('body').text().trim().length > 500;
    let inStock = pageUsable ? !detectOutOfStock($) : null;
    if (price == null || !title) {
      // The store refuses this host (Amazon). Try a reader service and a hosted
      // product API — neither is affected by our IP being blocked.
      const last = await lastResortProduct(targetUrl, marketplace).catch(() => null);
      if (last) {
        if (!title && last.title) title = last.title;
        // The MRP to judge by: the page's own, or the one the reader/hosted API
        // could see when the page refused us. Without this fallback the MRP was
        // null for every Amazon product and the check silently passed everything.
        const effectiveMrp = mrp != null ? mrp : last.mrp != null ? last.mrp : null;
        if (price == null && last.price != null) {
          if (priceLooksImplausible(last.price, effectiveMrp)) {
            console.warn(
              'scrape: ignored the last-resort price of ' + last.price + ' — ' +
                (effectiveMrp && last.price > effectiveMrp
                  ? 'above the MRP ' + effectiveMrp
                  : 'under 40% of the MRP ' + effectiveMrp) +
                ' (from the reader/hosted API, not a selling price)'
            );
          } else {
            price = last.price;
            priceKind = last.priceKind || 'text';
          }
        }
        if (mrp == null && last.mrp != null && (price == null || last.mrp > price)) {
          mrp = last.mrp;
        }
        if (!imageUrl && last.image) imageUrl = last.image;
        if (inStock == null && last.inStock != null) inStock = last.inStock;
        console.log(
          'scrape: last-resort data used — title="' + String(title || '').slice(0, 45) +
            '" price=' + (price != null ? price : 'none')
        );
      }
    }

    if (price == null) return { ok: false, reason: 'price_not_found', title, resolvedUrl, inStock };

    return {
      ok: true,
      price,
      // 'first' means the number is a bare guess at the buy area's first ₹, not
      // the page stating its price. The caller must not record it as a reading.
      priceKind: priceKind || 'page',
      guess: priceKind === 'first',
      currency: 'INR',
      title: cleanProductName(title) || title || null,
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
  availabilityFromJsonLd,
  titleFromJsonLd,
  priceFromJsonLd,
  priceFromMeta,
  mrpFromPage,
  imageFromPage,
  firstRealPrice,
  mrpFromText,
  availabilityFromText,
  buyboxText,
  firstBuyboxText,
  isStruckThrough,
  STRUCK_SELECTOR,
  VARIANT_SELECTOR,
  FLIPKART_VARIANT_SELECTOR,
  isInVariantBlock,
  ABSOLUTE_MIN_PRICE,
  isInRelatedBlock,
  RELATED_SELECTOR,
  priceFromTextMatch,
  priceLooksImplausible,
  resolveFlipkartUrl,
  isCanonicalFlipkart,
  resolveProductName,
};
