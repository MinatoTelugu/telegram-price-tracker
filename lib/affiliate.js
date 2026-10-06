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

// A normal browser UA gets us past the bot filters on the short-link redirects.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-IN,en;q=0.9',
};

// Hosts that are pure redirectors -> marketplace they eventually land on.
const SHORT_HOSTS = {
  'amzn.to': 'amazon',
  'amzn.in': 'amazon',
  'a.co': 'amazon',
  'fkrt.it': 'flipkart',
};

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
 * Follow a redirecting short link and return the final URL.
 * Returns null if it cannot be resolved (caller then reports "unsupported").
 */
async function resolveShortUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 10,
      timeout: 10000,
      validateStatus: () => true, // don't throw on 3xx/4xx; we just want the URL
      headers: BROWSER_HEADERS,
    });
    return (
      (res.request && res.request.res && res.request.res.responseUrl) ||
      res.config.url ||
      null
    );
  } catch (err) {
    return null;
  }
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

  // Resolve redirectors first so we can classify the final destination.
  const bareHost = url.hostname.toLowerCase().replace(/^www\./, '');
  if (SHORT_HOSTS[bareHost]) {
    const resolved = await resolveShortUrl(raw);
    if (!resolved) return { ok: false, reason: 'shortlink_unresolved', input: inputUrl };
    try {
      url = new URL(resolved);
    } catch (err) {
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
    };
  }

  if (marketplace === 'flipkart') {
    const pid = extractFlipkartPid(url);
    if (!pid) return { ok: false, reason: 'flipkart_id_not_found', input: inputUrl };
    const cleanUrl = 'https://www.flipkart.com' + url.pathname + '?pid=' + pid;
    const affiliateUrl = buildFlipkartUrl(url.href, pid);
    return {
      ok: true,
      marketplace: 'flipkart',
      productId: pid,
      cleanUrl,
      affiliateUrl,
      hasAffiliateTag: Boolean(process.env.FLIPKART_AFFILIATE_ID),
      originalUrl: inputUrl,
    };
  }

  // Any other platform: hand the link back unchanged, with no affiliate tag.
  // (Price tracking is only available for Amazon/Flipkart.)
  return {
    ok: true,
    marketplace: 'other',
    productId: null,
    cleanUrl: url.href,
    affiliateUrl: url.href,
    hasAffiliateTag: false,
    originalUrl: inputUrl,
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
};
