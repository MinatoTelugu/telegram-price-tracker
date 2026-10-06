/**
 * lib/shorten.js
 * ---------------------------------------------------------------------------
 * Shorten a URL with Bitly's v4 API. The token is read from the
 * BITLY_ACCESS_TOKEN environment variable — never hardcoded.
 *
 * If the token is missing or Bitly fails, we return null and the caller falls
 * back to the original URL, so a Bitly outage never blocks a post.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');

const BITLY_ENDPOINT = 'https://api-ssl.bitly.com/v4/shorten';

async function shortenUrl(longUrl) {
  const token = process.env.BITLY_ACCESS_TOKEN;
  if (!token) return null;
  if (!longUrl) return null;

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
    return (res.data && res.data.link) || null;
  } catch (err) {
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    console.warn('bitly shorten failed:', detail);
    return null;
  }
}

module.exports = { shortenUrl };
