/**
 * lib/oxylabs.js
 * ---------------------------------------------------------------------------
 * Oxylabs Web Scraper API — the primary provider for BOTH stores.
 *
 * WHY THIS REPLACES THE OTHERS AS PRIMARY
 * Amazon blocks this host, so every Amazon price we have ever shown came from a
 * workaround: a reader service that returns the page as free text, or a hosted
 * API with a 1,000-calls-a-MONTH free tier. The reader's text is what produced
 * the ₹19,999 for a product listed at ₹21,999, and the quota is what a
 * check-every-30-minutes schedule burns through in days.
 *
 * Oxylabs fetches from its own rotating pool, so the block does not apply, and
 * its Amazon source is a DEDICATED PARSER — not a text scan. That is the part
 * that matters:
 *
 *   price_buybox    the price as visible in the BUY BOX. This is the number we
 *                   want, stated as a field rather than guessed at, so it cannot
 *                   wander onto a recommendation carousel the way a text scan can.
 *   price           the product's price (fallback for price_buybox)
 *   price_initial   the ORIGINAL, non-discounted price — this is the M.R.P.
 *   stock           e.g. "In stock." / "Currently unavailable." — live status
 *   buybox[]        per-offer price and stock, used as a further fallback
 *
 * AUTHENTICATION IS HTTP BASIC, NOT A SINGLE KEY.
 * The dashboard gives you a USERNAME and a PASSWORD for the API, and they go in
 * an Authorization: Basic header. There is no single "API key" string. So:
 *
 *   OXYLABS_USERNAME   API user from the Oxylabs dashboard
 *   OXYLABS_PASSWORD   that user's password
 *   OXYLABS_GEO        geo_location for Amazon, default "India"
 *   OXYLABS_TIMEOUT_MS default 45000 (a rotating proxy fetch is not instant)
 *   OXYLABS_SOURCE_URL endpoint, default https://realtime.oxylabs.io/v1/queries
 *
 * FLIPKART HAS NO DEDICATED PARSER. Oxylabs' Flipkart sources return the page
 * HTML, not structured JSON — their own target table shows "Dedicated parser: –"
 * for flipkart, flipkart_search and flipkart_product. So for Flipkart we ask for
 * the rendered HTML and hand it to our OWN buy-box-scoped parser. That is not a
 * downgrade: the HTML path is the one we already trust, and the point of going
 * through Oxylabs is that the fetch succeeds at all.
 *
 * Never hardcode credentials. Environment variables only.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';
const TIMEOUT = parseInt(process.env.OXYLABS_TIMEOUT_MS || '45000', 10);

function oxylabsConfigured() {
  return Boolean(process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD);
}

function endpoint() {
  return process.env.OXYLABS_SOURCE_URL || DEFAULT_ENDPOINT;
}

function geo() {
  return process.env.OXYLABS_GEO || 'India';
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : v;
  return typeof n === 'number' && isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** "In stock." / "Currently unavailable." -> true / false / null. */
function stockFromText(s) {
  const t = String(s == null ? '' : s).toLowerCase().trim();
  if (!t) return null;
  if (/currently unavailable|out of stock|unavailable|sold out|not available/.test(t)) return false;
  if (/in stock|available|usually ships|ships within/.test(t)) return true;
  return null;
}

/** One POST to the Oxylabs realtime endpoint. Returns the first result's content. */
async function query(payload) {
  const user = process.env.OXYLABS_USERNAME;
  const pass = process.env.OXYLABS_PASSWORD;
  const auth = Buffer.from(user + ':' + pass).toString('base64');

  const res = await axios.post(endpoint(), payload, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });

  if (res.status !== 200) {
    console.warn(
      'oxylabs: status ' + res.status + ' for ' + JSON.stringify(payload.source) +
        ' body=' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 200)
    );
    return null;
  }
  const results = res.data && res.data.results;
  if (!Array.isArray(results) || !results.length) {
    console.warn('oxylabs: no results in the response for ' + payload.source);
    return null;
  }
  return results[0];
}

/** Map the amazon_product parser's structured content onto our shape. */
function fromAmazonContent(c) {
  if (!c || typeof c !== 'object') return null;

  // price_buybox is the buy box. Prefer it; fall back to the general price, then
  // to the buybox[] array. All three are structured fields, none is a text scan.
  let price = num(c.price_buybox);
  if (price == null) price = num(c.price);
  if (price == null && Array.isArray(c.buybox) && c.buybox.length) {
    price = num(c.buybox[0] && c.buybox[0].price);
  }
  if (price != null && price < 0) price = null; // the parser uses -1 for "none"

  // price_initial is the non-discounted price — the M.R.P.
  let mrp = num(c.price_initial);
  if (mrp != null && price != null && mrp <= price) mrp = null;

  // Stock: the product-level field first, then the buybox entry's.
  let inStock = stockFromText(c.stock);
  if (inStock == null && Array.isArray(c.buybox) && c.buybox.length) {
    inStock = stockFromText(c.buybox[0] && c.buybox[0].stock);
  }

  const title = (c.title || c.product_name || '').toString().replace(/\s+/g, ' ').trim() || null;
  const images = Array.isArray(c.images) ? c.images : [];
  let image = images.length ? String(images[0]) : null;
  if (image) image = image.replace(/^http:/i, 'https:');

  if (price == null && !title && !image) return null;
  return { title, price, mrp, image, inStock, currency: c.currency || null };
}

/**
 * Look a product up through Oxylabs.
 *
 * @param {{url: string, marketplace: string, productId?: string}} target
 * @returns {Promise<{title, price, mrp, image, inStock, source, html?}|null>}
 */
async function lookupOxylabs(target) {
  if (!oxylabsConfigured()) return null;
  const t = target || {};
  const marketplace = t.marketplace;

  try {
    if (marketplace === 'amazon') {
      // The ASIN is what the parser wants. Take it from the URL, else the id.
      const asin =
        (/\/dp\/([A-Z0-9]{10})/i.exec(t.url || '') || /([A-Z0-9]{10})/.exec(t.productId || '') || [])[1] ||
        null;
      if (!asin) return null;

      const result = await query({
        source: 'amazon_product',
        query: asin,
        parse: true,
        geo_location: geo(),
      });
      if (!result) return null;
      // status_code 200 with parse_status_code 12000 means the parser succeeded.
      const content = result.content;
      const out = fromAmazonContent(content);
      if (!out) return null;
      console.log(
        'oxylabs: amazon ok for ' + asin + ' — price=' + (out.price != null ? out.price : 'none') +
          ' mrp=' + (out.mrp != null ? out.mrp : 'none') +
          ' inStock=' + (out.inStock != null ? out.inStock : 'unknown')
      );
      return Object.assign({ source: 'oxylabs' }, out);
    }

    if (marketplace === 'flipkart') {
      // No dedicated parser — ask for the rendered HTML and parse it ourselves
      // with the same buy-box-scoped selectors used for a direct fetch.
      const result = await query({
        source: 'flipkart',
        url: t.url,
        render: 'html',
        geo_location: geo(),
      });
      if (!result) return null;
      const html = typeof result.content === 'string' ? result.content : null;
      if (!html || html.length < 500) return null;
      console.log('oxylabs: flipkart html ok (' + html.length + ' bytes)');
      return { source: 'oxylabs', html };
    }
  } catch (err) {
    console.warn('oxylabs: ' + marketplace + ' lookup failed — ' + err.message);
  }
  return null;
}

module.exports = { lookupOxylabs, oxylabsConfigured, fromAmazonContent, stockFromText };
