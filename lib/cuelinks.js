/**
 * lib/cuelinks.js
 * ---------------------------------------------------------------------------
 * Cuelinks v3 link conversion, for every store EXCEPT Amazon.
 *
 * Amazon is deliberately untouched: it keeps your direct Amazon Associates tag
 * (see lib/affiliate.js). Everything else — Flipkart, Myntra, AJIO, Nykaa and
 * the rest of Cuelinks' merchant list — is converted here.
 *
 * API (per developers.cuelinks.com):
 *   POST https://developers.cuelinks.com/pub_api/v3/links/convert
 *   Authorization: Token <API_KEY>          <-- literally "Token", NOT "Bearer"
 *   Body: { "url": "...", "shorten": true?, "channel_id": 123?, "subid": "..."? }
 *   Reply: { data: { tracking_url, short_url?, affiliated, original_url, campaign } }
 *
 * Configuration — environment variables only, never hardcoded:
 *   CUELINKS_API_KEY        your key (unset = disabled, everything still works)
 *   CUELINKS_API_URL        default: https://developers.cuelinks.com/pub_api/v3
 *   CUELINKS_SHORTEN        "true" to also get a clnk.in short link
 *   CUELINKS_CHANNEL_ID     optional channel to attribute clicks to
 *   CUELINKS_TIMEOUT_MS     default 2500 — a hard, short budget
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
require('./httpAgent');

const DEFAULT_BASE = 'https://developers.cuelinks.com/pub_api/v3';
const TIMEOUT = parseInt(process.env.CUELINKS_TIMEOUT_MS || '2500', 10);

function cuelinksConfigured() {
  return Boolean(process.env.CUELINKS_API_KEY);
}

function baseUrl() {
  return String(process.env.CUELINKS_API_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function authHeaders() {
  return {
    // The scheme is literally "Token". "Bearer" returns 401 on v3.
    Authorization: 'Token ' + process.env.CUELINKS_API_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Convert one merchant URL into a Cuelinks tracking link.
 * @returns {Promise<{link: string, affiliated: boolean, campaign: object|null}|null>}
 */
async function convertWithCuelinks(url) {
  if (!cuelinksConfigured() || !url) return null;

  const body = { url: String(url) };
  // Shorten by DEFAULT so the user gets a clean clnk.in link rather than the
  // raw linksredirect.com tracking URL. Set CUELINKS_SHORTEN=false to opt out.
  if (String(process.env.CUELINKS_SHORTEN ?? 'true').toLowerCase() !== 'false') body.shorten = true;
  if (process.env.CUELINKS_CHANNEL_ID) body.channel_id = Number(process.env.CUELINKS_CHANNEL_ID);

  try {
    const res = await axios.post(baseUrl() + '/links/convert', body, {
      headers: authHeaders(),
      timeout: TIMEOUT,
    });
    const d = res.data && res.data.data ? res.data.data : res.data;
    if (!d) return null;
    const link = d.short_url || d.tracking_url || null;
    if (!link) {
      console.warn('cuelinks returned no link:', JSON.stringify(res.data).slice(0, 200));
      return null;
    }
    return {
      link,
      affiliated: d.affiliated === true,
      campaign: d.campaign || null,
      originalUrl: d.original_url || url,
    };
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    console.warn('cuelinks convert failed:', detail);
    return null;
  }
}

/** Health check for /diag — confirms the key is valid and which publisher it is. */
async function cuelinksPing() {
  if (!cuelinksConfigured()) return null;
  try {
    const res = await axios.get(baseUrl() + '/ping', { headers: authHeaders(), timeout: TIMEOUT });
    return res.data || null;
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 160) : err.message;
    return { error: detail };
  }
}

module.exports = { convertWithCuelinks, cuelinksConfigured, cuelinksPing };
