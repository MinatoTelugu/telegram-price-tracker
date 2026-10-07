/**
 * lib/converter.js
 * ---------------------------------------------------------------------------
 * Client for an EXTERNAL affiliate-link converter (Affiliaters / EarnKaro).
 *
 * How the hybrid setup works:
 *   Amazon        -> your direct Amazon Associates tag (lib/affiliate.js)
 *   Everything else -> handed to this converter, which rebuilds the URL with
 *                      YOUR EarnKaro / network IDs and returns the final link.
 *
 * Why an external service at all: EarnKaro has no public "make profit link"
 * API — it is an app/website action — and the conversion is account-scoped. A
 * converter like Affiliaters holds your IDs and does that step for you.
 *
 * Configure with two environment variables:
 *   AFFILIATERS_CONVERTER_URL   the converter endpoint
 *   AFFILIATERS_TOKEN           your account token / API key
 *
 * If either is missing, convertWithProvider() returns null and the caller
 * falls back to its normal behaviour — so a missing config can never break
 * link handling.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');

const REQUEST_TIMEOUT = 10000;

function converterConfigured() {
  return Boolean(process.env.AFFILIATERS_CONVERTER_URL && process.env.AFFILIATERS_TOKEN);
}

/** Pull the first usable http(s) link out of whatever shape the API returns. */
function pickLink(data) {
  if (!data) return null;
  if (typeof data === 'string') return /^https?:\/\//i.test(data) ? data : null;

  const fields = [
    'converted_url',
    'convertedUrl',
    'affiliate_url',
    'affiliateUrl',
    'short_url',
    'shortUrl',
    'link',
    'url',
    'result',
  ];
  for (const f of fields) {
    const v = data[f];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  if (data.data) return pickLink(data.data);
  return null;
}

/**
 * Convert one URL through the external converter.
 * @returns {Promise<string|null>} the converted link, or null.
 */
async function convertWithProvider(url) {
  if (!converterConfigured() || !url) return null;

  const endpoint = process.env.AFFILIATERS_CONVERTER_URL;
  const token = process.env.AFFILIATERS_TOKEN;

  try {
    const res = await axios.post(
      endpoint,
      { url, link: url, token },
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-API-Key': token,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    );
    const link = pickLink(res.data);
    if (!link) {
      console.warn('converter returned no link; response was:', JSON.stringify(res.data).slice(0, 200));
    }
    return link;
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    console.warn('converter failed:', detail);
    return null;
  }
}

module.exports = { convertWithProvider, converterConfigured, pickLink };
