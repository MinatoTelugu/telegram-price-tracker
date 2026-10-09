/**
 * lib/shortlink.js
 * ---------------------------------------------------------------------------
 * ONE place that expands any store short link, before anything else runs.
 *
 * Why this exists: a short link carries no product identity at all. For
 * amzn.in/d/… there is no ASIN; for dl.flipkart.com/s/… there is no pid and no
 * slug. Everything downstream — the product id, the name, the price, the search
 * fallback — depends on the CANONICAL url, so the expansion has to happen first,
 * not as a side effect of whichever code path runs later.
 *
 * Three routes, tried in order:
 *   1. our own redirect hops (cheap: reads Location headers)
 *   2. the affiliate converter's redirector, then its hops
 *   3. the metadata service — which fetches from ITS OWN servers, so it can
 *      reach a host that refuses ours (dl.flipkart.com drops datacenter IPs,
 *      but an external service expands it fine)
 * ---------------------------------------------------------------------------
 */

const SHORT_HOSTS = [
  /(^|\.)amzn\.to$/i,
  /(^|\.)amzn\.in$/i,
  /(^|\.)a\.co$/i,
  /(^|\.)dl\.flipkart\.com$/i,
  /(^|\.)fkrt\.cc$/i,
  /(^|\.)fkrt\.it$/i,
];

/** Is this a store short link that must be expanded before use? */
function isShortLink(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (SHORT_HOSTS.some((re) => re.test(host))) return true;
    // flipkart.com/s/… and flipkart.com/dl/… are app-share paths on the main host
    if (host.endsWith('flipkart.com') && /^\/(s|dl)\//i.test(u.pathname)) return true;
    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Expand a short link to its canonical destination.
 * @returns {Promise<string|null>} the canonical url, or null if it cannot be expanded
 */
async function expandShortLink(raw) {
  if (!raw) return null;
  if (!isShortLink(raw)) return raw;

  // 1) our own hops
  try {
    const { resolveShortUrl } = require('./affiliate');
    const direct = await resolveShortUrl(raw);
    if (direct && direct !== raw && !isShortLink(direct)) {
      console.log('shortlink: expanded directly -> ' + String(direct).slice(0, 90));
      return direct;
    }
  } catch (err) {
    /* try the next route */
  }

  // 2) via the converter's redirector
  try {
    const { convertAffiliateLink, resolveShortUrl } = require('./affiliate');
    const conv = await convertAffiliateLink(raw);
    if (conv && conv.ok && conv.affiliateUrl && conv.affiliateUrl !== raw) {
      const via = await resolveShortUrl(conv.affiliateUrl);
      if (via && !isShortLink(via)) {
        console.log('shortlink: expanded via the converter -> ' + String(via).slice(0, 90));
        return via;
      }
    }
  } catch (err) {
    /* try the next route */
  }

  // 3) via the metadata service, which is not refused by the store
  try {
    const { fetchMetadata } = require('./metadata');
    const meta = await fetchMetadata(raw);
    if (meta && meta.url && !isShortLink(meta.url)) {
      console.log('shortlink: expanded via metadata -> ' + String(meta.url).slice(0, 90));
      return meta.url;
    }
  } catch (err) {
    /* give up */
  }

  console.warn('shortlink: could not expand ' + raw);
  return null;
}

module.exports = { expandShortLink, isShortLink };
