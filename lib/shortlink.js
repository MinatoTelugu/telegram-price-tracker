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
  /(^|\.)fkrt\.clnk\.in$/i,
];

/** Is this a store short link that must be expanded before use? */
/**
 * Is this a URL of a store we can actually track?
 *
 * Every expansion route must return one of these. Without this check the search
 * route happily returned whatever it found first — in the reported logs,
 * "https://andro.io/app/hbs-travkart" for a Flipkart product — and the scraper
 * then read that page, so the title, price and image came from an unrelated
 * site. A wrong URL is far worse than no URL: no URL falls through to the other
 * routes and finally reports failure, while a wrong URL is scraped as if real.
 */
function isStoreUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return /(^|\.)amazon\.[a-z.]{2,6}$/.test(host) || /(^|\.)flipkart\.com$/.test(host);
  } catch (err) {
    return false;
  }
}

/**
 * Accept a candidate expansion only if it is a store URL. A redirector such as
 * linksredirect.com carries the real destination in a ?url= parameter, so that
 * is unwrapped first.
 */
function isShortHost(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    return SHORT_HOSTS.some((re) => re.test(host));
  } catch (err) {
    return false;
  }
}

function acceptExpansion(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let url = candidate;
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('url') || u.searchParams.get('u') || u.searchParams.get('target');
    if (inner && isStoreUrl(inner)) url = inner;
  } catch (err) {
    return null;
  }
  // A short HOST means nothing was actually resolved.
  if (isShortHost(url)) return null;
  // But the store's own app-share path — flipkart.com/product/p/itme?pid=… — is
  // the REAL product url, carrying the pid. Rejecting it (as an earlier version
  // did, by reusing isShortLink) broke every dl.flipkart.com link with
  // "I could not open that short link". It must be accepted.
  return isStoreUrl(url) ? url : null;
}

function isShortLink(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (SHORT_HOSTS.some((re) => re.test(host))) return true;
    // App-share paths on the main host. `/product/p/itme?pid=…` is the form the
    // Flipkart app hands out — it is NOT a product page, and fetching it returns
    // HTTP 500. It must be expanded like any other share link.
    if (host.endsWith('flipkart.com') && /^\/(s|dl)\//i.test(u.pathname)) return true;
    if (host.endsWith('flipkart.com') && /^\/product\/p\/itm/i.test(u.pathname)) return true;
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
      const ok = acceptExpansion(direct);
      if (ok) {
        console.log('shortlink: expanded directly -> ' + String(ok).slice(0, 90));
        return ok;
      }
    }
  } catch (err) {
    /* try the next route */
  }

  // 2) via the converter's redirector
  try {
    const { convertAffiliateLink, resolveShortUrl } = require('./affiliate');
    const conv = await convertAffiliateLink(raw);
    if (conv && conv.ok && conv.affiliateUrl && conv.affiliateUrl !== raw) {
      const via = acceptExpansion(await resolveShortUrl(conv.affiliateUrl)) || acceptExpansion(conv.affiliateUrl);
      if (via) {
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
    const ok = meta && acceptExpansion(meta.url);
    if (ok) {
      console.log('shortlink: expanded via metadata -> ' + String(ok).slice(0, 90));
      return ok;
    }
  } catch (err) {
    /* give up */
  }

  // 4) via the search API. Search engines index the RESOLVED url, so a result
  //    for the short link frequently hands us the canonical page directly. This
  //    is a second independent route, so the expansion does not hinge on one
  //    external service being available.
  try {
    const { webSearch, searchConfigured } = require('./search');
    if (searchConfigured()) {
      const results = await webSearch(raw, { count: 5 });
      for (const r of results) {
        // Only a STORE url counts. A search result for a short link is very
        // often some unrelated page that merely mentions it.
        const ok = acceptExpansion(r.url);
        if (ok) {
          console.log('shortlink: expanded via search -> ' + String(ok).slice(0, 90));
          return ok;
        }
      }
      console.log('shortlink: the search results held no store url — ignoring them');
    }
  } catch (err) {
    /* give up */
  }

  console.warn(
    'shortlink: could not expand ' + raw +
      ' (tried our hops, the converter, the metadata service and search)'
  );
  return null;
}

module.exports = { expandShortLink, isShortLink, isStoreUrl, isShortHost, acceptExpansion };
