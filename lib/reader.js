/**
 * lib/reader.js
 * ---------------------------------------------------------------------------
 * Read a page THROUGH a reader service.
 *
 * Why: Amazon refuses requests from this host, so for a bare /dp/ASIN link we
 * sometimes end up with nothing and the card falls back to the ASIN — the worst
 * possible outcome for the user. A reader service fetches the page from ITS OWN
 * servers and returns the text, so the block does not apply.
 *
 * The default service is Jina Reader (https://r.jina.ai), which is built exactly
 * for this and needs no key for ordinary use. It returns the page as markdown,
 * beginning with a "Title:" line — which is the product name we are after.
 *
 * TIMEOUTS MATTER HERE. The reader renders the page on its own servers, so it is
 * slow — Amazon especially. At 8 seconds the log filled up with
 * "reader fallback failed: timeout of 8000ms exceeded", which is a TIMEOUT and
 * not a block: the route works, it simply needs longer. So the default is 12s,
 * and callers that run AFTER the user has already been answered — the background
 * enrichment — pass their own, much longer one. Latency there costs nothing.
 *
 * Configuration — environment variables only:
 *   READER_API_URL     prefix, default https://r.jina.ai/
 *   READER_TIMEOUT_MS  default 12000 (synchronous paths)
 *
 * Like every other fallback here it is best-effort: any failure returns null and
 * the caller keeps whatever it already had.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_PREFIX = 'https://r.jina.ai/';
const TIMEOUT = parseInt(process.env.READER_TIMEOUT_MS || '12000', 10);

/**
 * The reader services, in order.
 *
 * Each one fetches the page from its own servers, so a store refusing OUR ip is
 * irrelevant to all of them. They differ in what they return and how fast they
 * are, and any one of them has bad days — which is the point of having more than
 * one. Jina is first because its output is the cleanest (markdown with a "Title:"
 * line and a "URL Source:" line); the two generic proxies follow and return the
 * raw HTML, which the parser handles as a fallback.
 *
 * All are free and keyless. Set READER_API_URL to pin a single custom one.
 */
function readerServices() {
  const custom = String(process.env.READER_API_URL || '').trim();
  if (custom) return [{ name: 'custom', url: (t) => custom.replace(/\/?$/, '/') + t, kind: 'reader' }];
  return [
    { name: 'jina', url: (t) => DEFAULT_PREFIX + t, kind: 'reader' },
    { name: 'allorigins', url: (t) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(t), kind: 'html' },
    { name: 'codetabs', url: (t) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(t), kind: 'html' },
  ];
}

function readerConfigured() {
  return readerServices().length > 0;
}

function readerUrl(target) {
  const svc = readerServices()[0];
  return svc ? svc.url(target) : target;
}

/**
 * Reduce raw HTML to readable text.
 *
 * The generic proxies return the page as HTML rather than markdown, and the price
 * parser looks for "Rs 18,799" in text. Without this the whole document — tags,
 * scripts, styles — reaches the parser and the numbers are buried in noise.
 * Script and style blocks go first, because they are full of numbers that are not
 * prices.
 */
function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  // A newline per block element, so the price parser's clause splitting works.
  t = t.replace(/<\/(?:div|p|li|tr|h[1-6]|section|article|br)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8377;/g, '₹');
  t = t.replace(/&quot;/gi, '"').replace(/&#x27;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n\s*\n+/g, '\n');
  return t.trim();
}

/** Pull the name out of the reader's markdown. */
function parseReaderBody(body) {
  // Jina Reader starts with "Title: <the page title>".
  const m = body.match(/^Title:\s*(.+)$/m);
  let title = m ? m[1].replace(/\s+/g, ' ').trim() : null;

  // A reader can echo the URL as the title — that is not a name. Reject it
  // FIRST, so the markdown heading still gets a chance.
  if (title && /^https?:\/\//i.test(title)) title = null;

  // Fall back to the first markdown heading.
  if (!title) {
    const h = body.match(/^#\s+(.+)$/m);
    if (h) title = h[1].replace(/\s+/g, ' ').trim();
  }

  // The reader followed the redirects on ITS servers, so "URL Source" is the
  // canonical destination — the thing a short-link expansion is looking for.
  let resolvedUrl = null;
  const u = body.match(/^URL Source:\s*(\S+)\s*$/m);
  if (u && /^https?:\/\//i.test(u[1])) resolvedUrl = u[1].replace(/[),.]+$/, '');

  return { title: title || null, resolvedUrl, text: body.slice(0, 60000) };
}

/**
 * @param {string} url
 * @param {{timeoutMs?: number, attempts?: number}} [opts]
 * @returns {Promise<{title: string|null, resolvedUrl: string|null, text: string|null}|null>}
 */
async function fetchReadablePage(url, opts) {
  if (!url) return null;
  const options = opts || {};
  const timeoutMs = options.timeoutMs || TIMEOUT;
  const attempts = Math.max(1, options.attempts || 1);

  let lastError = null;
  const services = readerServices();
  // Every service, every attempt. A service that answers "empty body" is the
  // exact failure that left a Flipkart price blank, so the loop must move on to
  // the next one rather than retrying the same one and giving up.
  for (const svc of services) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await axios.get(svc.url(url), {
          timeout: timeoutMs,
          headers: { Accept: 'text/plain, text/html, */*' },
          validateStatus: () => true,
          responseType: 'text',
        });
        const raw = typeof res.data === 'string' ? res.data : '';
        const body = svc.kind === 'html' ? htmlToText(raw) : raw;
        if (!body || body.length < 40) {
          lastError = new Error('empty body');
          continue;
        }
        if (svc.name !== 'jina') console.log('reader: text came from ' + svc.name);
        return parseReaderBody(body);
      } catch (err) {
        lastError = err;
        console.warn(
          'reader ' + svc.name + ' failed (attempt ' + attempt + ' of ' + attempts + '): ' + err.message
        );
      }
    }
  }
  if (lastError) console.warn('reader fallback gave up:', lastError.message);
  return null;
}

module.exports = { fetchReadablePage, readerConfigured, parseReaderBody, readerServices, htmlToText };
