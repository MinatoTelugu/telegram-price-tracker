/**
 * lib/search.js
 * ---------------------------------------------------------------------------
 * OPTIONAL search fallback for product names.
 *
 * Amazon refuses page requests from this host, so for a bare /dp/ASIN link we
 * sometimes end up with nothing and the card falls back to the ASIN. This module
 * asks a licensed SEARCH API for Amazon results and reads the product name out
 * of them.
 *
 * Why a search API and not a Google scrape: scraping Google's results breaches
 * their terms and Google refuses automated queries from datacenter IPs — the
 * same wall we hit with Amazon. A licensed search API is meant to be called this
 * way, and it can be restricted to amazon.in so the results are on-point.
 *
 * LangSearch (https://langsearch.com) is the default provider. Its Free Plan
 * includes every feature at $0, metered in TOKENS per day (resetting 00:00 UTC),
 * not in requests. Titles and URLs are NOT counted — only the query and the
 * returned text — so requesting snippets keeps usage small.
 *
 * Configuration — environment variables only, never hardcode the key:
 *   LANGSEARCH_API_KEY    your key (unset = disabled, nothing else changes)
 *   LANGSEARCH_API_URL    default https://api.langsearch.com/v1/web-search
 *   LANGSEARCH_TIMEOUT_MS default 6000
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_ENDPOINT = 'https://api.langsearch.com/v1/web-search';
const TIMEOUT = parseInt(process.env.LANGSEARCH_TIMEOUT_MS || '6000', 10);

function searchConfigured() {
  return Boolean(process.env.LANGSEARCH_API_KEY);
}

function endpoint() {
  return process.env.LANGSEARCH_API_URL || DEFAULT_ENDPOINT;
}

/**
 * Run one web search.
 * @param {string} query
 * @param {{count?: number, domains?: string[], fullText?: boolean}} [opts]
 * @returns {Promise<Array<{name: string, url: string, text: string}>>}
 */
async function webSearch(query, opts) {
  if (!searchConfigured() || !query) return [];
  const o = opts || {};

  const body = {
    query: String(query).slice(0, 200),
    count: Math.min(Math.max(o.count || 5, 1), 50),
  };
  // Restricting to the store keeps results on-point and the token cost down.
  if (o.domains && o.domains.length) body.includeDomains = o.domains;
  // Snippets are enough for a title and cost far fewer output tokens than full
  // page text. Full text is only requested when we actually need page content.
  if (o.fullText) body.contents = { text: { maxCharacters: 4000 } };

  try {
    const res = await axios.post(endpoint(), body, {
      headers: {
        Authorization: 'Bearer ' + process.env.LANGSEARCH_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: TIMEOUT,
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      const detail = res.data ? JSON.stringify(res.data).slice(0, 160) : '';
      console.warn('search: langsearch returned ' + res.status + ' ' + detail);
      return [];
    }
    const pages = res.data && res.data.data && res.data.data.webPages;
    const value = (pages && pages.value) || [];
    return value.map((r) => ({
      name: r && r.name ? String(r.name) : '',
      url: r && r.url ? String(r.url) : '',
      // `text` in full-text mode, `snippet` otherwise.
      text: r && (r.text || r.snippet) ? String(r.text || r.snippet) : '',
    }));
  } catch (err) {
    console.warn('search: langsearch request failed — ' + err.message);
    return [];
  }
}

/**
 * Best product name for an ASIN or product URL, taken from Amazon search results.
 * @returns {Promise<string|null>}
 */
async function searchProductTitle({ asin, url } = {}) {
  const term = asin ? asin + ' amazon.in' : url || '';
  if (!term) return null;

  const results = await webSearch(term, { count: 5, domains: ['amazon.in'] });
  if (!results.length) return null;

  // Prefer a result whose title looks like a product name, not a category page.
  for (const r of results) {
    const name = r.name.replace(/\s+/g, ' ').trim();
    if (name.length < 12) continue;
    if (/^(amazon\.in|amazon india|buy |shop |electronics store)/i.test(name)) continue;
    // Drop the trailing site suffix Amazon appends to its page titles.
    return name.replace(/\s*[:|\-–]\s*Amazon\.in.*$/i, '').trim();
  }
  return null;
}

module.exports = { webSearch, searchProductTitle, searchConfigured };
