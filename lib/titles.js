/**
 * lib/titles.js
 * ---------------------------------------------------------------------------
 * ONE definition of what counts as a usable PRODUCT NAME, shared by the bot and
 * the cron.
 *
 * These rules used to be duplicated — the bot had them, the cron had a weaker
 * set of its own — and they drifted. That drift is how an A+ marketing mashup
 * ("IQOO Prismatic Dimensity Processor OriginOS") reached the card: the fallback
 * accept-sites checked only isPlaceholderTitle, so a title from the metadata /
 * reader / hosted-API source that merely LOOKED like a name overwrote a better
 * one. Anything that accepts a title must ask isUsableTitle() and nothing else.
 * ---------------------------------------------------------------------------
 */

const PLACEHOLDER_SLUGS = new Set([
  'product', 'products', 'item', 'items', 'dl', 'p', 'dp', 'd', 'gp', 'buy', 'shop', 'store', 'detail', 'details',
]);
const ERROR_PAGE_TITLES = [
  /^\s*\d{3}\b/,                       // "503 - Service Unavailable", "403 Forbidden"
  /^\s*service unavailable\b/i,
  /^\s*access denied\b/i,
  /^\s*robot check\b/i,
  /^\s*are you a robot\b/i,
  /^\s*just a moment\b/i,               // Cloudflare interstitial
  /^\s*attention required\b/i,
  /^\s*verify(ing)? (you|your)/i,
  /^\s*(captcha|checking your browser)\b/i,
  /^\s*(error|not found|page not found|404|bad gateway|gateway timeout)\s*$/i,
  /^\s*amazon\.(in|com)\s*$/i,
  /^\s*flipkart\.com\s*$/i,
];
const STORE_NAMES = 'amazon(\\.[a-z.]{2,6})?( india)?|flipkart|myntra|ajio|nykaa|meesho|snapdeal|tatacliq';
const GENERIC_STORE_WORDS =
  'shop online|online shopping|electronics store|online store|buy online|home page|electronics';

function isErrorPageTitle(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  return ERROR_PAGE_TITLES.some((re) => re.test(t));
}

function isPlaceholderTitle(title, productId) {
  const s = String(title || '').trim();
  if (!s) return true;
  if (isErrorPageTitle(s)) return true;
  if (productId && s.toLowerCase() === String(productId).toLowerCase()) return true;
  if (PLACEHOLDER_SLUGS.has(s.toLowerCase())) return true;
  if (s.length < 4) return true;
  // ASIN / FSN style: all uppercase letters and digits, no spaces.
  if (/^[A-Z0-9]{10,}$/.test(s)) return true;
  // A short-link SLUG: one token, mixed case with digits, no spaces — the shape
  // of an amzn.in / dl.flipkart.com path segment, never a product name.
  if (!/\s/.test(s) && s.length <= 12 && /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) {
    return true;
  }
  return false;
}

function isGenericStoreTitle(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return true;

  // The WHOLE title must be the store name (or a generic store phrase). An
  // earlier version matched any title that merely STARTED with a store name,
  // which threw away Amazon's og:title — it reads
  // "Amazon.in: <real product title> : Electronics" — and made every Amazon card
  // fall back to "This product".
  const whole = new RegExp('^(' + STORE_NAMES + '|' + GENERIC_STORE_WORDS + ')$');

  // Judge the CORE too: strip a leading store prefix and a trailing store or
  // "Electronics" suffix, so "Amazon.in: Electronics" is still caught while
  // "Amazon.in: Samsung Galaxy M17 5G : Electronics" is kept.
  const core = t
    .replace(new RegExp('^(' + STORE_NAMES + ')\\s*[:\\-–]\\s*', 'i'), '')
    .replace(new RegExp('\\s*[:\\-–]\\s*(' + STORE_NAMES + '|' + GENERIC_STORE_WORDS + ')$', 'i'), '')
    .trim();

  return whole.test(t) || whole.test(core);
}

function looksLikeMarketingCopy(title) {
  const t = String(title || '').trim();
  if (t.length < 12) return false;
  const hasDigit = /\d/.test(t);
  const hasParen = /[()]/.test(t);
  // STRONG spec tokens only. A real product name nearly always carries one of
  // these (or a digit, or a parenthesis). Category words — camera, mobile,
  // watch, headphones — are deliberately NOT here: marketing copy is full of
  // them, so counting them would rescue a feature bullet like
  // "Monster Camera Turn Moments Into Stories".
  const hasSpec = /\b(gb|tb|ram|rom|mah|inch|cm|mm|mp|5g|4g|lte|oled|amoled|nits)\b/i.test(t);
  if (hasDigit || hasParen || hasSpec) return false;

  // No digit, no parenthesis and no spec token at all. A short name is still
  // plausible ("Boat Airdopes"), but a long run of words is A+ copy — the shape
  // that produced "IQOO Prismatic Dimensity Processor OriginOS" for a real
  // product whose actual name is "iQOO Z9s".
  // ...unless it ENDS in a product category, which is how a real name without a
  // model number reads ("Boat Rockerz Bluetooth Headphones"). A+ copy strings
  // feature nouns together and does not end in one ("Monster Camera Turn Moments
  // Into Stories").
  if (
    /\b(headphones?|earbuds?|earphones?|speakers?|soundbar|mobile|phone|smartphone|laptop|tablet|smartwatch|watch|television|monitor|camera|charger|cable|power\s?bank|trimmer|mixer|shoes?|sandals?|shirts?|tshirt|kurta|saree|jeans|dress|bag|backpack|bottle|toy)\s*$/i.test(
      t
    )
  ) {
    return false;
  }

  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= 4;
}

function isUsableTitle(title, productId) {
  const s = String(title || '').trim();
  if (!s) return false;
  if (isPlaceholderTitle(s, productId)) return false;
  if (isErrorPageTitle(s)) return false;
  if (isGenericStoreTitle(s)) return false;
  if (looksLikeMarketingCopy(s)) return false;
  return true;
}

module.exports = {
  PLACEHOLDER_SLUGS,
  ERROR_PAGE_TITLES,
  STORE_NAMES,
  GENERIC_STORE_WORDS,
  isErrorPageTitle,
  isPlaceholderTitle,
  isGenericStoreTitle,
  looksLikeMarketingCopy,
  isUsableTitle,
};
