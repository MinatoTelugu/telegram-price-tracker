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
  // The metadata service sometimes reports http:// for a store that only serves
  // https. Upgrade it rather than storing and displaying an insecure link.
  let url = candidate.replace(/^http:\/\//i, 'https://');
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
/**
 * The hard ceiling on a whole expansion, in ms.
 *
 * Reported: a Flipkart short link froze the bot for close to two minutes. The
 * routes below were each individually bounded — 12s for the redirect follow,
 * 2.5s x 8 for the hops, then the converter, the metadata service and search —
 * but they run IN SEQUENCE and nothing bounded their SUM. Four bounded waits add
 * up to an unbounded one.
 *
 * So there is now a deadline on the whole thing. Past it, the expansion gives up
 * and the caller reports the link could not be opened, in seconds rather than
 * minutes. A fast, honest failure beats a slow one: the user can retry, and the
 * bot stays responsive for everyone else in the meantime.
 */
const EXPAND_DEADLINE_MS = Math.max(1000, parseInt(process.env.SHORTLINK_DEADLINE_MS || '8000', 10));

/** The real work, unbounded. Only ever called under the deadline below. */
async function expandShortLinkInner(raw) {
  if (!raw) return null;
  if (!isShortLink(raw)) return raw;

  // 0) THE ROUTES THAT WORK, IN PARALLEL.
  //
  //    The metadata service and the reader both fetch from their own servers, so
  //    neither is affected by a store refusing our IP — which is the whole
  //    problem being solved here. Run together, the first success wins, and the
  //    caller waits for the fastest rather than for the sum.
  //
  //    Sequential order was the bug: metadata answered at 6001ms because it was
  //    reached AFTER a 5s redirect-follow and a 3s converter, and the deadline
  //    cut it off at 6000ms. The route was never too slow; it was too late.
  try {
    const attempts = [];

    // the metadata service (microlink)
    attempts.push(
      (async () => {
        try {
          const { fetchMetadata } = require('./metadata');
          const meta = await fetchMetadata(raw);
          return acceptExpansion(meta && meta.url);
        } catch (err) {
          return null;
        }
      })()
    );

    // the reader (Jina), which reports the URL it landed on
    attempts.push(
      (async () => {
        try {
          const { fetchReadablePage, readerConfigured } = require('./reader');
          if (!readerConfigured()) return null;
          const page = await fetchReadablePage(raw, { timeoutMs: 4500 });
          return acceptExpansion(page && page.resolvedUrl);
        } catch (err) {
          return null;
        }
      })()
    );

    const settled = await Promise.all(attempts);
    const winner = settled.find(Boolean);
    if (winner) {
      console.log('shortlink: expanded in parallel -> ' + String(winner).slice(0, 90));
      return winner;
    }
  } catch (err) {
    /* fall through to the sequential routes */
  }

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

  // 2b) The same share code on the MAIN host.
  //
  //    dl.flipkart.com is the app-share host and refuses datacenter IPs. The
  //    share path also answers on www.flipkart.com/s/<code>, which does not.
  //    Same redirect, different front door — and the cheap thing to try before
  //    handing the job to an external service.
  try {
    const u = new URL(raw);
    if (/(^|\.)dl\.flipkart\.com$/i.test(u.hostname) && /^\/s\//i.test(u.pathname)) {
      const alt = 'https://www.flipkart.com' + u.pathname + u.search;
      const { resolveShortUrl } = require('./affiliate');
      const viaAlt = await resolveShortUrl(alt).catch(() => null);
      // ONLY a resolved destination counts. `www.flipkart.com/s/<code>` is still
      // a share link — isShortHost() does not know the main host, so accepting it
      // directly would hand back an UNRESOLVED url, which is the one outcome this
      // function must never produce: a wrong url is scraped as if it were real,
      // while no url simply falls through to the next route.
      const ok = acceptExpansion(viaAlt);
      if (ok && ok !== alt && !isShortLink(ok)) {
        console.log('shortlink: expanded via the main host -> ' + String(ok).slice(0, 90));
        return ok;
      }
    }
  } catch (err) {
    /* try the next route */
  }

  // 3b) via the READER — the one route that fetches from somebody else's servers.
  //
  // This is the route that should have been here from the start. dl.flipkart.com
  // refuses datacenter IPs, so every route that goes out from this host fails,
  // and the reader is precisely the service built to get around that. It was
  // already a dependency (used for prices) but was never wired into expansion.
  try {
    const { fetchReadablePage, readerConfigured } = require('./reader');
    if (readerConfigured()) {
      const page = await fetchReadablePage(raw, { timeoutMs: 3000 });
      const ok = page && acceptExpansion(page.resolvedUrl);
      if (ok) {
        console.log('shortlink: expanded via the reader -> ' + String(ok).slice(0, 90));
        return ok;
      }
    }
  } catch (err) {
    /* try the next route */
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

/**
 * Expand a short link, under a hard deadline.
 *
 * Promise.race does not cancel the loser — the abandoned route keeps running to
 * its own timeout in the background — but it does release the CALLER, which is
 * the thing that was hanging. The abandoned work is bounded by the per-route
 * budgets above, so it cannot accumulate.
 */
async function expandShortLink(raw) {
  if (!raw || !isShortLink(raw)) return expandShortLinkInner(raw);

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        'shortlink: giving up after ' + EXPAND_DEADLINE_MS + 'ms on ' + String(raw).slice(0, 90) +
          ' — failing fast rather than holding the request open'
      );
      resolve(null);
    }, EXPAND_DEADLINE_MS);
  });

  try {
    return await Promise.race([expandShortLinkInner(raw), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  expandShortLink,
  expandShortLinkInner,
  EXPAND_DEADLINE_MS,
  isShortLink,
  isStoreUrl,
  isShortHost,
  acceptExpansion,
};
