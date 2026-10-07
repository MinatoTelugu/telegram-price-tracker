/**
 * lib/aiTitle.js
 * ---------------------------------------------------------------------------
 * OPTIONAL last-resort title cleaner.
 *
 * The primary path is always plain HTML parsing (og:title / <title> / JSON-LD)
 * in lib/scraper.js — that is fast and needs no key. This module is only used
 * when that fails or returns something unusable, and only when a token is
 * configured.
 *
 * Configuration (environment variables ONLY — never hardcode a key):
 *   HF_TOKEN      your Hugging Face access token (leave unset to disable)
 *   HF_MODEL      the model to call   (default: google/flan-t5-base)
 *   HF_API_URL    override the endpoint (default: the HF Inference API)
 *
 * If HF_TOKEN is unset this module does nothing and returns null, so the bot
 * keeps working exactly as before.
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');

const DEFAULT_MODEL = 'google/flan-t5-base';
const REQUEST_TIMEOUT = 8000;

function aiConfigured() {
  return Boolean(process.env.HF_TOKEN);
}

/** Pull the generated string out of whatever shape the API replies with. */
function pickText(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  const first = Array.isArray(data) ? data[0] : data;
  if (!first) return null;
  if (typeof first === 'string') return first;
  const fields = ['generated_text', 'summary_text', 'translation_text', 'text'];
  for (const f of fields) {
    if (typeof first[f] === 'string') return first[f];
  }
  return null;
}

/**
 * Ask the model to reduce a messy page title / snippet to just the product name.
 * @param {string} rawText
 * @returns {Promise<string|null>}
 */
async function cleanTitleWithAI(rawText) {
  if (!aiConfigured() || !rawText) return null;

  const model = process.env.HF_MODEL || DEFAULT_MODEL;
  const url = process.env.HF_API_URL || 'https://api-inference.huggingface.co/models/' + model;

  try {
    const res = await axios.post(
      url,
      {
        inputs:
          'Extract ONLY the product name from this text, with no shop name, no price and no extra words: ' +
          String(rawText).replace(/\s+/g, ' ').slice(0, 400),
        options: { wait_for_model: true },
      },
      {
        headers: {
          Authorization: 'Bearer ' + process.env.HF_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT,
      }
    );
    const out = pickText(res.data);
    if (!out) return null;
    const cleaned = String(out).replace(/\s+/g, ' ').trim();
    return cleaned.length > 2 ? cleaned : null;
  } catch (err) {
    const detail =
      err.response && err.response.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    console.warn('HF title fallback failed:', detail);
    return null;
  }
}

module.exports = { cleanTitleWithAI, aiConfigured };
