/**
 * lib/amazonapi.js
 * ---------------------------------------------------------------------------
 * Amazon product data from HOSTED third-party APIs (Omkar Cloud's Amazon
 * Scraper).
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
 * TWO providers are supported, and whichever keys you have are used:
 *
 *   1. RapidAPI — 1,000 free calls/month. The more generous free tier, so it is
 *      tried first when both are configured.
 *        RAPIDAPI_KEY=...
 *
 *   2. Omkar Cloud direct — free tier 100 calls/month.
 *        OMKAR_API_KEY=...
 *
 * NOTE: provider 1 IS Omkar Cloud. Their RapidAPI listing
 * (rapidapi.com/OmkarCloud/api/best-amazon-scraper-free-1000-calls) is the same
 * company's scraper, with a ten times larger free tier. So if RAPIDAPI_KEY is
 * set you are already using Omkar; the direct key is a second, smaller allowance
 * of the same data rather than a different source.
 *
 * Note on "no signup": that applies to their PLAYGROUND, which runs live
 * requests in the browser. The documented API itself is keyed. We call the
 * documented API, not an undocumented internal route, because an undocumented
 * endpoint is not a contract — it can change or be blocked without notice and
 * would fail silently in production.
 *
 * Both free tiers are small (roughly 33/day and 3–7/day), so this is a LAST
 * RESORT: fired only when the page, the metadata service, the reader and the
 * search API have all come back empty.
 *
 * Configuration — environment variables only, never hardcode a key:
 *   RAPIDAPI_KEY           RapidAPI key
 *   AMAZON_API_HOST        default best-amazon-scraper-free-1000-calls.p.rapidapi.com
 *   OMKAR_API_KEY          Omkar Cloud key
 *   OMKAR_API_HOST         default amazon-scraper-api.omkar.cloud
 *   OMKAR_API_PATH         comma-separated paths to try, default both documented ones
 *   AMAZON_API_COUNTRY     default IN   (amazon.in)
 *   AMAZON_API_TIMEOUT_MS  default 12000
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_RAPIDAPI_HOST = 'best-amazon-scraper-free-1000-calls.p.rapidapi.com';
const DEFAULT_OMKAR_HOST = 'amazon-scraper-api.omkar.cloud';
// RapidAPI's first call to an endpoint can be slow while it warms up, and 12s
// was timing out. This runs after the user has been answered, so patience is free.
const TIMEOUT = parseInt(process.env.AMAZON_API_TIMEOUT_MS || '20000', 10);

function amazonApiConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY || process.env.OMKAR_API_KEY);
}

function country() {
  return process.env.AMAZON_API_COUNTRY || 'IN';
}

/** Map either provider's payload onto the shape the bot uses. */
function normalise(d) {
  if (!d || typeof d !== 'object') return null;
  // Omkar's own API returns a single object; RapidAPI's returns an array.
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

/** Omkar Cloud's own API (free tier 100 calls/month). */
async function viaOmkar(asin) {
  const host = process.env.OMKAR_API_HOST || DEFAULT_OMKAR_HOST;
  // Their documentation shows BOTH of these paths — the GitHub README uses
  // /amazon/product-details and the newer site uses /products/details. Which one
  // a given key answers on varies, and a 404 tells us the guess was wrong, so
  // try each rather than assuming.
  const paths = (process.env.OMKAR_API_PATH || '/amazon/product-details,/products/details')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  for (const path of paths) {
    try {
      const res = await axios.get('https://' + host + path, {
        params: { asin: String(asin), country_code: country() },
        headers: { 'API-Key': process.env.OMKAR_API_KEY },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        const out = normalise(res.data);
        if (out) {
          console.log('amazon api (omkar): ok via ' + path + ' for ' + asin);
          return out;
        }
      }
      console.warn(
        'amazon api (omkar): status ' + res.status + ' for ' + asin + ' on ' + path +
          ' body=' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 200)
      );
    } catch (err) {
      console.warn('amazon api (omkar): ' + path + ' threw ' + err.message);
    }
  }
  return null;
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

  if (process.env.OMKAR_API_KEY) {
    try {
      const b = await viaOmkar(asin);
      if (b) return Object.assign({ source: 'omkar' }, b);
    } catch (err) {
      console.warn('amazon api (omkar) failed for ' + asin + ': ' + err.message);
    }
  }

  return null;
}

module.exports = { lookupAsin, amazonApiConfigured };
