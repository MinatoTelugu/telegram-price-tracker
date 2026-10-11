/**
 * lib/oxylabs.js
 * ---------------------------------------------------------------------------
 * Oxylabs — the primary provider for BOTH stores.
 *
 * WHY THIS IS PRIMARY
 * Amazon blocks this host, so every Amazon price we have ever shown came from a
 * workaround: a reader service returning the page as free text, or a hosted API
 * with a 1,000-calls-a-MONTH free tier. The reader's text is what produced the
 * ₹19,999 for a product listed at ₹21,999, and the quota is what a
 * check-every-30-minutes schedule burns through in days.
 *
 * Oxylabs fetches from its own rotating pool, so the block does not apply, and
 * its Amazon target is a DEDICATED PARSER — not a text scan:
 *
 *   price_buybox    the price as visible in the BUY BOX, as a field
 *   price_initial   the original, non-discounted price — the M.R.P.
 *   stock           "In stock." / "Currently unavailable." — live status
 *   buybox[]        per-offer price and stock
 *
 * OXYLABS HAS TWO PRODUCTS, AND THEY AUTHENTICATE DIFFERENTLY.
 * ---------------------------------------------------------------------------
 * This is the part that catches people out, so it is spelled out here.
 *
 *  1. Web Scraper API   POST https://realtime.oxylabs.io/v1/queries
 *       HTTP BASIC — a username and a password from the dashboard.
 *       OXYLABS_USERNAME / OXYLABS_PASSWORD
 *
 *  2. Web API           POST https://webapi.oxylabs.io/v1/scrape
 *       BEARER — a single API key from the Web API product instance.
 *       OXYLABS_API_KEY
 *       Their authentication page is explicit: "Standard HTTP Basic
 *       Authentication is not accepted on any /v1/scrape or /v1/search requests
 *       and will return a 401 Unauthorized status code."
 *
 * A single API key is a Web API key, so it MUST go to webapi.oxylabs.io with a
 * Bearer header. Sending it as a Bearer token to realtime.oxylabs.io would 401:
 * the header is not the only thing that differs between the two products, the
 * ENDPOINT does as well. Both are supported below; whichever credential is set
 * selects the right one, and if both are set the Web API is preferred.
 *
 * FLIPKART
 * ---------------------------------------------------------------------------
 * Oxylabs has no dedicated Flipkart parser — their target table shows
 * "Dedicated parser: –" for flipkart, flipkart_search and flipkart_product. So
 * Flipkart is fetched as rendered HTML and handed to our own buy-box-scoped
 * parser. Not a downgrade: the HTML path is the one we already trust, and the
 * point of going through Oxylabs is that the fetch succeeds at all.
 *
 * Never hardcode credentials. Environment variables only.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

// Web API — Bearer, single key.
const WEB_API = 'https://webapi.oxylabs.io';
// Web Scraper API — Basic, username + password.
const SCRAPER_API = 'https://realtime.oxylabs.io/v1/queries';

const TIMEOUT = parseInt(process.env.OXYLABS_TIMEOUT_MS || '60000', 10);

/** Bearer (Web API) takes precedence when both are configured. */
function oxylabsConfigured() {
  return Boolean(
    process.env.OXYLABS_API_KEY ||
      (process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD)
  );
}

function usingWebApi() {
  return Boolean(process.env.OXYLABS_API_KEY);
}

/** Amazon India is domain "in"; the Web API wants the bare TLD. */
function amazonDomain() {
  return process.env.OXYLABS_AMAZON_DOMAIN || 'in';
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

/**
 * One POST.
 *
 * The Web API takes a Bearer header and answers with the requested output under
 * results[].json / results[].html. The Web Scraper API takes HTTP Basic and
 * answers with results[].content. Both are unwrapped to the first result here.
 */
async function post(path, payload, opts) {
  const o = opts || {};
  const useWebApi = o.webApi === true;
  const url = useWebApi ? WEB_API + path : SCRAPER_API;

  const headers = { 'Content-Type': 'application/json' };
  if (useWebApi) {
    headers.Authorization = 'Bearer ' + process.env.OXYLABS_API_KEY;
  } else if (o.accessToken) {
    // A SINGLE KEY can also belong to the Web Scraper API, which takes it as an
    // `access_token` query parameter rather than a Bearer header. Their docs show
    // exactly that form: ?source=...&query=...&access_token=12345abcde
    //
    // We try this only AFTER the Web API has rejected the key, because the Web
    // API is the newer product and the more likely owner of a fresh trial key.
    headers['X-Oxylabs-Access-Token'] = process.env.OXYLABS_API_KEY;
  } else {
    const auth = Buffer.from(
      process.env.OXYLABS_USERNAME + ':' + process.env.OXYLABS_PASSWORD
    ).toString('base64');
    headers.Authorization = 'Basic ' + auth;
  }

  const config = { headers, timeout: TIMEOUT, validateStatus: () => true };
  if (!useWebApi && o.accessToken) {
    config.params = { access_token: process.env.OXYLABS_API_KEY };
  }
  const res = await axios.post(url, payload, config);

  if (res.status === 401) {
    console.warn(
      'oxylabs: 401 from ' + url + ' — the credential was rejected. ' +
        (useWebApi
          ? 'A Web API key must be sent to webapi.oxylabs.io with a Bearer header.'
          : 'The Web Scraper API needs a username and password, not an API key.')
    );
    return null;
  }
  if (res.status !== 200) {
    console.warn(
      'oxylabs: status ' + res.status + ' from ' + url +
        ' body=' + String(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 200)
    );
    return null;
  }

  const results = res.data && res.data.results;
  if (!Array.isArray(results) || !results.length) {
    console.warn('oxylabs: no results in the response from ' + url);
    return null;
  }
  return results[0];
}

/**
 * Map the Amazon parser's content onto our shape.
 *
 * Handles both envelopes: the Web API nests the parsed object under `json`,
 * the Web Scraper API puts it directly in `content`.
 */
function fromAmazonContent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Three envelopes in the wild:
  //   Web API           results[0].json     — the parsed object
  //   Web Scraper API   results[0].content  — the parsed object
  //   already unwrapped the object itself
  let c = raw;
  if (raw.json && typeof raw.json === 'object') c = raw.json;
  else if (raw.content && typeof raw.content === 'object') c = raw.content;
  if (!c || typeof c !== 'object') return null;

  // price_buybox is the buy box. Prefer it; fall back to the general price, then
  // to the buybox[] array. All three are structured fields, none is a text scan.
  let price = num(c.price_buybox);
  if (price == null) price = num(c.price);
  if (price == null && Array.isArray(c.buybox) && c.buybox.length) {
    price = num(c.buybox[0] && c.buybox[0].price);
  }
  if (price != null && price < 0) price = null; // the parser uses -1 for "none"

  // The M.R.P. can arrive under either name — price_initial is the documented
  // one, price_upper is the upper limit of the price.
  let mrp = num(c.price_initial);
  if (mrp == null) mrp = num(c.price_upper);

  // ── THE M.R.P. WEARING THE PRICE'S NAME ───────────────────────────────────
  // The reported product: Amazon showed ₹28,998 with an M.R.P. of ₹40,999. The
  // card showed ₹40,999 and called it a +41% price INCREASE. The parser had
  // handed back the M.R.P. as `price` while `price_initial` was absent or equal,
  // and nothing objected — because a number equal to the M.R.P. is not "above
  // the M.R.P.", which is the only thing we were checking for.
  //
  // A selling price that EQUALS the M.R.P. is not a selling price. On a store
  // page the M.R.P. is struck through precisely because it is not what you pay.
  // So when the two agree, the value is the M.R.P. and there is no price here.
  // Better to report no price and fall through to another source than to publish
  // the list price as if it were the deal.
  if (price != null && mrp != null && price === mrp) {
    price = null;
  }

  // An MRP at or below the price tells us nothing, so drop it.
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

/** The ASIN the Amazon parser wants. */
function asinOf(url) {
  const m = /\/dp\/([A-Z0-9]{10})/i.exec(url || '') || /\/gp\/product\/([A-Z0-9]{10})/i.exec(url || '');
  if (m) return m[1];
  const bare = /(?:^|[/=])([A-Z0-9]{10})(?:[/?]|$)/i.exec(url || '');
  return bare ? bare[1] : null;
}

/**
 * Look a product up through Oxylabs.
 *
 * @param {{url: string, marketplace: string}} target
 * @returns {Promise<{title, price, mrp, image, inStock, source, html?}|null>}
 */
async function lookupOxylabs(target) {
  if (!oxylabsConfigured()) return null;
  const t = target || {};
  const marketplace = t.marketplace;
  const webApi = usingWebApi();

  try {
    if (marketplace === 'amazon') {
      const asin = asinOf(t.url);
      if (!asin) return null;

      let result = null;
      if (webApi) {
        // Web API: a dedicated Amazon product target, Bearer auth.
        result = await post('/v1/scrape/amazon/product', {
          query: asin,
          domain: amazonDomain(),
          output: ['json'],
          location: geo(),
        }, { webApi: true });
        if (!result) {
          // The key was not accepted by the Web API. Before giving up, try it as
          // a Web Scraper API access token — a single key can belong to either
          // product, and the two do not share a credential.
          console.warn('oxylabs: the Web API rejected the key; retrying it as a Web Scraper API access_token');
          result = await post('', {
            source: 'amazon_product',
            query: asin,
            parse: true,
            geo_location: geo(),
          }, { webApi: false, accessToken: true });
        }
      } else {
        // Web Scraper API: the amazon_product source, Basic auth.
        result = await post('', {
          source: 'amazon_product',
          query: asin,
          parse: true,
          geo_location: geo(),
        }, { webApi: false });
      }
      if (!result) return null;

      const out = fromAmazonContent(result);
      if (!out) return null;
      console.log(
        'oxylabs (' + (webApi ? 'web-api' : 'scraper-api') + '): amazon ok for ' + asin +
          ' — price=' + (out.price != null ? out.price : 'none') +
          ' mrp=' + (out.mrp != null ? out.mrp : 'none') +
          ' inStock=' + (out.inStock != null ? out.inStock : 'unknown')
      );
      return Object.assign({ source: 'oxylabs' }, out);
    }

    if (marketplace === 'flipkart') {
      // No dedicated parser either way — ask for rendered HTML and parse it
      // ourselves with the same buy-box-scoped selectors used for a direct fetch.
      let result = null;
      if (webApi) {
        result = await post('/v1/scrape', {
          url: t.url,
          output: ['html'],
          location: geo(),
        }, { webApi: true });
      } else {
        result = await post('', {
          source: 'flipkart',
          url: t.url,
          render: 'html',
          geo_location: geo(),
        }, { webApi: false });
      }
      if (!result) return null;

      const html =
        typeof result.html === 'string'
          ? result.html
          : typeof result.content === 'string'
          ? result.content
          : null;
      if (!html || html.length < 500) return null;
      console.log('oxylabs: flipkart html ok (' + html.length + ' bytes)');
      return { source: 'oxylabs', html };
    }
  } catch (err) {
    console.warn('oxylabs: ' + marketplace + ' lookup failed — ' + err.message);
  }
  return null;
}

module.exports = {
  lookupOxylabs,
  oxylabsConfigured,
  usingWebApi,
  fromAmazonContent,
  stockFromText,
  asinOf,
};
