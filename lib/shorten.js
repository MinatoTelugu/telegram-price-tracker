/**
 * lib/shorten.js
 * ---------------------------------------------------------------------------
 * Shorten a URL with Bitly's v4 API. The token is read from the
 * BITLY_ACCESS_TOKEN environment variable — never hardcoded.
 *
 * If the token is missing or Bitly fails, we return null and the caller falls
 * back to the original URL, so a Bitly outage never blocks a message.
 *
 * Results are cached in-process, so a link that appears in a list is only
 * shortened once per run.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');

const BITLY_ENDPOINT = 'https://api-ssl.bitly.com/v4/shorten';
const cache = new Map();

async function shortenUrl(longUrl) {
  if (!longUrl) return null;

  const token = process.env.BITLY_ACCESS_TOKEN;
  if (!token) return null;

  if (cache.has(longUrl)) return cache.get(longUrl);

  try {
    const res = await axios.post(
      BITLY_ENDPOINT,
      { long_url: longUrl },
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    const link = (res.data && res.data.link) || null;
    if (link) cache.set(longUrl, link);
    return link;
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    console.warn('bitly shorten failed:', detail);
    return null;
  }
}

/** True if a Bitly token is configured (used by /diag). */
function bitlyConfigured() {
  return Boolean(process.env.BITLY_ACCESS_TOKEN);
}

module.exports = { shortenUrl, bitlyConfigured };
