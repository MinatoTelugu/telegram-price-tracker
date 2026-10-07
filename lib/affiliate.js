/**
 * lib/affiliate.js
 * ---------------------------------------------------------------------------
 * Affiliate link conversion via the "URL cleaning" method (no product API).
 *
 * Strategy per marketplace:
 *   Amazon   -> resolve short links (amzn.to / a.co), pull the ASIN out of any
 *               of the common URL shapes, then rebuild a canonical
 *               https://www.amazon.<tld>/dp/<ASIN>?tag=<AFFILIATE_TAG>.
 *   Flipkart -> resolve short links (fkrt.it), pull the product id (pid), then
 *               rebuild https://www.flipkart.com/<path>?pid=<pid>&affid=<ID>.
 *
 * Every rebuild drops the tracking junk (?ref, ?pd_rd_*, ?utm_*, ?psc, ...) that
 * the original link carried, which is the whole point of "cleaning".
 *
 * Env vars used here:
 *   AMAZON_AFFILIATE_TAG            -> default tag for every Amazon domain
 *   AMAZON_AFFILIATE_TAG_<TLD>      -> optional per-domain override, e.g.
 *                                      AMAZON_AFFILIATE_TAG_CO_UK, _IN, _COM
 *   FLIPKART_AFFILIATE_ID           -> your Flipkart affiliate id (affid)
 *
 * NOTE: ExtraPe (or any other network) can later be added as one more branch
 * inside convertAffiliateLink() — the return shape stays the same.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const crypto = require('crypto');
const { convertWithProvider, converterConfigured } = require('./converter');

// A normal browser UA plus the usual navigation headers gets us past the bot
// filters on the short-link redirects.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  Connection: 'keep-alive',
};

// Hosts that are pure redirectors -> marketplace they eventually land on.
const SHORT_HOSTS = {
  'amzn.to': 'amazon',
  'amzn.in': 'amazon',
  'a.co': 'amazon',
  'fkrt.it': 'flipkart',
  // Flipkart's app "Share" links live on this subdomain and are pure redirects.
  'dl.flipkart.com': 'flipkart',
};

/**
 * Flipkart app share links also appear as flipkart.com/s/XXXX (no subdomain),
 * which is a redirect too — treat it as a short link.
 */
function isFlipkartShareLink(urlObj) {
  const host = String(urlObj.hostname || '').toLowerCase().replace(/^www\./, '');
  return host.endsWith('flipkart.com') && /^\/s\//i.test(urlObj.pathname);
}

/** Which marketplace (if any) a hostname belongs to. */
function detectMarketplace(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  if (/(^|\.)amazon\.[a-z.]+$/.test(host)) return 'amazon';
  if (host === 'flipkart.com' || host.endsWith('.flipkart.com')) return 'flipkart';
  if (SHORT_HOSTS[host]) return SHORT_HOSTS[host];
  return null;
}

/** Amazon domain suffix, e.g. "in", "com", "co.uk". Defaults to "in". */
function amazonTld(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const m = host.match(/amazon\.([a-z.]+)$/);
  return m ? m[1] : 'in';
}

/** Resolve the affiliate tag for an Amazon TLD, with a global fallback. */
function amazonTagFor(tld) {
  const key = 'AMAZON_AFFILIATE_TAG_' + tld.toUpperCase().replace(/\./g, '_');
  return process.env[key] || process.env.AMAZON_AFFILIATE_TAG || '';
}

// Common Amazon URL shapes: /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN,
// /d/ASIN, /product/ASIN, and ?asin=ASIN.
const AMAZON_ASIN_PATTERNS = [
  /\/(?:dp|gp\/product|gp\/aw\/d|d|product|ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i,
  /[?&](?:asin|ASIN)=([A-Z0-9]{10})(?:[&#]|$)/,
];

function extractAmazonAsin(urlString) {
  for (const re of AMAZON_ASIN_PATTERNS) {
    const m = urlString.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** Flipkart product id: ?pid=... or the /p/itmXXXX slug segment. */
function extractFlipkartPid(urlObj) {
  const pid = urlObj.searchParams.get('pid');
  if (pid) return pid;
  const m = urlObj.pathname.match(/\/p\/(itm[a-z0-9]+)/i);
  return m ? m[1] : null;
}

/**
 * Redirect chains often end on a tracking page whose real destination is in a
 * QUERY PARAMETER rather than another redirect. EarnKaro does exactly this:
 *
 *   https://trackingv3.linkredirect.in/visitretailer/2276?id=...
 *     &dl=https%3A%2F%2Fwww.flipkart.com%2Fai-pulse-2-blue-64-gb%2Fp%2Fitm...
 *
 * That `dl` value IS the canonical store URL — with the product-name slug in
 * it. Pulling it out lets us name the product without fetching the store.
 */
function extractDestinationFromQuery(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (err) {
    return null;
  }
  const keys = ['dl', 'url', 'dest', 'destination', 'redirect', 'target', 'link', 'to', 'u'];
  for (const key of keys) {
    const value = u.searchParams.get(key);
    if (value && /^https?:\/\//i.test(value) && value !== urlStr) return value;
  }
  return null;
}

/**
 * Should we follow this in-page redirect? Only if it is MORE specific.
 * A generic page's <link rel="canonical"> often points at a bare, parameter-less
 * version of itself (e.g. /product/p/itme, dropping the pid). Following that
 * throws away the product id and lands on a page that errors.
 */
function isMoreSpecific(candidate, current) {
  try {
    const a = new URL(candidate);
    const b = new URL(current);
    if (a.pathname === b.pathname && a.search === b.search) return false; // identical
    if (a.pathname.length > b.pathname.length) return true; // deeper path wins
    if (a.pathname === b.pathname) return false; // same page, just different params
    if (!a.search && b.search) return false; // shorter path AND drops the pid
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Pull a redirect target out of an HTML page. Many share links answer with a
 * 200 and then redirect from INSIDE the page (canonical link or meta refresh)
 * rather than with a 3xx — which is why a plain redirect-follower finds nothing.
 */
function extractRedirectTarget(html, baseUrl) {
  if (typeof html !== 'string' || !html) return null;
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^"';]*url=([^"';]+)/i,
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      try {
        const next = new URL(m[1].trim(), baseUrl).toString();
        if (next !== baseUrl) return next;
      } catch (err) {
        /* ignore an unparseable target */
      }
    }
  }
  return null;
}

/**
 * Follow a redirecting short link and return the final URL.
 *
 * We do NOT rely on axios's automatic redirect handling: Flipkart's
 * dl.flipkart.com links can answer with a non-standard redirect, and some
 * servers refuse to be auto-followed. So we hop manually, reading the Location
 * header ourselves, and only then fall back to auto-following.
 *
 * Returns null if it cannot be resolved (caller reports "unsupported").
 */
async function resolveShortUrl(shortUrl) {
  // 1) Manual hop-by-hop using the Location header.
  let current = shortUrl;
  try {
    for (let hop = 0; hop < 8; hop++) {
      let res = null;
      try {
        res = await axios.get(current, {
          maxRedirects: 0,
          timeout: 10000,
          validateStatus: () => true,
          headers: BROWSER_HEADERS,
        });
      } catch (err) {
        // Some stacks throw on a 3xx when maxRedirects is 0 — read it anyway.
        res = err && err.response ? err.response : null;
        if (!res) break;
      }

      const status = Number(res.status || 0);
      const headers = res.headers || {};
      const location = headers.location || headers.Location || null;
      console.log('shortlink hop', hop, current, '->', status, location ? '(location)' : '');

      if (location && status >= 300 && status < 400) {
        try {
          current = new URL(location, current).toString();
        } catch (err) {
          break;
        }
        continue;
      }

      // A tracking page carries the real destination in a query parameter.
      const viaQuery = extractDestinationFromQuery(current);
      if (viaQuery) {
        console.log('shortlink query destination ->', viaQuery);
        current = viaQuery;
        continue;
      }

      if (status >= 200 && status < 300) {
        // A 200 can still be a redirect done inside the page (canonical link or
        // meta refresh) — but ONLY follow it when it is more specific. Chasing a
        // generic, parameter-less canonical throws away the pid and 500s.
        const inPage = extractRedirectTarget(res.data, current);
        if (inPage && isMoreSpecific(inPage, current)) {
          console.log('shortlink in-page redirect ->', inPage);
          current = inPage;
          continue;
        }
        return current;
      }
      break;
    }
  } catch (err) {
    /* fall through */
  }

  // If the manual hops got us somewhere, that is the best answer we have — even
  // if a LATER hop timed out. This matters: a converter link redirects to the
  // real store URL, and that store may drop connections from this host, but the
  // hop before it already handed us the canonical product URL.
  if (current && current !== shortUrl) return current;

  // 2) Fallback: let axios follow the chain and report where it landed.
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 10,
      timeout: 10000,
      validateStatus: () => true,
      headers: BROWSER_HEADERS,
    });
    const landed =
      (res.request && res.request.res && res.request.res.responseUrl) ||
      (res.config && res.config.url) ||
      null;
    return landed && landed !== shortUrl ? landed : null;
  } catch (err) {
    return null;
  }
}

/**
 * A tracking id for a Flipkart link that has no usable pid, so it can still be
 * tracked (and get a stable Firestore doc id). Prefers the /p/itmXXXX segment,
 * then falls back to a hash of the path.
 */
function fallbackFlipkartProductId(urlObj) {
  const m = urlObj.pathname.match(/\/p\/(itm[a-z0-9]+)/i);
  if (m) return m[1];
  return 'u' + crypto.createHash('sha1').update(urlObj.pathname + urlObj.search).digest('hex').slice(0, 10);
}

function buildAmazonUrl(asin, hostname) {
  const tld = amazonTld(hostname);
  const base = 'https://www.amazon.' + tld + '/dp/' + asin;
  const tag = amazonTagFor(tld);
  return tag ? base + '?tag=' + encodeURIComponent(tag) : base;
}

function buildFlipkartUrl(productUrl, pid) {
  const u = new URL(productUrl);
  u.protocol = 'https:';
  u.host = 'www.flipkart.com';
  u.search = ''; // drop every tracking param
  u.hash = '';
  const base = u.toString();
  const q = new URLSearchParams();
  if (pid) q.set('pid', pid);
  const affid = process.env.FLIPKART_AFFILIATE_ID || '';
  if (affid) q.set('affid', affid);
  const qs = q.toString();
  return qs ? base + '?' + qs : base;
}

/**
 * Main entry point.
 * @param {string} inputUrl  Raw link from the Telegram message.
 * @returns {Promise<object>} Conversion result (see shapes below).
 *
 * Success:
 *   { ok:true, marketplace, productId, cleanUrl, affiliateUrl, hasAffiliateTag }
 * Failure:
 *   { ok:false, reason, input }
 */
async function convertAffiliateLink(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { ok: false, reason: 'empty_input', input: inputUrl };
  }

  let raw = inputUrl.trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid_url', input: inputUrl };
  }

  // Resolve redirectors FIRST so we can classify the final destination. This
  // includes dl.flipkart.com app share links and flipkart.com/s/ links — if we
  // skip this, the fetch lands on a generic store page and we end up with a
  // useless title like "Flipkart store 2" instead of the product name.
  const bareHost = url.hostname.toLowerCase().replace(/^www\./, '');
  if (SHORT_HOSTS[bareHost] || isFlipkartShareLink(url)) {
    const resolved = await resolveShortUrl(raw);
    if (resolved) {
      try {
        url = new URL(resolved);
      } catch (err) {
        /* keep the original */
      }
    } else {
      // Do NOT fail here. A Flipkart share link is still a Flipkart link, and
      // the converter can usually convert it as-is — so hand it over instead of
      // telling the user the link is broken.
      const market = SHORT_HOSTS[bareHost] || 'flipkart';
      console.warn('short link unresolved (' + raw + '); handing it to the converter as-is');
      if (market === 'flipkart') {
        const convertedShare = await convertWithProvider(raw);
        if (convertedShare) {
          return {
            ok: true,
            marketplace: 'flipkart',
            productId: fallbackFlipkartProductId(url),
            cleanUrl: raw,
            affiliateUrl: convertedShare,
            hasAffiliateTag: true,
            originalUrl: inputUrl,
            resolvedUrl: null,
            viaConverter: true,
          };
        }
      }
      return { ok: false, reason: 'shortlink_unresolved', input: inputUrl };
    }
  }

  const marketplace = detectMarketplace(url.hostname);

  if (marketplace === 'amazon') {
    const asin = extractAmazonAsin(url.href);
    if (!asin) return { ok: false, reason: 'asin_not_found', input: inputUrl };
    const cleanUrl = buildAmazonUrl(asin, url.hostname);
    const tag = amazonTagFor(amazonTld(url.hostname));
    return {
      ok: true,
      marketplace: 'amazon',
      productId: asin,
      cleanUrl,
      affiliateUrl: cleanUrl,
      hasAffiliateTag: Boolean(tag),
      originalUrl: inputUrl,
      // The FULL resolved URL — it still carries the product-name slug, which
      // is how we derive the product title without scraping.
      resolvedUrl: url.href,
    };
  }

  if (marketplace === 'flipkart') {
    const realPid = extractFlipkartPid(url);
    const pid = realPid || fallbackFlipkartProductId(url);
    // Only put a REAL pid in the clean URL. A synthesised id there would build
    // a Flipkart URL that 404s, which is what stopped the name resolving.
    const cleanUrl = realPid ? 'https://www.flipkart.com' + url.pathname + '?pid=' + realPid : url.href;

    // Hybrid: Flipkart goes through the converter FIRST. EarnKaro converts any
    // Flipkart link, so a link without a recognisable pid still works — we must
    // not bail out before giving the converter a chance.
    const converted = await convertWithProvider(url.href);
    if (converted) {
      return {
        ok: true,
        marketplace: 'flipkart',
        productId: pid,
        cleanUrl,
        affiliateUrl: converted,
        hasAffiliateTag: true,
        originalUrl: inputUrl,
        resolvedUrl: url.href,
        viaConverter: true,
      };
    }

    // No converter configured: we need a real pid to build a Flipkart link.
    if (!realPid) return { ok: false, reason: 'flipkart_id_not_found', input: inputUrl };

    const affiliateUrl = buildFlipkartUrl(url.href, realPid);
    return {
      ok: true,
      marketplace: 'flipkart',
      productId: realPid,
      cleanUrl,
      affiliateUrl,
      hasAffiliateTag: Boolean(process.env.FLIPKART_AFFILIATE_ID),
      originalUrl: inputUrl,
      resolvedUrl: url.href,
    };
  }

  // Any other platform: route it through the converter too (EarnKaro supports
  // 200+ stores). If the converter is not configured, hand the link back as-is.
  const convertedOther = await convertWithProvider(url.href);
  if (convertedOther) {
    return {
      ok: true,
      marketplace: 'other',
      productId: null,
      cleanUrl: url.href,
      affiliateUrl: convertedOther,
      hasAffiliateTag: true,
      originalUrl: inputUrl,
      resolvedUrl: url.href,
      viaConverter: true,
    };
  }

  return {
    ok: true,
    marketplace: 'other',
    productId: null,
    cleanUrl: url.href,
    affiliateUrl: url.href,
    hasAffiliateTag: false,
    originalUrl: inputUrl,
    resolvedUrl: url.href,
  };
}

/** Quick check without doing network I/O — used to filter incoming messages. */
function isSupportedLink(inputUrl) {
  try {
    let raw = String(inputUrl || '').trim();
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return Boolean(detectMarketplace(host));
  } catch (err) {
    return false;
  }
}

module.exports = {
  convertAffiliateLink,
  isSupportedLink,
  detectMarketplace,
  extractAmazonAsin,
  resolveShortUrl,
  converterConfigured,
  isFlipkartShareLink,
  extractRedirectTarget,
  extractDestinationFromQuery,
  isMoreSpecific,
};
