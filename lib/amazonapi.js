/**
 * lib/amazonapi.js
 * ---------------------------------------------------------------------------
 * Amazon product data from a HOSTED third-party API (Omkar Cloud's Amazon
 * Scraper, published on RapidAPI).
 *
 * Why the hosted one and not the self-hosted repo: the open-source project
 * (omkarcloud/amazon-scraper) is a scraper you run YOURSELF — `python run.py`
 * on your own machine. Running it on our server means the request still leaves
 * from OUR IP, so Amazon refuses it exactly as it refuses our own scraper. The
 * repo's own notes confirm this: it needs a residential proxy, and it gets
 * through by impersonating a browser's TLS fingerprint. That is evasion of
 * Amazon's bot detection, which we do not do.
 *
 * The HOSTED endpoint is a different thing entirely: it is a normal API that
 * fetches from the vendor's servers, so the block does not apply, and it is a
 * licensed service rather than an attempt to look like a browser.
 *
 * Free tier: 1,000 calls/month, no card. That is roughly 33 a day, so this is a
 * LAST RESORT — fired only when the page, the metadata service, the reader and
 * the search API have all come back empty.
 *
 * Configuration — environment variables only, never hardcode the key:
 *   RAPIDAPI_KEY       your RapidAPI key (unset = this route is skipped)
 *   AMAZON_API_HOST    default best-amazon-scraper-free-1000-calls.p.rapidapi.com
 *   AMAZON_API_COUNTRY default IN   (amazon.in)
 *   AMAZON_API_TIMEOUT_MS default 12000
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_HOST = 'best-amazon-scraper-free-1000-calls.p.rapidapi.com';
const TIMEOUT = parseInt(process.env.AMAZON_API_TIMEOUT_MS || '12000', 10);

function amazonApiConfigured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

function apiHost() {
  return process.env.AMAZON_API_HOST || DEFAULT_HOST;
}

function apiCountry() {
  return process.env.AMAZON_API_COUNTRY || 'IN';
}

/**
 * @returns {Promise<{title: string|null, price: number|null, mrp: number|null, image: string|null, inStock: boolean|null}|null>}
 */
async function lookupAsin(asin) {
  if (!amazonApiConfigured() || !asin) return null;

  try {
    const res = await axios.get('https://' + apiHost() + '/products/details', {
      params: { product: String(asin), country: apiCountry() },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': apiHost(),
      },
      timeout: TIMEOUT,
      validateStatus: () => true,
    });

    if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
      console.warn('amazon api: status ' + res.status + ' for ' + asin);
      return null;
    }

    const d = res.data;
    const title = d.title ? String(d.title).replace(/\s+/g, ' ').trim() : null;
    const price =
      d.price && d.price.amount != null ? Math.round(Number(d.price.amount)) : null;
    const mrp =
      d.price && d.price.list_price != null ? Math.round(Number(d.price.list_price)) : null;
    let image = null;
    if (Array.isArray(d.images) && d.images.length) {
      const main = d.images.find((i) => i && /main/i.test(String(i.variant || ''))) || d.images[0];
      if (main && main.link) image = String(main.link).replace(/^http:/i, 'https:');
    }
    const inStock =
      d.availability && typeof d.availability.is_in_stock === 'boolean'
        ? d.availability.is_in_stock
        : null;

    if (!title && price == null && !image) return null;
    return {
      title,
      price: Number.isFinite(price) ? price : null,
      mrp: Number.isFinite(mrp) && price != null && mrp > price ? mrp : null,
      image,
      inStock,
      source: 'amazonapi',
    };
  } catch (err) {
    console.warn('amazon api request failed for ' + asin + ': ' + err.message);
    return null;
  }
}

module.exports = { lookupAsin, amazonApiConfigured };
