/**
 * lib/amazonapi.js
 * ---------------------------------------------------------------------------
 * Amazon product data from a HOSTED third-party API.
 *
 * Why a hosted API and not the open-source repo: the open-source project
 * (omkarcloud/amazon-scraper) is a scraper you run YOURSELF — `python run.py`
 * on your own machine. Running it on our server means the request still leaves
 * from OUR IP, so Amazon refuses it exactly as it refuses our own scraper. The
 * repo's own notes confirm it needs a residential proxy, and it gets through by
 * impersonating a browser's TLS fingerprint. That is evasion of Amazon's bot
 * detection, which we do not do.
 *
 * A hosted endpoint is a different thing: it fetches from the VENDOR's servers,
 * so the block does not apply, and it is a licensed service rather than an
 * attempt to look like a browser.
 *
 * ONE provider:
 *   RapidAPI — 1,000 free calls/month.
 *     RAPIDAPI_KEY=...
 *
 * REMOVED: Omkar Cloud's direct API. Its key answered
 * 404 {"status":404,"message":"Not Found"} on BOTH documented paths
 * (/amazon/product-details and /products/details) on every single call, which is
 * what an unprovisioned key looks like. A provider that never returns a result
 * is not a fallback — it is a wasted round trip on every price check, and it
 * buried the real failure in the log.
 *
 * Note that RapidAPI's listing here IS Omkar Cloud's scraper
 * (rapidapi.com/OmkarCloud/api/best-amazon-scraper-free-1000-calls), the same
 * company with a ten times larger free tier. So nothing is lost: the direct key
 * was a second, smaller allowance of the SAME data.
 *
 * Note on "no signup": that applies to their PLAYGROUND, which runs live
 * requests in the browser. The documented API itself is keyed. We call the
 * documented API, not an undocumented internal route, because an undocumented
 * endpoint is not a contract — it can change or be blocked without notice and
 * would fail silently in production.
 *
 * The free tier is small (roughly 33/day), so this is a LAST RESORT: fired only
 * when the page, the metadata service, the reader and the search API have all
 * come back empty.
 *
 * Configuration — environment variables only, never hardcode a key:
 *   RAPIDAPI_KEY           RapidAPI key
 *   AMAZON_API_HOST        default best-amazon-scraper-free-1000-calls.p.rapidapi.com
 *   AMAZON_API_COUNTRY     default IN   (amazon.in)
 *   AMAZON_API_TIMEOUT_MS  default 20000
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_RAPIDAPI_HOST = 'best-amazon-scraper-free-1000-calls.p.rapidapi.com';
// RapidAPI's first call to an endpoint can be slow while it warms up, and 12s
// was timing out. This runs after the user has been answered, so patience is free.
const TIMEOUT = parseInt(process.env.AMAZON_API_TIMEOUT_MS || '20000', 10);

function amazonApiConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

function country() {
  return process.env.AMAZON_API_COUNTRY || 'IN';
}

/** Map either provider's payload onto the shape the bot uses. */
function normalise(d) {
  if (!d || typeof d !== 'object') return null;
  // The provider returns an array; tolerate a bare object too.
  const item = Array.isArray(d) ? d[0] : d;
  if (!item || typeof item !== 'object') return null;

  const title = item.title ? String(item.title).replace(/\s+/g, ' ').trim() : null;
  const price = item.price && item.price.amount != null ? Math.round(Number(item.price.amount)) : null;
  const mrp = item.price && item.price.list_price != null ? Math.round(Number(item.price.list_price)) : null;

  let image = null;
  if (Array.isArray(item.images) && item.images.length) {
    const main =
      item.images.find((i) => i && /main/i.test(String(i.variant || ''))) || item.images[0];
    if (main) image = main.link || main.large || main.hi_res || null;
    if (image) image = String(image).replace(/^http:/i, 'https:');
  }

  const inStock =
    item.availability && typeof item.availability.is_in_stock === 'boolean'
      ? item.availability.is_in_stock
      : null;

  if (!title && price == null && !image) return null;
  return {
    title,
    price: Number.isFinite(price) ? price : null,
    mrp: Number.isFinite(mrp) && price != null && mrp > price ? mrp : null,
    image,
    inStock,
  };
}

/** RapidAPI (1,000 free calls/month). */
async function viaRapidApi(asin) {
  const host = process.env.AMAZON_API_HOST || DEFAULT_RAPIDAPI_HOST;
  const res = await axios.get('https://' + host + '/products/details', {
    params: { product: String(asin), country: country() },
    headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': host },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    console.warn(
      'amazon api (rapidapi): status ' + res.status + ' for ' + asin +
        ' body=' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 200)
    );
    return null;
  }
  return normalise(res.data);
}

/**
 * @returns {Promise<{title: string|null, price: number|null, mrp: number|null, image: string|null, inStock: boolean|null}|null>}
 */
async function lookupAsin(asin) {
  if (!amazonApiConfigured() || !asin) return null;

  // RapidAPI first: its free tier is the larger one.
  if (process.env.RAPIDAPI_KEY) {
    try {
      const a = await viaRapidApi(asin);
      if (a) return Object.assign({ source: 'rapidapi' }, a);
    } catch (err) {
      console.warn('amazon api (rapidapi) failed for ' + asin + ': ' + err.message);
    }
  }

  return null;
}

module.exports = { lookupAsin, amazonApiConfigured };
