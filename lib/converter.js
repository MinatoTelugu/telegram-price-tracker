/**
 * lib/converter.js
 * ---------------------------------------------------------------------------
 * Client for the Affiliaters / EarnKaro link converter.
 *
 * Hybrid affiliate setup:
 *   Amazon          -> your direct Amazon Associates tag (lib/affiliate.js)
 *   Everything else -> sent to this converter, which rebuilds the URL with
 *                      YOUR EarnKaro / network IDs and returns the final link.
 *
 * API (as documented by Affiliaters):
 *   POST  https://ekaro-api.affiliaters.in/api/converter/public
 *   Auth  Authorization: Bearer <API_KEY>
 *   Body  { "deal": "<text containing the link(s)>", "convert_option": "convert_only" }
 *   It returns the deal text with every link converted (and shortened), so we
 *   pull the first URL back out of the reply.
 *
 * Configuration (environment variables — never hardcode the token):
 *   AFFILIATERS_CONVERTER_URL   default: the public converter endpoint
 *   AFFILIATERS_TOKEN           your API key
 *
 * If the token is missing, convertWithProvider() returns null and the caller
 * falls back to its normal behaviour, so nothing ever breaks.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent'); // keep-alive connection reuse

const DEFAULT_ENDPOINT = 'https://ekaro-api.affiliaters.in/api/converter/public';
const REQUEST_TIMEOUT = 10000;

function endpoint() {
  return process.env.AFFILIATERS_CONVERTER_URL || DEFAULT_ENDPOINT;
}

function converterConfigured() {
  return Boolean(process.env.AFFILIATERS_TOKEN);
}

/** First http(s) URL in a blob of text. */
function firstUrl(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

/** Pull the converted deal text out of whatever shape the API replies with. */
function pickDealText(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;

  const fields = [
    'deal',
    'converted_deal',
    'convertedDeal',
    'converted',
    'result',
    'message',
    'text',
    'output',
  ];
  for (const f of fields) {
    if (typeof data[f] === 'string') return data[f];
  }
  if (data.data) return pickDealText(data.data);
  return null;
}

/**
 * Convert one URL through the converter.
 * @param {string} text  the URL, or a deal message containing URLs
 * @returns {Promise<string|null>} the converted link, or null.
 */
async function convertWithProvider(text) {
  if (!converterConfigured() || !text) return null;

  const token = process.env.AFFILIATERS_TOKEN;

  try {
    const res = await axios.post(
      endpoint(),
      { deal: String(text), convert_option: 'convert_only' },
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    );

    const deal = pickDealText(res.data);
    const link = firstUrl(deal);
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

/**
 * Raw converter response, for diagnostics only (/diag). Returns a string so it
 * can be shown verbatim — we need to see whether the API hands back a product
 * title alongside the converted link.
 */
async function convertRaw(text) {
  if (!converterConfigured() || !text) return null;
  try {
    const res = await axios.post(
      endpoint(),
      { deal: String(text), convert_option: 'convert_only' },
      {
        headers: { Authorization: 'Bearer ' + process.env.AFFILIATERS_TOKEN, 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      }
    );
    return JSON.stringify(res.data).slice(0, 500);
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    return 'ERROR: ' + detail;
  }
}

module.exports = { convertWithProvider, converterConfigured, pickDealText, firstUrl, convertRaw };
