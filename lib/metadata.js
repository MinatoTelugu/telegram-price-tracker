/**
 * lib/metadata.js
 * ---------------------------------------------------------------------------
 * LAST-RESORT product metadata.
 *
 * Amazon refuses requests from this host (datacenter IP), so for a bare
 * /dp/ASIN link — which carries no name in the URL — we end up with nothing and
 * the card falls back to the ASIN. Telegram's own link preview proves the page
 * is fine; it is only OUR IP that is refused.
 *
 * So as a last resort we ask a public link-preview service, which fetches the
 * page from ITS servers and hands back the Open Graph title/description/image.
 *
 * Configuration (environment variables only):
 *   METADATA_API_URL   endpoint that accepts ?url=<encoded> (default: microlink)
 *   METADATA_TIMEOUT_MS  default 4000
 *
 * This is used ONLY when our own scrape produced no usable title. It never runs
 * on the fast path, so it cannot slow a normal reply, and every failure is
 * swallowed — the caller simply keeps whatever it already had.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_ENDPOINT = 'https://api.microlink.io/';
const TIMEOUT = parseInt(process.env.METADATA_TIMEOUT_MS || '4000', 10);

function endpoint() {
  return process.env.METADATA_API_URL || DEFAULT_ENDPOINT;
}

/** @returns {Promise<{title: string|null, description: string|null, image: string|null}|null>} */
async function fetchMetadata(url) {
  if (!url) return null;
  try {
    const res = await axios.get(endpoint(), {
      params: { url },
      timeout: TIMEOUT,
      validateStatus: () => true,
    });
    const data = (res.data && res.data.data) || res.data || null;
    if (!data || typeof data !== 'object') return null;

    // The FINAL url, after redirects. This is what makes the service useful as a
    // short-link EXPANDER: it fetches from its own servers, so it can reach
    // hosts (dl.flipkart.com) that refuse this one.
    let finalUrl = null;
    for (const key of ['url', 'finalUrl', 'redirectUrl']) {
      const v = data[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
        finalUrl = v;
        break;
      }
    }

    const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : null;

    // A price, when the service happens to publish one. Shapes vary (a bare
    // number, or an object like { amount, currency }), so read defensively and
    // simply ignore anything unusable — this is a bonus, never a requirement.
    let price = null;
    let currency = null;
    const rawPrice = data.price;
    if (typeof rawPrice === 'number' && isFinite(rawPrice) && rawPrice > 0) {
      price = Math.round(rawPrice);
    } else if (rawPrice && typeof rawPrice === 'object') {
      const amount = rawPrice.amount != null ? rawPrice.amount : rawPrice.value;
      const n = typeof amount === 'string' ? parseFloat(amount.replace(/[^\d.]/g, '')) : amount;
      if (typeof n === 'number' && isFinite(n) && n > 0) price = Math.round(n);
      if (typeof rawPrice.currency === 'string') currency = rawPrice.currency.toUpperCase();
    }
    const description =
      typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : null;
    let image = null;
    if (typeof data.image === 'string') image = data.image;
    else if (data.image && typeof data.image.url === 'string') image = data.image.url;
    if (image && !/^https?:\/\//i.test(image)) image = null;

    if (!title && !image && !finalUrl && price == null) return null;
    return {
      url: finalUrl || null,
      title: title || null,
      description: description || null,
      image: image ? image.replace(/^http:/i, 'https:') : null,
      price,
      currency,
    };
  } catch (err) {
    console.warn('metadata fallback failed:', err.message);
    return null;
  }
}

module.exports = { fetchMetadata };
