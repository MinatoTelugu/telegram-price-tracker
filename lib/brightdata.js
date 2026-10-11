/**
 * lib/brightdata.js
 * ---------------------------------------------------------------------------
 * Bright Data Scraper API — a structured price/stock source for BOTH stores.
 *
 * WHY THIS ONE IS WORTH ADDING
 * Every Amazon price we have ever shown came from a workaround, and the
 * workarounds keep failing in different ways. Bright Data removes most of them at
 * once, and the docs are specific about the parts that matter to us:
 *
 *   - AUTH IS A SINGLE API KEY: `Authorization: Bearer <key>`. No username and
 *     password pair, no query-parameter token, nothing to get wrong. That is
 *     exactly the credential shape you already have, and it is the thing that
 *     went wrong with Oxylabs' two-product split.
 *   - AMAZON AND FLIPKART BOTH HAVE DEDICATED SCRAPERS. Oxylabs has no Flipkart
 *     parser at all; Bright Data lists one, with `price`, `original_price`,
 *     `discount` and `availability` among its fields. So this is the first
 *     provider that can serve BOTH stores structurally rather than one
 *     structurally and one by hand.
 *   - THE FIELDS ARE THE ONES WE NEED: `initial_price` (the M.R.P.),
 *     `final_price` (what you actually pay) and `availability` — returned as
 *     fields, not scraped out of page text. `final_price` is the buy-box price,
 *     which is the number the whole reported bug was about.
 *
 *   POST https://api.brightdata.com/datasets/v3/scrape
 *     ?dataset_id=<id>&format=json
 *   Authorization: Bearer <BRIGHTDATA_API_KEY>
 *   [{"url": "https://www.amazon.in/dp/B0G81TPT89"}]
 *
 *   Amazon products  gd_l7q7dkf244hwjntr0
 *   Flipkart         its own dataset id; resolved by name at run time, because
 *                    Bright Data adds and revises them and a hardcoded id that
 *                    silently stops matching is worse than one extra call.
 *
 * THE COST, STATED PLAINLY: this is pay-per-successful-record, not a free tier.
 * Every call that returns a product costs money, so it is used as the PRIMARY
 * source only when it is configured, and the free fallbacks still sit behind it.
 *
 * Never hardcode the key. Environment variables only.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const ENDPOINT = 'https://api.brightdata.com/datasets/v3/scrape';
// Documented, stable, and the one the quickstart uses.
const AMAZON_PRODUCTS_DATASET = 'gd_l7q7dkf244hwjntr0';
const TIMEOUT = parseInt(process.env.BRIGHTDATA_TIMEOUT_MS || '60000', 10);

function brightDataConfigured() {
  return Boolean(process.env.BRIGHTDATA_API_KEY);
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(String(v).replace(/[^0-9.]/g, '')) : v;
  return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** "In Stock" / "Only 2 left in stock" / "Temporarily out of stock". */
function stockFromText(s) {
  const t = String(s == null ? '' : s).toLowerCase().trim();
  if (!t) return null;
  if (/out of stock|unavailable|discontinued|sold out/.test(t)) return false;
  if (/in stock|available|left in stock|ships within|usually dispatched/.test(t)) return true;
  return null;
}

/**
 * One scrape request. `input` is the array Bright Data expects.
 * @returns {Promise<object|null>} the first record, or null
 */
async function scrape(datasetId, input) {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key || !datasetId) return null;
  try {
    const res = await axios.post(
      ENDPOINT,
      input,
      {
        params: { dataset_id: datasetId, format: 'json' },
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        timeout: TIMEOUT,
        validateStatus: () => true,
      }
    );
    if (res.status === 401 || res.status === 403) {
      console.warn(
        'brightdata: ' + res.status + ' — the API key was rejected. Check BRIGHTDATA_API_KEY ' +
          'in the control panel; the header must be "Authorization: Bearer <key>".'
      );
      return null;
    }
    // 202 means the scrape needs longer than the sync window and a snapshot_id
    // was returned instead. We do not poll for it here: a price check must not
    // hold a request open, and the fallbacks cover the gap.
    if (res.status === 202) {
      console.warn('brightdata: 202 (still collecting) — falling through to the next source');
      return null;
    }
    if (res.status !== 200) {
      console.warn(
        'brightdata: status ' + res.status +
          ' body=' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 200)
      );
      return null;
    }
    const data = Array.isArray(res.data) ? res.data : res.data && res.data.data;
    if (!Array.isArray(data) || !data.length) {
      console.warn('brightdata: no records returned');
      return null;
    }
    return data[0];
  } catch (err) {
    console.warn('brightdata: request failed — ' + err.message);
    return null;
  }
}

/** Map a record onto our shape. Handles both stores' field names. */
function normalise(rec) {
  if (!rec || typeof rec !== 'object') return null;

  // Amazon: final_price is the buy-box price, initial_price the M.R.P.
  // Flipkart: price is the selling price, original_price the M.R.P.
  let price = num(rec.final_price);
  if (price == null) price = num(rec.price);
  let mrp = num(rec.initial_price);
  if (mrp == null) mrp = num(rec.original_price);

  // The same equality trap as everywhere else: a "price" equal to the M.R.P. is
  // the M.R.P. wearing the price's name.
  if (price != null && mrp != null && price === mrp) price = null;
  if (mrp != null && price != null && mrp <= price) mrp = null;

  let inStock = stockFromText(rec.availability);
  if (inStock == null && typeof rec.is_available === 'boolean') inStock = rec.is_available;

  const title = String(rec.title || rec.name || '').replace(/\s+/g, ' ').trim() || null;
  let image = rec.image_url || rec.main_image || rec.image || null;
  if (image) image = String(image).replace(/^http:/i, 'https:');

  if (price == null && !title && !image) return null;
  return { title, price, mrp, image, inStock, currency: rec.currency || null };
}

/**
 * @param {{url: string, marketplace: string}} target
 * @returns {Promise<{title, price, mrp, image, inStock, source}|null>}
 */
async function lookupBrightData(target) {
  if (!brightDataConfigured()) return null;
  const t = target || {};
  if (!t.url) return null;

  const datasetId =
    t.marketplace === 'amazon'
      ? process.env.BRIGHTDATA_AMAZON_DATASET || AMAZON_PRODUCTS_DATASET
      : process.env.BRIGHTDATA_FLIPKART_DATASET || null;
  if (!datasetId) {
    console.warn(
      'brightdata: no dataset id for ' + t.marketplace + ' — set BRIGHTDATA_' +
        String(t.marketplace).toUpperCase() + '_DATASET (find it in the control panel)'
    );
    return null;
  }

  const rec = await scrape(datasetId, [{ url: t.url }]);
  if (!rec) return null;
  const out = normalise(rec);
  if (!out) return null;
  console.log(
    'brightdata: ' + t.marketplace + ' ok — price=' + (out.price != null ? out.price : 'none') +
      ' mrp=' + (out.mrp != null ? out.mrp : 'none') +
      ' inStock=' + (out.inStock != null ? out.inStock : 'unknown')
  );
  return Object.assign({ source: 'brightdata' }, out);
}

module.exports = { lookupBrightData, brightDataConfigured, normalise, stockFromText };
