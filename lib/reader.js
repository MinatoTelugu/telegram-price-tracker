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
 * Configuration — environment variables only:
 *   READER_API_URL     prefix, default https://r.jina.ai/
 *   READER_TIMEOUT_MS  default 8000
 *
 * Like every other fallback here it is best-effort: any failure returns null and
 * the caller keeps whatever it already had.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_PREFIX = 'https://r.jina.ai/';
const TIMEOUT = parseInt(process.env.READER_TIMEOUT_MS || '8000', 10);

function readerConfigured() {
  return String(process.env.READER_API_URL || DEFAULT_PREFIX).length > 0;
}

function readerUrl(target) {
  const prefix = process.env.READER_API_URL || DEFAULT_PREFIX;
  return prefix.replace(/\/?$/, '/') + target;
}

/**
 * @returns {Promise<{title: string|null, text: string|null}|null>}
 */
async function fetchReadablePage(url) {
  if (!url) return null;
  try {
    const res = await axios.get(readerUrl(url), {
      timeout: TIMEOUT,
      headers: { Accept: 'text/plain' },
      validateStatus: () => true,
      responseType: 'text',
    });
    const body = typeof res.data === 'string' ? res.data : '';
    if (!body || body.length < 40) return null;

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

    return { title: title || null, text: body.slice(0, 60000) };
  } catch (err) {
    console.warn('reader fallback failed:', err.message);
    return null;
  }
}

module.exports = { fetchReadablePage, readerConfigured };
