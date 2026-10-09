/**
 * api/telegram.js
 * ---------------------------------------------------------------------------
 * Telegram webhook handler (Vercel serverless function).
 *
 * Flow for an incoming message that contains an Amazon/Flipkart link:
 *   1. extract the link
 *   2. convertAffiliateLink() -> clean affiliate URL   (lib/affiliate.js)
 *   3. upsert the user + track the product in Firestore (lib/firebase.js)
 *   4. reply with the affiliate link and an inline "Price Track" button
 *
 * Why we call bot.handleUpdate() directly instead of bot.webhookCallback():
 * webhookCallback's built-in filter does a strict string compare on req.url,
 * which is unreliable behind Vercel's routing. Handling it ourselves lets us
 * verify the Telegram secret header explicitly and normalise the body.
 *
 * Diagnostics: a GET returns a small JSON status report (which env vars are
 * present, whether Firebase initialised, and — when you pass ?key=<CRON_SECRET>
 * — the live Telegram getWebhookInfo). Open it in a browser to debug setup.
 *
 * Env vars used here:
 *   BOT_TOKEN                  -> Telegram bot token from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET    -> the secret_token you pass to setWebhook (optional)
 *   WEB_APP_URL                -> base URL of the price-history page
 *   FIREBASE_SERVICE_ACCOUNT_KEY -> Firestore credentials
 *   CRON_SECRET                -> gates the detailed diagnostic
 * ---------------------------------------------------------------------------
 */

const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');

// Bump this whenever behaviour changes. /diag prints it, so we can tell at a
// glance whether the running deployment is the newest code or an old build.
const BUILD = 'names-60 (2026-10-09)';
const {
  convertAffiliateLink,
  resolveShortUrl,
  detectMarketplace,
  extractAmazonAsin,
  extractFlipkartPid,
} = require('../lib/affiliate');
const { convertWithProvider, converterConfigured, convertRaw } = require('../lib/converter');
const { fetchProduct, resolveProductName } = require('../lib/scraper');
const { fetchMetadata } = require('../lib/metadata');

// Load Firebase defensively: a bad/missing credential must NOT crash the whole
// module, or even the liveness GET would 500 and give us nothing to debug with.
let fb = null;
let fbError = null;
try {
  fb = require('../lib/firebase');
} catch (err) {
  fbError = err.message;
  console.error('Firebase failed to initialise at load time:', err.message);
}
const db = fb && fb.db;
const admin = fb && fb.admin;
const COLLECTIONS = (fb && fb.COLLECTIONS) || {
  USERS: 'users',
  PRODUCTS: 'products',
  PRICE_HISTORY: 'price_history',
};

const MARKETPLACE_LABEL = { amazon: '🛒 Amazon', flipkart: '🛍️ Flipkart' };

/** Escape a string for Telegram HTML parse mode (& < > only). */
function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The site ORIGIN from WEB_APP_URL, discarding any path or query. This matters:
 * if WEB_APP_URL were set to e.g. "https://host/api/telegram", the naive
 * "WEB_APP_URL + '/?id='" build produced a broken link like
 * "https://host/api/telegram/?id=...". Using the origin keeps links correct.
 */
// Fallback deployment for the web chart page. Set WEB_APP_URL to override.
const DEFAULT_WEB_URL = 'https://aipricealertbot.koyeb.app';

function webAppBase() {
  const raw = process.env.WEB_APP_URL || DEFAULT_WEB_URL;
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).origin;
  } catch (err) {
    return String(raw).replace(/\/+$/, '');
  }
}

/** Units that should stay uppercase in a product name ("128 GB", not "Gb"). */
const UPPERCASE_UNITS = new Set(['gb', 'tb', 'mb', 'kb', 'mm', 'cm', 'kg', 'ml', 'lt', 'hz', 'mah']);

/** Brand spellings that a naive title-case would get wrong. */
const BRAND_FIXES = {
  iphone: 'iPhone',
  ipad: 'iPad',
  airpods: 'AirPods',
  macbook: 'MacBook',
  oneplus: 'OnePlus',
  realme: 'realme',
  redmi: 'Redmi',
  poco: 'POCO',
};

/** Turn a URL slug like "apple-iphone-15-blue-128-gb" into "Apple iPhone 15 Blue 128 GB". */
function prettifySlug(slug) {
  const s = decodeURIComponent(String(slug)).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 3) return null;
  return s
    .split(' ')
    .map((w) => {
      const lower = w.toLowerCase();
      if (BRAND_FIXES[lower]) return BRAND_FIXES[lower];
      if (UPPERCASE_UNITS.has(lower)) return lower.toUpperCase();
      // "5g" -> "5G", "128gb" -> "128GB"
      const m = w.match(/^(\d+)([a-z]{1,3})$/i);
      if (m) return m[1] + m[2].toUpperCase();
      return /^[A-Z0-9]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** Path segments that are placeholders, not product names. */
const PLACEHOLDER_SLUGS = new Set([
  'product', 'products', 'item', 'items', 'dl', 'p', 'dp', 'd', 'gp', 'buy', 'shop', 'store', 'detail', 'details',
]);

function isPlaceholderSlug(slug) {
  const s = String(slug || '').toLowerCase();
  return !s || PLACEHOLDER_SLUGS.has(s) || s.length < 4;
}

/**
 * A stored title that is really just a placeholder word ("Product", "Item")
 * OR a raw product id ("B0DFHCZMWY", "MOBHETX6NVUH8VPG") must be treated as
 * missing, so it gets re-derived instead of being shown as a name.
 */
function isPlaceholderTitle(title, productId) {
  const s = String(title || '').trim();
  if (!s) return true;
  if (productId && s.toLowerCase() === String(productId).toLowerCase()) return true;
  if (PLACEHOLDER_SLUGS.has(s.toLowerCase())) return true;
  if (s.length < 4) return true;
  // ASIN / FSN style: all uppercase letters and digits, no spaces.
  if (/^[A-Z0-9]{10,}$/.test(s)) return true;
  return false;
}

/**
 * Derive a product name straight from the link — no network needed.
 * Flipkart links carry the name as the path slug, and Amazon links usually do
 * too (e.g. /Samsung-Galaxy-M14-5G/dp/B0DFHCZMWY). This is the reliable
 * fallback when the product page itself cannot be scraped (Amazon blocks us).
 */
function titleFromUrl(urlStr) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(urlStr) ? urlStr : 'https://' + urlStr);
  } catch (err) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host.includes('flipkart')) {
    const i = parts.indexOf('p');
    if (i > 0 && !isPlaceholderSlug(parts[i - 1])) return prettifySlug(parts[i - 1]);
    // Otherwise the FIRST segment is usually the real slug.
    if (parts[0] && !isPlaceholderSlug(parts[0])) return prettifySlug(parts[0]);
    return null;
  }
  if (host.includes('amazon')) {
    const i = parts.findIndex((p) => p === 'dp' || p === 'product' || p === 'd');
    if (i > 0 && !isPlaceholderSlug(parts[i - 1])) return prettifySlug(parts[i - 1]);
    return null;
  }
  return null;
}

/** Reject if a promise doesn't settle within ms, so a hung API call can't stall a handler. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** Stable Firestore doc id for a product: e.g. "amazon_B08N5WRWNW". */
function productDocId(result) {
  return result.marketplace + '_' + result.productId;
}

/** Short, uppercase-looking per-product token used in the /stop_<token> command. */
function stopTokenFor(docId) {
  const h = crypto.createHash('sha1').update(String(docId)).digest('hex');
  const n = BigInt('0x' + h.slice(0, 15));
  return n.toString(36).padStart(12, '0').slice(0, 12);
}

/**
 * Who may run /diag. Prefers ADMIN_USER_ID; otherwise the first person to run
 * /diag becomes the admin and is remembered in Firestore. The command is not
 * listed in the bot menu, so only the owner knows it exists.
 */
async function resolveAdminId(ctx) {
  const configured = String(process.env.ADMIN_USER_ID || '').trim();
  if (configured) return configured;
  if (!db || !ctx.from) return null;
  try {
    const ref = db.collection('_config').doc('admin');
    const snap = await ref.get();
    if (snap.exists) return String(snap.data().userId || '');
    const id = String(ctx.from.id);
    await ref.set({ userId: id, setAt: new Date() }, { merge: true });
    return id;
  } catch (err) {
    console.warn('resolveAdminId failed:', err.message);
    return null;
  }
}

/**
 * Find a product from a /stop_<token> or /remove_<token> command.
 *
 * The displayed token is DERIVED from the doc id when the doc has no stored
 * stopToken (products tracked before tokens existed), so a plain database
 * lookup would miss those. We therefore fall back to comparing the derived
 * token across the user's own products.
 */
async function findProductByToken(uid, token) {
  const wanted = String(token || '').toLowerCase();
  if (!wanted) return null;

  // 1) fast path: a stored token.
  try {
    const snap = await db.collection(COLLECTIONS.PRODUCTS).where('stopToken', '==', wanted).limit(1).get();
    if (!snap.empty) return snap.docs[0];
  } catch (err) {
    console.warn('stopToken lookup failed:', err.message);
  }

  // 2) slow path: walk this user's products and compare derived tokens.
  const scans = [
    db.collection(COLLECTIONS.PRODUCTS).where('subscribers', 'array-contains', uid).limit(50),
    db.collection(COLLECTIONS.PRODUCTS).where('stoppedBy', 'array-contains', uid).limit(50),
  ];
  for (const q of scans) {
    try {
      const snap = await q.get();
      for (const doc of snap.docs) {
        const stored = String((doc.data() || {}).stopToken || '').toLowerCase();
        if (stored && stored === wanted) return doc;
        if (stopTokenFor(doc.id).toLowerCase() === wanted) return doc;
      }
    } catch (err) {
      console.warn('token scan failed:', err.message);
    }
  }
  return null;
}


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gap between broadcast dispatches — 50ms default keeps us clear of 429s. */
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '50', 10);



const LIST_DIVIDER = '____________________________________';

// ---- simple per-user rate limit ------------------------------------------
// Matches the reference bot's "Too many requests" guard. Set
// RATE_LIMIT_PER_MINUTE=0 to disable it.
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const rateBuckets = new Map();

function isRateLimited(userId) {
  if (!RATE_LIMIT || RATE_LIMIT <= 0) return false;
  const now = Date.now();
  const hits = (rateBuckets.get(userId) || []).filter((t) => now - t < 60000);
  hits.push(now);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // safety valve
  rateBuckets.set(userId, hits);
  return hits.length > RATE_LIMIT;
}

/**
 * Build and send the tracking list. Shows BOTH products being tracked and
 * products the user has stopped, in the reference layout:
 *
 *   1. <b>Full product name</b>
 *
 *   Click here to view in Flipkart!
 *
 *   [ View Price History! ]
 *
 *   Click /stop_<TOKEN> to stop this product.
 *   _______________________________________
 */
async function sendTrackingList(ctx) {
  try {
    if (!ctx.from) return;
    if (!db) {
      await ctx.reply(DB_DOWN);
      return;
    }
    const uid = String(ctx.from.id);

    // Only ACTIVELY tracked products. Stopped products are not listed at all,
    // and they are not counted in the total.
    const activeSnap = await db
      .collection(COLLECTIONS.PRODUCTS)
      .where('subscribers', 'array-contains', uid)
      .limit(30)
      .get();

    const items = activeSnap.docs.map((d) => ({ doc: d, data: d.data(), active: true }));

    if (!items.length) {
      await ctx.reply('You are not tracking anything yet. Send an Amazon or Flipkart link to start.');
      return;
    }

    // Fill in missing product names: derive from the link first (instant), then
    // try the page if there is budget. Bounded so the list stays quick.
    let backfilled = 0;
    for (const it of items) {
      // Re-derive when the title is missing, a placeholder, or a raw id.
      if (!isPlaceholderTitle(it.data.title, it.data.productId)) continue;
      const src = it.data.resolvedUrl || it.data.cleanUrl || it.data.affiliateUrl || '';

      let got = titleFromUrl(src);
      if (!got && backfilled < 2) {
        try {
          const r = await withTimeout(
            resolveProductName({
              marketplace: it.data.marketplace,
              productId: it.data.productId,
              cleanUrl: it.data.cleanUrl,
              affiliateUrl: it.data.affiliateUrl,
              resolvedUrl: it.data.resolvedUrl,
            }),
            2500
          );
          if (r && r.resolvedUrl) it.data.resolvedUrl = r.resolvedUrl;
          got = (r && r.title) || titleFromUrl((r && r.resolvedUrl) || '') || null;
          backfilled++;
        } catch (err) {
          /* non-fatal — fall back to the id */
        }
      }

      if (got) {
        it.data.title = got;
        if (it.doc.ref) {
          try {
            await it.doc.ref.set({ title: got, resolvedUrl: it.data.resolvedUrl || null }, { merge: true });
          } catch (e) {
            /* non-fatal */
          }
        }
      } else if (isPlaceholderTitle(it.data.title)) {
        // Drop a stored placeholder so it stops being shown as a name.
        it.data.title = null;
      }
    }

    const lines = ['🛍️ <b>Your tracked products</b> (' + items.length + ')', ''];
    const buttonRows = [];
    let index = 0;
    for (const it of items) {
      index++;
      const d = it.data;
      const rawToken = d.stopToken || stopTokenFor(it.doc.id);
      // Persist the token for products tracked before tokens existed.
      if (!d.stopToken && it.doc.ref) {
        try {
          await it.doc.ref.set({ stopToken: String(rawToken).toLowerCase() }, { merge: true });
        } catch (e) {
          /* non-fatal */
        }
      }
      const storedTitle = isPlaceholderTitle(d.title, d.productId) ? null : d.title;
      const title =
        cleanProductTitle(storedTitle) ||
        titleFromUrl(d.resolvedUrl || d.cleanUrl || d.affiliateUrl || '') ||
        d.productId ||
        it.doc.id;
      const market =
        d.marketplace === 'amazon' ? 'Amazon' : d.marketplace === 'flipkart' ? 'Flipkart' : d.marketplace;
      const price = d.lastPrice != null ? '₹' + Number(d.lastPrice).toLocaleString('en-IN') : null;
      const meta = [price, market].filter(Boolean).join(' · ');

      // Styled per-item block, matching the requested template:
      //   🛍️ 1. Title
      //   🏷️ Flipkart
      //   (blank)
      //   🔗 Click here to view in Flipkart!
      //   📊 [ View Price History! ]
      //   🛑 Click /stop_TOKEN to stop tracking this product.
      //   (blank line — the gap before the next product)
      const buy = d.affiliateUrl || d.cleanUrl;
      const token = String(rawToken).toUpperCase();
      const base = webAppBase();

      // Exact per-item structure:
      //   🛍️ <b>N. Title</b>
      //   🏷️ <i>Store</i>
      //   (blank)
      //   🔗 link
      //   📊 history
      //   (blank)
      //   🛑 Click <code>/stop_TOKEN</code> ...
      //   _______________________________________
      //   (blank)
      // Reference structure — a blank line between EVERY line — with extra
      // emphasis (bold title, italic store, emoji) so it reads better than the
      // original.
      lines.push('🛍️ <b>' + index + '. ' + escapeHtml(title) + '</b>');
      lines.push('');
      lines.push('🏷️ <i>' + escapeHtml(market) + '</i>');
      lines.push('');
      if (buy) {
        lines.push('🔗 <a href="' + escapeHtml(buy) + '">Click here to view in ' + escapeHtml(market) + '!</a>');
        lines.push('');
      }
      if (base) {
        lines.push(
          '📊 <a href="' +
            escapeHtml(base + '/?id=' + encodeURIComponent(it.doc.id)) +
            '">[ View Price History! ]</a>'
        );
      } else {
        lines.push('📊 Click /history_' + token + ' to view the price history.');
      }
      lines.push('');
      // Plain text, NOT <code>: Telegram auto-links /commands as blue and
      // clickable, and a code span adds a grey box that wraps badly.
      lines.push('🛑 Click /stop_' + token + ' to stop this product.');
      lines.push(LIST_DIVIDER);
      // The gap before the next product.
      lines.push('');

      // Its own buttons, numbered to match the item above. Telegram keyboards
      // attach to a message, so numbering is how we tie a button to its item.
      if (buttonRows.length < 10) {
        buttonRows.push([
          Markup.button.callback('❌ Stop ' + index, 'untrack:' + it.doc.id),
          Markup.button.callback('📊 History ' + index, 'history:' + it.doc.id),
        ]);
      }
    }
    lines.push('');
    lines.push('🦋 <b>Total Products: ' + items.length + '</b>');

    const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (buttonRows.length) opts.reply_markup = Markup.inlineKeyboard(buttonRows);
    await ctx.reply(lines.join('\n'), opts);
  } catch (err) {
    console.error('sendTrackingList failed', err);
  }
}

/**
 * Return the first token that looks like a URL — ANY url, not just
 * Amazon/Flipkart, so other platforms can be handed back untouched.
 */
function extractUrl(text) {
  if (!text) return null;
  const tokens = String(text).split(/\s+/);
  for (const t of tokens) {
    if (/^https?:\/\//i.test(t)) return t;
  }
  for (const t of tokens) {
    if (/^(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(t)) return t;
  }
  return null;
}

/** Create the user doc on first contact, refresh lastSeenAt on every contact. */
async function upsertUser(from) {
  const ref = db.collection(COLLECTIONS.USERS).doc(String(from.id));
  const snap = await ref.get();
  const data = {
    telegramId: from.id,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
    username: from.username || null,
    languageCode: from.language_code || null,
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!snap.exists) data.createdAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(data, { merge: true });
}

/**
 * Add the product to Firestore and subscribe this user to it.
 * Price fields are left null here; the cron job fills them on its first run.
 * One product doc per marketplace+productId, so price history is shared.
 */
async function trackProduct(result, from, info) {
  const docId = productDocId(result);
  const ref = db.collection(COLLECTIONS.PRODUCTS).doc(docId);
  const snap = await ref.get();
  const extra = info || {};

  const data = {
    marketplace: result.marketplace,
    productId: result.productId,
    cleanUrl: result.cleanUrl,
    affiliateUrl: result.affiliateUrl,
    stopToken: stopTokenFor(docId),
    subscribers: admin.firestore.FieldValue.arrayUnion(String(from.id)),
    stoppedBy: admin.firestore.FieldValue.arrayRemove(String(from.id)),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    active: true,
  };

  if (result.resolvedUrl) data.resolvedUrl = result.resolvedUrl;
  if (extra.resolvedUrl) data.resolvedUrl = extra.resolvedUrl;
  if (extra.title) data.title = extra.title;
  if (extra.imageUrl) data.imageUrl = extra.imageUrl;
  if (extra.price != null) {
    data.lastPrice = extra.price;
    data.currency = extra.currency || 'INR';
    data.lastCheckedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (!snap.exists) {
    data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    if (data.title === undefined) data.title = null;
    if (data.imageUrl === undefined) data.imageUrl = null;
    if (data.lastPrice === undefined) data.lastPrice = null;
    if (data.currency === undefined) data.currency = 'INR';
    if (data.lastCheckedAt === undefined) data.lastCheckedAt = null;
  }

  await ref.set(data, { merge: true });

  // Seed the first price point so the graph isn't empty straight away.
  if (extra.price != null && typeof ref.collection === 'function') {
    try {
      await ref.collection(COLLECTIONS.PRICE_HISTORY).add({
        price: extra.price,
        currency: extra.currency || 'INR',
        checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn('history seed failed:', err.message);
    }
  }

  return docId;
}

/** Unsubscribe a user from a product (and remember that they stopped it). */
async function untrackProduct(docId, from) {
  const ref = db.collection(COLLECTIONS.PRODUCTS).doc(docId);
  await ref.set(
    {
      subscribers: admin.firestore.FieldValue.arrayRemove(String(from.id)),
      stoppedBy: admin.firestore.FieldValue.arrayUnion(String(from.id)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Telegram channel the "Today's Deals" button points at. */
const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/Ai_PriceAlert';

/**
 * The welcome image. Defaults to the bundled public/welcome.jpg served by this
 * deployment; set BOT_LOGO_URL to use a different image instead.
 */
function botLogoUrl() {
  if (process.env.BOT_LOGO_URL) return process.env.BOT_LOGO_URL;
  const base = webAppBase();
  return base ? base + '/welcome.jpg' : null;
}

/**
 * Inline keyboard, a 2x2 grid matching the reference layout:
 *   [ ✅ Buy Now ]        [ 🔴 Stop Tracking ]
 *   [ 📊 Price History ]  [ 🛍️ Today's Deals ]
 *
 * NOTE: Telegram inline buttons carry no styling — no colours, gradients or
 * corner radius. Only the labels and the 2x2 layout can be matched here. The
 * full visual design would need a Telegram Mini App (an HTML page).
 */
function buildTrackKeyboard(docId, result) {
  const buyUrl = result && (result.affiliateUrl || result.cleanUrl);

  const row1 = [];
  if (buyUrl) row1.push(Markup.button.url('✅ Buy Now', buyUrl));
  row1.push(Markup.button.callback('🔴 Stop Tracking', 'untrack:' + docId));

  const row2 = [];
  // A callback (not a URL button) so the price log is posted right in the chat;
  // the log itself carries a button through to the full chart.
  // Opens the web chart page directly — the in-chat text log is still available
  // via /history_<token>.
  const chartUrl = webAppBase() ? webAppBase() + '/?id=' + encodeURIComponent(docId) : null;
  if (chartUrl) row2.push(Markup.button.url('📊 Price History', chartUrl));
  else row2.push(Markup.button.callback('📊 Price History', 'history:' + docId));
  row2.push(Markup.button.url("🛍️ Today's Deals", CHANNEL_URL));

  const rows = [row1, row2];
  return Markup.inlineKeyboard(rows);
}

/**
 * Headers for an INTERNAL call to our own cron endpoints. They must carry the
 * same bearer token cron-job.org sends, or the endpoint answers 401 to itself
 * once CRON_SECRET is configured.
 */
function internalCronHeaders() {
  return process.env.CRON_SECRET ? { authorization: 'Bearer ' + process.env.CRON_SECRET } : {};
}

/**
 * Classify a link WITHOUT any network call. Returns null when we cannot be sure
 * of the product identity from the URL alone (e.g. a dl.flipkart.com share
 * link) — those must be resolved first, because the resolved id decides which
 * record they belong to.
 */
function quickClassify(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const market = detectMarketplace(host);
    if (market === 'amazon') {
      const asin = extractAmazonAsin(raw);
      if (!asin) return null;
      return {
        marketplace: 'amazon',
        productId: asin,
        cleanUrl: 'https://' + host + '/dp/' + asin,
        title: titleFromUrl(raw),
      };
    }
    if (market === 'flipkart') {
      const pid = extractFlipkartPid(u);
      if (!pid) return null;
      return {
        marketplace: 'flipkart',
        productId: pid,
        cleanUrl: raw.split('?')[0],
        title: titleFromUrl(raw),
      };
    }
  } catch (err) {
    /* not classifiable */
  }
  return null;
}

/**
 * Background enrichment for the instant-reply path. Converts the link, reads the
 * page, updates the record, and EDITS the message we already sent — so the user
 * sees one card that fills itself in rather than waiting a minute for it.
 */
async function enrichTracked(ctx, sentMessage, rawUrl, from) {
  try {
    const result = await convertAffiliateLink(rawUrl);
    if (!result || !result.ok) return;

    let info = {
      title: titleFromUrl(result.resolvedUrl || rawUrl || result.cleanUrl),
      price: null,
      currency: 'INR',
      imageUrl: null,
    };

    const [scraped, viaConverter] = await Promise.all([
      withTimeout(fetchProduct(result.affiliateUrl || result.cleanUrl, result.marketplace), 2500).catch(() => null),
      result.affiliateUrl && result.affiliateUrl !== result.cleanUrl
        ? withTimeout(resolveShortUrl(result.affiliateUrl), 4000).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (scraped) {
      info = {
        title: betterTitle(scraped.title, info.title),
        price: scraped.ok ? scraped.price : null,
        currency: scraped.currency || 'INR',
        imageUrl: scraped.imageUrl || null,
        inStock: typeof scraped.inStock === 'boolean' ? scraped.inStock : null,
      };
    }
    if (viaConverter) {
      const fromLink = titleFromUrl(viaConverter);
      if (fromLink && !isPlaceholderTitle(fromLink, result.productId)) {
        info.title = fromLink;
        info.resolvedUrl = viaConverter;
      }
    }
    if (isPlaceholderTitle(info.title, result.productId)) {
      const resolved = await withTimeout(
        resolveProductName({
          marketplace: result.marketplace,
          productId: result.productId,
          cleanUrl: result.cleanUrl,
          affiliateUrl: result.affiliateUrl,
          resolvedUrl: result.resolvedUrl,
        }),
        4000
      ).catch(() => null);
      const name = (resolved && resolved.title) || titleFromUrl((resolved && resolved.resolvedUrl) || '');
      if (name && !isPlaceholderTitle(name, result.productId)) {
        info.title = name;
        if (resolved.resolvedUrl) info.resolvedUrl = resolved.resolvedUrl;
      }
    }

    // Still nothing? Our IP is refused by the store (Amazon especially). Ask a
    // metadata service, which fetches the page from its own servers.
    if (isPlaceholderTitle(info.title, result.productId)) {
      const meta = await fetchMetadata(result.cleanUrl || result.affiliateUrl).catch(() => null);
      if (meta) {
        const named = betterTitle(meta.title, titleFromUrl(result.cleanUrl || ''));
        if (named && !isPlaceholderTitle(named, result.productId)) {
          info.title = named;
          console.log('track: recovered the name via metadata — ' + String(named).slice(0, 70));
        }
        if (!info.imageUrl && meta.image) info.imageUrl = meta.image;
      }
    }

    await trackProduct(result, from, info);

    // Fill in the card we already sent.
    if (sentMessage && sentMessage.message_id && ctx.chat && ctx.telegram && ctx.telegram.editMessageText) {
      const text = formatTrackingConfirmation(result, info, null);
      await ctx.telegram
        .editMessageText(ctx.chat.id, sentMessage.message_id, undefined, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
      console.log('track: enriched message for ' + result.productId);
    }
  } catch (err) {
    console.warn('background enrichment failed:', err.message);
  }
}

/**
 * Pick between the name derived from the URL and the one scraped off the page.
 *
 * The URL slug comes from the store's own canonical link, so it can never be a
 * stray page fragment. The scraped title is fuller when it is genuine — Amazon
 * and Flipkart slugs are truncated forms of the official name — but it is also
 * what produced nonsense like "Samsung Moonlight Storage Upgrades Lag Free"
 * (a feature-bullet picked up instead of the product title).
 *
 * So: keep the scraped title only when it plausibly extends the URL name;
 * otherwise trust the URL.
 */
function betterTitle(scrapedTitle, urlTitle) {
  const s = scrapedTitle ? String(scrapedTitle).replace(/\s+/g, ' ').trim() : null;
  const u = urlTitle ? String(urlTitle).replace(/\s+/g, ' ').trim() : null;
  if (!s) return u;
  if (!u) return s;
  const key = u.split(' ').slice(0, 3).join(' ').toLowerCase();
  if (key && s.toLowerCase().includes(key)) return s;
  return u;
}

/** Firestore Timestamp | Date | seconds -> Date (or null). */
function tsToDate(ts) {
  try {
    if (!ts) return null;
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch (err) {
    return null;
  }
}

/**
 * Store cards truncate long names mid-word and append "...more" (Flipkart).
 * Strip that so the name reads cleanly, and drop the half-word it cut off.
 */
function cleanProductTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const wasTruncated = /\s*[.…]{2,}\s*more$/i.test(t);
  t = t.replace(/\s*[.…]{2,}\s*more$/i, '').trim();
  t = t.replace(/\s*[.…]{2,}$/i, '').trim();
  if (wasTruncated) {
    // "…Smart WebOS TV 2" -> "…Smart WebOS TV" (the "2" was cut off)
    const m = t.match(/^(.*?)\s+([A-Za-z0-9]{1,2})$/);
    if (m && !UPPERCASE_UNITS.has(m[2].toLowerCase())) t = m[1].trim();
  }
  return t || null;
}

/** Set HIDE_TAG_WARNING=true to suppress the "no affiliate tag" note. */
function tagWarningHidden() {
  const v = String(process.env.HIDE_TAG_WARNING || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** "06 Oct 2026, 14:37" in IST. */
function formatStamp(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(date.getTime() + 5.5 * 60 * 60 * 1000); // IST
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(d.getUTCDate()) + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
    ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
  );
}

/** The "link sent" confirmation, matching the reference layout. */
function formatTrackingConfirmation(result, info, openUrl) {
  const market = result.marketplace === 'amazon' ? 'Amazon' : 'Flipkart';
  const open = openUrl || result.affiliateUrl || result.cleanUrl;
  // NOTE: no leading link line. It duplicated the link and made Telegram render
  // its own link preview. This card is the whole message.
  const lines = [
    '<b>The Product has Started Tracking!</b>',
    '',
    '☀️ <b>' + escapeHtml(info.title || result.productId) + '</b>',
  ];
  if (info.inStock === false) {
    lines.push('', '😔 <b>Currently Out of Stock</b>');
  }
  if (info.price != null) {
    const sym = (info.currency || 'INR') === 'INR' ? '₹' : '';
    lines.push('', 'Current Price: <b>' + sym + Number(info.price).toLocaleString('en-IN') + '</b>');
  }
  lines.push('', '<a href="' + escapeHtml(open) + '">Click here to open in ' + market + '!</a>');
  lines.push('', '⏱️ Updated at [ ' + formatStamp(new Date()) + ' ]');
  return lines.join('\n');
}

const CONVERT_ERRORS = {
  unsupported_marketplace: 'That link is not from Amazon or Flipkart.',
  asin_not_found: 'I could not find the Amazon product ID in that link.',
  flipkart_id_not_found: 'I could not find the Flipkart product ID in that link.',
  shortlink_unresolved: 'I could not open that short link (it may have expired).',
  invalid_url: 'That does not look like a valid link.',
  empty_input: 'Please send a link.',
  // Shown as a clear warning rather than handing back a raw/broken link.
  unsupported_store: '⚠️ <b>Store Not Supported</b>\n\nI can convert and track Amazon and Flipkart links, plus convert links from other stores.',
  conversion_failed: '⚠️ <b>Link Conversion Failed</b>\n\nI could not create an affiliate link for that store just now. Please try again in a moment.',
};

const DB_DOWN = '⚠️ My database is not configured yet, so I cannot track that link. Please try again later.';

function registerHandlers(bot) {
  // Rate limit first, so a flood gets one clear message instead of many replies.
  bot.use(async (ctx, next) => {
    try {
      if (ctx.from && isRateLimited(String(ctx.from.id))) {
        await ctx.reply('⛔ Too many requests, please slow down!');
        return;
      }
    } catch (err) {
      /* never block on the limiter itself */
    }
    // Save/update the user on EVERY interaction, so /broadcast can reach them.
    // Fire-and-forget: it must never slow the reply down.
    if (ctx.from && db) {
      upsertUser(ctx.from).catch((err) => console.warn('user upsert failed:', err.message));
      // And, if a price check is due, run one in the background.
      maybeRunPriceChecks('update').catch(() => {});
    }
    return next();
  });

  /**
   * Opportunistic price check. On a host that sleeps, a timer only fires while
   * the instance is awake — so we ALSO run a check whenever the bot is actually
   * being used, throttled to PRICE_CHECK_MINUTES (default 30). Fire-and-forget:
   * it must never slow a reply.
   */
  let lastPriceRunAt = 0;
  let priceRunInFlight = false;
  async function maybeRunPriceChecks(reason) {
    const everyMs = Math.max(5, parseInt(process.env.PRICE_CHECK_MINUTES || '30', 10)) * 60 * 1000;
    if (priceRunInFlight || Date.now() - lastPriceRunAt < everyMs) return;
    priceRunInFlight = true;
    lastPriceRunAt = Date.now();
    try {
      const cronFn = require('./cron');
      await cronFn(
        { method: 'GET', headers: internalCronHeaders(), query: {} },
        { statusCode: 0, setHeader() {}, end() {} }
      );
      console.log('price check: opportunistic run complete (' + reason + ')');
    } catch (err) {
      console.warn('price check: opportunistic run failed — ' + err.message);
    } finally {
      priceRunInFlight = false;
    }
  }

  // GLOBAL: never render a link preview on any outgoing message. Done here once
  // rather than repeating link_preview_options at every reply call site.
  bot.use(async (ctx, next) => {
    const withNoPreview = (fn) => async (first, extra) => {
      const opts = Object.assign({}, extra || {}, { link_preview_options: { is_disabled: true } });
      return fn.call(ctx, first, opts);
    };
    if (typeof ctx.reply === 'function') ctx.reply = withNoPreview(ctx.reply);
    if (typeof ctx.replyWithPhoto === 'function') ctx.replyWithPhoto = withNoPreview(ctx.replyWithPhoto);
    return next();
  });

  bot.start(async (ctx) => {
    const caption =
      '🎉 Great to see you! Welcome!\n\n' +
      '=> I am the Ai Price Alert Bot. I can track product prices and send you instant alerts.\n\n' +
      '=> Just send me an Amazon or Flipkart product link, and I will notify you when the price drops.\n\n' +
      '=> Supported URLs: [ Amazon, Flipkart ]\n\n' +
      'Save Time! Save Money!!\n\n' +
      'Click /help to get more help.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url("🛍️ Today's Deals", CHANNEL_URL)],
      [Markup.button.callback('📋 My List', 'mylist')],
    ]);

    // Reply FIRST so the welcome is instant; the DB write happens after it.
    try {
      const logoUrl = botLogoUrl(); // bundled public/welcome.jpg (or BOT_LOGO_URL)
      if (logoUrl && typeof ctx.replyWithPhoto === 'function') {
        try {
          await withTimeout(ctx.replyWithPhoto(logoUrl, { caption, parse_mode: 'HTML', ...keyboard }), 5000);
        } catch (err) {
          console.warn('welcome photo failed, falling back to text:', err.message);
          await ctx.reply(caption, { parse_mode: 'HTML', ...keyboard });
        }
      } else {
        await ctx.reply(caption, { parse_mode: 'HTML', ...keyboard });
      }
    } catch (err) {
      console.error('start handler failed', err);
      try {
        await ctx.reply('Welcome! Send me an Amazon or Flipkart product link to start tracking prices.');
      } catch (_) {
        /* nothing more we can do */
      }
    }

    // Best-effort registration, after the reply has already gone out.
    if (db && ctx.from) {
      try {
        await upsertUser(ctx.from);
      } catch (err) {
        console.error('start upsert failed:', err.message);
      }
    }
  });

  bot.help(async (ctx) => {
    try {
      await ctx.reply(
        '<b>How it works</b>\n\n' +
          '1. Paste an Amazon or Flipkart product link (short links like amzn.to work too).\n' +
          '2. I start tracking its price for 30 days.\n' +
          '3. Every few hours I check the price and alert you when it drops.\n' +
          '4. Tap “📊 Price History” to see the 30-day graph.\n\n' +
          '/list – your tracked products\n' +
          '/untrack &lt;id&gt; – stop tracking one',
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('help handler failed', err);
    }
  });

  // Self-diagnosis — ADMIN ONLY, and never listed in the bot menu. Non-admins
  // get no reply at all, so the command is invisible to everyone else.
  bot.command('diag', async (ctx) => {
    try {
      if (!ctx.from) return;
      const adminId = await resolveAdminId(ctx);
      if (!adminId || String(ctx.from.id) !== String(adminId)) return;
    } catch (err) {
      console.error('diag auth check failed:', err.message);
      return;
    }

    const lines = ['🩺 <b>Diagnostics</b>', ''];
    try {
      lines.push('build: <code>' + escapeHtml(BUILD) + '</code>');
      lines.push('BOT_TOKEN: ' + (process.env.BOT_TOKEN ? 'set' : 'MISSING'));
      lines.push('FIREBASE_SERVICE_ACCOUNT_KEY: ' + (process.env.FIREBASE_SERVICE_ACCOUNT_KEY ? 'set' : 'not set'));
      lines.push(
        'three-part credentials: ' +
          (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
            ? 'set'
            : 'not set')
      );
      lines.push('BITLY_ACCESS_TOKEN: ' + (process.env.BITLY_ACCESS_TOKEN ? 'set' : 'not set'));
      lines.push('WEB_APP_URL: ' + (process.env.WEB_APP_URL || 'not set'));
      lines.push(
        'AFFILIATERS_TOKEN: ' +
          (process.env.AFFILIATERS_TOKEN ? 'set' : 'NOT set — Flipkart/other links will not be converted')
      );
      lines.push('AFFILIATERS_CONVERTER_URL: ' + (process.env.AFFILIATERS_CONVERTER_URL || '(default)'));
      lines.push(
        'CUELINKS_API_KEY: ' +
          (process.env.CUELINKS_API_KEY
            ? 'set (' + (process.env.CUELINKS_API_URL || 'default endpoint') + ')'
            : 'NOT set — non-Amazon links use the fallback')
      );
      lines.push('AMAZON_AFFILIATE_TAG: ' + (process.env.AMAZON_AFFILIATE_TAG || 'not set'));
      const channelId =
        process.env.CHANNEL_ID || process.env.DEALS_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID;
      lines.push(
        'CHANNEL_ID: ' +
          (channelId || '(default)') +
          (process.env.CHANNEL_ID
            ? '  [from CHANNEL_ID]'
            : channelId
            ? '  [from a legacy var — rename it to CHANNEL_ID]'
            : '')
      );
      if (db) {
        try {
          const users = await db.collection(COLLECTIONS.USERS).get();
          lines.push('saved users (broadcast reach): ' + users.size);
        } catch (e) {
          lines.push('saved users: could not read — ' + escapeHtml(String(e.message).slice(0, 80)));
        }
      }
      // Price-check health: is the loop actually running, and is it succeeding?
      if (db) {
        try {
          const snap = await db.collection(COLLECTIONS.PRODUCTS).limit(50).get();
          const docs = snap.docs.map((d) => d.data());
          const withPrice = docs.filter((d) => d.lastPrice != null).length;
          const withCheck = docs.filter((d) => d.lastCheckedAt).length;
          let newest = null;
          for (const d of docs) {
            const t = tsToDate(d.lastCheckedAt);
            if (t && (!newest || t > newest)) newest = t;
          }
          const errors = {};
          for (const d of docs) {
            if (d.lastCheckError) errors[d.lastCheckError] = (errors[d.lastCheckError] || 0) + 1;
          }
          lines.push('');
          lines.push('📉 <b>Price-check health</b>');
          lines.push('products (first 50): ' + docs.length);
          lines.push('with a stored price: ' + withPrice);
          lines.push('ever checked: ' + withCheck);
          lines.push('last check: ' + (newest ? formatStamp(newest) : 'NEVER'));
          const errKeys = Object.keys(errors);
          if (errKeys.length) {
            lines.push('last-check errors: ' + errKeys.map((k) => k + '×' + errors[k]).join(', '));
          }
        } catch (e) {
          lines.push('price-check health: could not read — ' + escapeHtml(String(e.message).slice(0, 80)));
        }
      }
      lines.push(
        'PAAPI (Amazon official API): ' +
          (process.env.PAAPI_ACCESS_KEY && process.env.PAAPI_SECRET_KEY && process.env.PAAPI_PARTNER_TAG
            ? 'configured — Amazon reads via PA-API'
            : 'NOT configured — Amazon page reads will be refused by Amazon')
      );
      lines.push(
        'LANGSEARCH_API_KEY (name search fallback): ' +
          (process.env.LANGSEARCH_API_KEY ? 'set' : 'NOT set')
      );
      lines.push('firebase initialised: ' + (db ? 'yes' : 'NO'));
      if (fbError) lines.push('firebase load error: <code>' + escapeHtml(String(fbError).slice(0, 220)) + '</code>');

      if (fb && typeof fb.loadServiceAccount === 'function') {
        try {
          const sa = fb.loadServiceAccount();
          lines.push('project_id: <code>' + escapeHtml(sa.project_id || '(none)') + '</code>');
          lines.push('client_email: <code>' + escapeHtml(sa.client_email || '(none)') + '</code>');
          const pk = String(sa.private_key || '');
          lines.push('private_key length: ' + pk.length);
          lines.push('private_key header: <code>' + escapeHtml(pk.split('\n')[0]) + '</code>');
        } catch (err) {
          lines.push('credential error: <code>' + escapeHtml(String(err.message).slice(0, 220)) + '</code>');
        }
      }

      if (db) {
        try {
          await db.collection(COLLECTIONS.PRODUCTS).limit(1).get();
          lines.push('firestore read: OK');
        } catch (err) {
          lines.push(
            'firestore read FAILED: <code>' +
              escapeHtml(String(err.code || '') + ' ' + String(err.message || err).slice(0, 300)) +
              '</code>'
          );
        }

        try {
          const ref = db.collection('_diag').doc('ping');
          await ref.set({ at: Date.now() });
          await ref.delete();
          lines.push('firestore write: OK');
        } catch (err) {
          lines.push(
            'firestore write FAILED: <code>' +
              escapeHtml(String(err.code || '') + ' ' + String(err.message || err).slice(0, 300)) +
              '</code>'
          );
        }

        // Name-resolution test: what happens when we try to find real names?
        try {
          const snap = await db.collection(COLLECTIONS.PRODUCTS).limit(3).get();
          let shown = 0;
          for (const doc of snap.docs) {
            const d = doc.data();
            const r = await withTimeout(
              resolveProductName({
                marketplace: d.marketplace,
                productId: d.productId,
                cleanUrl: d.cleanUrl,
                affiliateUrl: d.affiliateUrl,
                resolvedUrl: d.resolvedUrl,
              }),
              20000
            );
            const name = (r && r.title) || titleFromUrl((r && r.resolvedUrl) || '') || null;
            lines.push(
              'name <code>' + escapeHtml(doc.id) + '</code>: ' +
                (name ? 'OK — ' + escapeHtml(String(name).slice(0, 60)) : 'FAILED (' + escapeHtml(String((r && r.reason) || '?')) + ')') +
                ' | landed <code>' + escapeHtml(String((r && r.resolvedUrl) || '(none)').slice(0, 100)) + '</code>'
            );

            // Show what the converter returns for this link — we need to know
            // whether its response carries the product title (for links whose
            // URL has no name slug). First product only, to stay quick.
            if (shown === 0 && converterConfigured() && d.cleanUrl) {
              shown++;
              try {
                const raw = await withTimeout(convertRaw(d.cleanUrl), 10000);
                if (raw) lines.push('  converter raw: <code>' + escapeHtml(String(raw).slice(0, 300)) + '</code>');
              } catch (err) {
                lines.push('  converter raw: failed — ' + escapeHtml(String(err.message).slice(0, 120)));
              }
            }
          }
        } catch (err) {
          lines.push('name test failed: <code>' + escapeHtml(String(err.message).slice(0, 200)) + '</code>');
        }
      }
    } catch (err) {
      lines.push('diagnostic failed: <code>' + escapeHtml(String(err.message).slice(0, 220)) + '</code>');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command(['mytracks', 'list'], sendTrackingList);

  bot.command('untrack', async (ctx) => {
    try {
      if (!ctx.from) return;
      const docId = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim();
      if (!docId) {
        await ctx.reply('Usage: /untrack <id>\nGet the id from /mytracks.');
        return;
      }
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
      const snap = await db.collection(COLLECTIONS.PRODUCTS).doc(docId).get();
      if (!snap.exists) {
        await ctx.reply('I could not find that tracking id. Check /mytracks.');
        return;
      }
      await untrackProduct(docId, ctx.from);
      await ctx.reply('🛑 Stopped tracking <code>' + escapeHtml(docId) + '</code>.', {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('untrack handler failed', err);
    }
  });

  // Per-product stop, matching the reference "Click /stop_<id>" style.
  bot.hears(/^\/stop_([a-z0-9]+)\b/i, async (ctx) => {
    try {
      if (!ctx.from) return;
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
      const token = String(ctx.match[1]).toLowerCase();
      const doc = await findProductByToken(String(ctx.from.id), token);
      if (!doc) {
        await ctx.reply('I could not find that product. Send /list to see your tracking list.');
        return;
      }
      const d = doc.data();
      await untrackProduct(doc.id, ctx.from);
      await ctx.reply('🛑 Stopped tracking <b>' + escapeHtml(d.title || d.productId || doc.id) + '</b>.', {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('stop handler failed', err);
    }
  });

  // Permanently remove a product from the user's record (tracked and stopped).
  bot.hears(/^\/remove_([a-z0-9]+)\b/i, async (ctx) => {
    try {
      if (!ctx.from) return;
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
      const token = String(ctx.match[1]).toLowerCase();
      const doc = await findProductByToken(String(ctx.from.id), token);
      if (!doc) {
        await ctx.reply('I could not find that product.');
        return;
      }
      const d = doc.data();
      await doc.ref.set(
        {
          subscribers: admin.firestore.FieldValue.arrayRemove(String(ctx.from.id)),
          stoppedBy: admin.firestore.FieldValue.arrayRemove(String(ctx.from.id)),
        },
        { merge: true }
      );
      await ctx.reply('🗑️ Removed <b>' + escapeHtml(d.title || d.productId || doc.id) + '</b> from your list.', {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('remove handler failed', err);
    }
  });

  // Price History: post a TEXT LOG of the recent prices in the chat, with a
  // button through to the full chart page.
  bot.action(/^history:(.+)$/, async (ctx) => {
    try {
      if (typeof ctx.answerCbQuery === 'function') {
        try {
          await ctx.answerCbQuery();
        } catch (e) {
          /* ignore */
        }
      }
      await sendPriceHistory(ctx, String(ctx.match[1]));
    } catch (err) {
      console.error('history handler failed', err);
    }
  });

  // /history_<TOKEN> — the same thing, reachable straight from the /list text.
  bot.hears(/^\/history_([a-z0-9]+)\b/i, async (ctx) => {
    try {
      if (!ctx.from) return;
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
      const token = String(ctx.match[1]).toLowerCase();
      const doc = await findProductByToken(String(ctx.from.id), token);
      if (!doc) {
        await ctx.reply('I could not find that product. Send /list to see your tracking list.');
        return;
      }
      await sendPriceHistory(ctx, doc.id);
    } catch (err) {
      console.error('history command failed', err);
    }
  });

  async function sendPriceHistory(ctx, docId) {
    try {
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
      const doc = await db.collection(COLLECTIONS.PRODUCTS).doc(docId).get();
      if (!doc.exists) {
        await ctx.reply('I could not find that product.');
        return;
      }
      const d = doc.data();
      const name = d.title || d.productId || docId;

      const snap = await doc.ref
        .collection(COLLECTIONS.PRICE_HISTORY)
        .orderBy('checkedAt', 'desc')
        .limit(15)
        .get();
      const points = snap.docs.map((x) => x.data()).filter((p) => p && p.price != null);

      const lines = ['📊 <b>' + escapeHtml(name) + '</b>', ''];
      if (!points.length) {
        lines.push('No price points recorded yet — check back after the next scheduled run.');
      } else {
        const prices = points.map((p) => Number(p.price));
        lines.push('🕒 <b>Recent prices</b>');
        for (const p of points) {
          const when = tsToDate(p.checkedAt);
          lines.push('• ' + (when ? formatStamp(when) : '—') + ' — ₹' + Number(p.price).toLocaleString('en-IN'));
        }
        lines.push('');
        lines.push(
          '📉 Lowest ₹' +
            Math.min(...prices).toLocaleString('en-IN') +
            '   📈 Highest ₹' +
            Math.max(...prices).toLocaleString('en-IN')
        );
      }

      const base = webAppBase();
      const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
      if (base) {
        opts.reply_markup = Markup.inlineKeyboard([
          [Markup.button.url('🌐 View Full Chart on Web', base + '/?id=' + encodeURIComponent(docId))],
        ]);
      }
      await ctx.reply(lines.join('\n'), opts);
    } catch (err) {
      console.error('price history failed', err);
    }
  }

  // /check — ADMIN ONLY. Runs the individual price-tracking loop RIGHT NOW and
  // reports what it did, so the loop is never a black box again.
  bot.command('check', async (ctx) => {
    try {
      if (!ctx.from) return;
      const adminId = await resolveAdminId(ctx);
      if (!adminId || String(ctx.from.id) !== String(adminId)) return;
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }

      await ctx.reply('🔍 Running a price check now…');

      let body = '';
      const cronFn = require('./cron');
      // A SMALL batch: this is a diagnostic, and a full run (every product, with
      // retries and timeouts) can take minutes. Three products answer the
      // question — does the loop see them, and does the scrape succeed?
      await cronFn(
        { method: 'GET', headers: internalCronHeaders(), query: { limit: '3' } },
        { statusCode: 0, setHeader() {}, end(b) { body = b; } }
      );

      let summary = null;
      try {
        summary = JSON.parse(body || '{}');
      } catch (e) {
        summary = null;
      }
      if (!summary) {
        await ctx.reply('The check ran but returned nothing readable.');
        return;
      }
      if (summary.ok === false) {
        await ctx.reply(
          '❌ <b>The price check FAILED</b>\n\n' + escapeHtml(String(summary.error || 'unknown')),
          { parse_mode: 'HTML' }
        );
        return;
      }

      const lines = [
        '✅ <b>Price check complete</b>',
        '',
        'products in db: ' + (summary.totalProducts != null ? summary.totalProducts : '?'),
        'active (scanned): ' + (summary.scanned || 0),
        'processed: ' + (summary.processed || 0),
        'checked: ' + (summary.checked || 0),
        'skipped: ' + (summary.skipped || 0),
        'alerts sent: ' + (summary.alertsSent || 0),
      ];

      const results = Array.isArray(summary.results) ? summary.results.slice(0, 10) : [];
      if (results.length) {
        lines.push('', '— results —');
        for (const r of results) {
          lines.push(
            escapeHtml(String(r.id).slice(0, 28)) +
              ' → ' +
              escapeHtml(String(r.status || '?')) +
              (r.reason ? ' (' + escapeHtml(String(r.reason)) + ')' : '') +
              (r.httpStatus ? ' HTTP ' + r.httpStatus : '') +
              (r.oldPrice != null && r.price != null ? ' ' + r.oldPrice + '→' + r.price : '') +
              (r.alerts ? ' 🔔' + r.alerts : '')
          );
          // For a skip, show WHICH url was fetched — that is what tells us
          // whether we are hitting a dead share link, a 500 page, or a block.
          if (r.url) lines.push('     <code>' + escapeHtml(String(r.url).slice(0, 90)) + '</code>');
        }
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('check command failed:', err);
      await ctx.reply('The check failed: ' + String(err.message).slice(0, 200));
    }
  });

  // /broadcast — ADMIN ONLY, and silent for everyone else.
  //   /broadcast <text>            send that text to every saved user
  //   reply to a message + /broadcast   send that message's text
  bot.command('broadcast', async (ctx) => {
    try {
      if (!ctx.from) return;
      const adminId = await resolveAdminId(ctx);
      if (!adminId || String(ctx.from.id) !== String(adminId)) return; // invisible to others
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }

      const raw = String((ctx.message && ctx.message.text) || '');
      const inlineText = raw.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
      const replied = ctx.message && ctx.message.reply_to_message ? ctx.message.reply_to_message : null;

      // If the admin REPLIED to a post, we copy that message verbatim — so a
      // photo, its caption, and any bold/italic formatting come through exactly.
      // For inline text there is no source message worth copying (it would
      // include the "/broadcast" command itself), so we send the text.
      const useCopy = Boolean(replied);
      const text = inlineText;

      if (!useCopy && !text) {
        await ctx.reply(
          'Usage: <code>/broadcast &lt;text&gt;</code> — or reply to a message with /broadcast.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.reply('📣 Broadcasting to all users…');

      const snap = await db.collection(COLLECTIONS.USERS).get();
      let sent = 0;
      let failed = 0;
      for (const doc of snap.docs) {
        const chatId = doc.id;
        try {
          if (useCopy) {
            // Copies the WHOLE message: photo/video, caption, entities, links.
            await ctx.telegram.copyMessage(chatId, ctx.chat.id, replied.message_id);
          } else {
            await ctx.telegram.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
            });
          }
          sent++;
        } catch (err) {
          failed++; // blocked bot, deleted account, etc.
        }
        // Flood control: a small gap between dispatches avoids 429s.
        await sleep(BROADCAST_DELAY_MS);
      }

      await ctx.reply('✅ <b>Broadcast completed.</b>\n\nSent: ' + sent + '\nFailed: ' + failed, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('broadcast failed:', err);
      try {
        await ctx.reply('Broadcast failed: ' + String(err.message).slice(0, 200));
      } catch (e) {
        /* nothing more we can do */
      }
    }
  });

  bot.on('text', async (ctx) => {
    try {
      if (!ctx.from) return;
      const text = ctx.message.text || '';
      if (text.startsWith('/')) return; // commands are handled above

      const url = extractUrl(text);
      if (!url) {
        await ctx.reply(
          'Send me a product link and I will start tracking its price.\n\n' +
            'Example: https://www.amazon.in/dp/B08N5WRWNW'
        );
        return;
      }

      // Feedback without clutter: a typing indicator, not a chat message.
      try {
        if (typeof ctx.sendChatAction === 'function') await ctx.sendChatAction('typing');
      } catch (err) {
        /* not fatal */
      }
      // ---- FAST PATH ---------------------------------------------------------
      // When the URL already carries the product id, we can start tracking with
      // NO network call at all. Reply instantly, save immediately, then enrich
      // in the background and edit the card in place. This is what removes the
      // minute-long wait.
      const quick = quickClassify(url);
      if (quick && db) {
        const t0 = Date.now();
        await upsertUser(ctx.from).catch(() => {});
        const instantResult = {
          ok: true,
          marketplace: quick.marketplace,
          productId: quick.productId,
          cleanUrl: quick.cleanUrl,
          affiliateUrl: quick.cleanUrl,
          hasAffiliateTag: false,
          originalUrl: url,
          resolvedUrl: quick.cleanUrl,
        };
        // A short, bounded read so the FIRST card already carries the price and
        // the real name — the user asked for the price up front. If the store is
        // slow (or refuses us), we still reply immediately with what we have and
        // the background pass fills it in.
        let early = null;
        try {
          early = await withTimeout(
            fetchProduct(instantResult.affiliateUrl || instantResult.cleanUrl, quick.marketplace),
            1800
          );
        } catch (err) {
          /* no early data — the background pass will handle it */
        }

        const instantInfo = {
          title: betterTitle(early && early.title, quick.title),
          price: early && early.ok ? early.price : null,
          currency: (early && early.currency) || 'INR',
          imageUrl: (early && early.imageUrl) || null,
          inStock: early && typeof early.inStock === 'boolean' ? early.inStock : null,
        };

        const docId = await trackProduct(instantResult, ctx.from, instantInfo);

        const extra = {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...buildTrackKeyboard(docId, instantResult),
        };
        if (ctx.message && ctx.message.message_id) {
          extra.reply_parameters = { message_id: ctx.message.message_id };
        }
        const sent = await ctx.reply(formatTrackingConfirmation(instantResult, instantInfo, null), extra);
        console.log(
          'track: replied in ' + (Date.now() - t0) + 'ms (early price=' +
            (instantInfo.price != null ? instantInfo.price : 'none') + ')'
        );

        // Enrich AFTER replying — never before.
        enrichTracked(ctx, sent, url, ctx.from).catch((err) =>
          console.warn('enrich failed:', err.message)
        );
        return;
      }

      const result = await convertAffiliateLink(url);

      if (!result.ok) {
        await ctx.reply('⚠️ ' + (CONVERT_ERRORS[result.reason] || 'Could not convert that link.'));
        return;
      }

      // A store we can CONVERT but not track: reply with the converted link and
      // NOTHING else — no header, no store label, no meta text. Sent as plain
      // text (no parse_mode) so a URL containing & or ? is never mis-parsed.
      if (result.marketplace === 'other') {
        await ctx.reply(result.affiliateUrl);
        return;
      }

      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }

      await upsertUser(ctx.from);

      // Fetch the title/price now so the confirmation matches the reference.
      // Start from a name derived from the RESOLVED link — a short link carries
      // no product name, but the URL it redirects to does.
      let info = {
        title: titleFromUrl(result.resolvedUrl || url || result.cleanUrl),
        price: null,
        currency: 'INR',
        imageUrl: null,
      };

      const needsName = () => isPlaceholderTitle(info.title, result.productId);
      const canUseConverterLink =
        needsName() && result.affiliateUrl && result.affiliateUrl !== result.cleanUrl;

      // SPEED: the page scrape and the converter-link resolution are independent
      // network calls, so run them CONCURRENTLY. Sequentially the worst case was
      // 2.5s + 4s + 4s; run together it is a single 4s budget.
      const [scraped, viaConverter] = await Promise.all([
        withTimeout(fetchProduct(result.affiliateUrl || result.cleanUrl, result.marketplace), 2500).catch(
          (err) => {
            console.warn('track-time scrape failed:', err.message);
            return null;
          }
        ),
        canUseConverterLink
          ? withTimeout(resolveShortUrl(result.affiliateUrl), 4000).catch((err) => {
              console.warn('converter-link resolution failed:', err.message);
              return null;
            })
          : Promise.resolve(null),
      ]);

      if (scraped) {
        info = {
          title: betterTitle(scraped.title, info.title || titleFromUrl(scraped.resolvedUrl || '')),
          price: scraped.ok ? scraped.price : null,
          currency: scraped.currency || 'INR',
          imageUrl: scraped.imageUrl || null,
          inStock: typeof scraped.inStock === 'boolean' ? scraped.inStock : null,
        };
      }

      // The converter's link redirects to the real product page, so its chain
      // reveals the canonical store URL — and the name from its slug — WITHOUT
      // fetching the store itself.
      if (viaConverter) {
        const fromLink = titleFromUrl(viaConverter);
        if (fromLink && !isPlaceholderTitle(fromLink, result.productId)) {
          info.title = fromLink;
          info.resolvedUrl = viaConverter;
        }
      }

      // Still no real name? One more pass: read og:title from the page.
      if (needsName()) {
        try {
          const resolved = await withTimeout(
            resolveProductName({
              marketplace: result.marketplace,
              productId: result.productId,
              cleanUrl: result.cleanUrl,
              affiliateUrl: result.affiliateUrl,
              resolvedUrl: result.resolvedUrl,
            }),
            4000
          );
          const name =
            (resolved && resolved.title) || titleFromUrl((resolved && resolved.resolvedUrl) || '') || null;
          if (name && !isPlaceholderTitle(name, result.productId)) {
            info.title = name;
            if (resolved.resolvedUrl) info.resolvedUrl = resolved.resolvedUrl;
          }
        } catch (err) {
          console.warn('track-time name resolution failed:', err.message);
        }
      }

      const docId = await trackProduct(result, ctx.from, info);

      // The affiliate link is used directly — no Bitly, so your own tag stays visible.
      const replyText = formatTrackingConfirmation(result, info, null);
      // Reply to the user's own link message, and never render a link preview.
      const extra = {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...buildTrackKeyboard(docId, result),
      };
      if (ctx.message && ctx.message.message_id) {
        extra.reply_parameters = { message_id: ctx.message.message_id };
      }
      let sent = false;
      if (info.imageUrl && typeof ctx.replyWithPhoto === 'function') {
        try {
          await withTimeout(ctx.replyWithPhoto(info.imageUrl, { caption: replyText, ...extra }), 7000);
          sent = true;
        } catch (err) {
          console.warn('product photo failed, falling back to text:', err.message);
        }
      }
      if (!sent) await ctx.reply(replyText, extra);
    } catch (err) {
      console.error('text handler failed', err);
      // Turn the raw Firestore error into something actionable for the user.
      const msg = String((err && err.message) || err);
      let hint = 'Something went wrong while processing that link. Please try again.';
      if (/does not exist|NOT_FOUND/i.test(msg)) {
        hint = '⚠️ My database does not exist yet. Create a Firestore database in the Firebase console, then try again.';
      } else if (/PERMISSION_DENIED|permission/i.test(msg)) {
        hint = '⚠️ I do not have permission to write to the database (check the service account).';
      } else if (/UNAUTHENTICATED|credential|invalid_grant/i.test(msg)) {
        hint = '⚠️ My database credentials were rejected. Please try again later.';
      }
      try {
        await ctx.reply(hint);
      } catch (_) {
        /* reply already failed; nothing else to do */
      }
    }
  });

  bot.action(/^untrack:(.+)$/, async (ctx) => {
    try {
      if (!ctx.from) return;
      if (!db) {
        if (ctx.answerCbQuery) await ctx.answerCbQuery('Database not configured').catch(() => {});
        return;
      }
      const docId = ctx.match[1];
      await untrackProduct(docId, ctx.from);
      if (ctx.answerCbQuery) await ctx.answerCbQuery('Stopped tracking').catch(() => {});
    } catch (err) {
      console.error('action handler failed', err);
    }
  });

  // "📋 My List" button on the welcome message.
  bot.action('mylist', async (ctx) => {
    try {
      if (ctx.answerCbQuery) await ctx.answerCbQuery().catch(() => {});
      await sendTrackingList(ctx);
    } catch (err) {
      console.error('mylist action failed', err);
    }
  });

  bot.catch((err, ctx) => {
    console.error('Bot error on update', ctx && ctx.updateType, err);
  });
}

// --- Lazy bot instance: built on first POST so a plain GET health check works
// --- even before BOT_TOKEN is configured.
let botInstance = null;
function getBot() {
  if (botInstance) return botInstance;
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN env var is required');
  botInstance = new Telegraf(token);
  registerHandlers(botInstance);
  return botInstance;
}

/** Normalise whatever the platform handed us into a Telegram update object. */
function parseBody(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      return null;
    }
  }
  return body;
}

/** Read the update, whether Vercel pre-parsed the body or not. */
async function readUpdate(req) {
  if (req.body != null) return parseBody(req.body);
  // Fallback: pull the raw stream ourselves.
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(parseBody(data)));
    req.on('error', () => resolve(null));
  });
}

/** True if either credential style is present in the environment. */
function firebaseCredentialsPresent() {
  return (
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY) ||
    Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );
}

/**
 * Classify the Firebase init failure WITHOUT echoing any credential bytes.
 * The env var may be a web config (no private_key), malformed JSON, etc.
 */
function firebaseReason() {
  if (!firebaseCredentialsPresent()) return 'env_missing';
  if (!fbError) return null;
  const m = String(fbError);
  if (/could not be parsed/i.test(m)) return 'invalid_json';
  if (/private_key/i.test(m)) return 'missing_private_key';
  if (/client_email/i.test(m)) return 'missing_client_email';
  if (/project_id/i.test(m)) return 'missing_project_id';
  if (/credentials are not set/i.test(m)) return 'env_missing';
  return 'init_failed';
}

/** Human-readable setup problems, safe to expose publicly (no secrets). */
function configProblems() {
  const problems = [];
  if (!process.env.BOT_TOKEN) problems.push('BOT_TOKEN is not set');
  const fr = firebaseReason();
  if (fr === 'env_missing') problems.push('FIREBASE_SERVICE_ACCOUNT_KEY is not set');
  else if (fr === 'invalid_json') problems.push('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON — paste the whole service-account file as a single line');
  else if (fr === 'missing_private_key') problems.push('FIREBASE_SERVICE_ACCOUNT_KEY looks like a WEB config, not a service-account key — it has no private_key');
  else if (fr) problems.push('Firebase failed to initialise (check FIREBASE_SERVICE_ACCOUNT_KEY)');
  if (!process.env.WEB_APP_URL) problems.push('WEB_APP_URL is not set (Price Track button will be hidden)');
  return problems;
}

async function buildDiagnostic(req) {
  const diag = {
    ok: true,
    message: 'Telegram webhook is live.',
    config: {
      botToken: Boolean(process.env.BOT_TOKEN),
      webhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      firebase: firebaseCredentialsPresent() && !fbError,
      webAppUrl: Boolean(process.env.WEB_APP_URL),
      cronSecret: Boolean(process.env.CRON_SECRET),
    },
    firebaseReason: firebaseReason(),
    problems: configProblems(),
  };

  // Read-only Firestore reachability check — proves the database exists and the
  // credentials can read it, without writing anything.
  if (db) {
    try {
      await db.collection(COLLECTIONS.PRODUCTS).limit(1).get();
      diag.firestore = { ok: true };
    } catch (err) {
      diag.firestore = { ok: false, code: err.code || null, message: String(err.message || err).slice(0, 200) };
    }
  } else {
    diag.firestore = { ok: false, message: 'db not initialised' };
  }

  // Deeper check, gated by CRON_SECRET so we don't leak anything publicly.
  const key = (req.query && (req.query.key || req.query.secret)) || '';
  const authorized = process.env.CRON_SECRET && key === process.env.CRON_SECRET;
  if (authorized && process.env.BOT_TOKEN) {
    try {
      const info = await axios.get(
        'https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/getWebhookInfo',
        { timeout: 8000 }
      );
      diag.telegram = info.data && info.data.result;
    } catch (err) {
      diag.telegram = { error: err.message };
    }
  }

  // Always keep the webhook correct: simply opening this page repairs it if it
  // has been mangled. Idempotent — if it is already right, nothing changes.
  if (process.env.DISABLE_WEBHOOK_MANAGEMENT !== '1' && process.env.BOT_TOKEN) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim();
    const url = host ? 'https://' + host + '/api/telegram' : null;
    if (!url) {
      diag.webhook = { ok: false, error: 'no host header' };
    } else {
      try {
        const info = await axios.get(
          'https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/getWebhookInfo',
          { timeout: 8000 }
        );
        const current = info.data && info.data.result && info.data.result.url;
        if (current === url) {
          diag.webhook = { ok: true, unchanged: true, url };
        } else {
          const payload = { url, drop_pending_updates: false };
          if (process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
          await axios.post(
            'https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/setWebhook',
            payload,
            { timeout: 8000 }
          );
          diag.webhook = { ok: true, repaired: true, was: current || null, url };
        }
      } catch (err) {
        diag.webhook = { ok: false, error: err.message };
      }
    }
    if (req.query && (req.query.fixWebhook === '1' || req.query.fixWebhook === 'true')) {
      diag.fixWebhook = diag.webhook;
    }
  }

  return diag;
}

module.exports = async (req, res) => {
  // GET (or anything non-POST) returns a diagnostic report.
  if (req.method !== 'POST') {
    let diag;
    try {
      diag = await buildDiagnostic(req);
    } catch (err) {
      diag = { ok: true, message: 'Telegram webhook is live.', problems: ['diagnostic failed: ' + err.message] };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    // Never cache the diagnostic — a cached copy would hide the query string
    // (e.g. ?fixWebhook=1) and confuse debugging.
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(diag));
    return;
  }

  // Verify the secret_token Telegram echoes back on every delivery.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const received = req.headers['x-telegram-bot-api-secret-token'];
    if (received !== secret) {
      console.warn('Rejected update: secret token mismatch (is TELEGRAM_WEBHOOK_SECRET the same as the secret_token you set?)');
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
  }

  const update = await readUpdate(req);
  if (!update) {
    console.warn('Received a request with no parseable update body.');
    res.statusCode = 200; // ack so Telegram does not retry a malformed payload
    res.end();
    return;
  }

  let bot;
  try {
    bot = getBot();
  } catch (err) {
    console.error(err.message);
    res.statusCode = 500;
    res.end('bot not configured');
    return;
  }

  try {
    await bot.handleUpdate(update, res);
  } catch (err) {
    console.error('Failed to handle update', err);
    if (!res.writableEnded) {
      res.statusCode = 200;
      res.end();
    }
  }
};

// Exposed for unit tests.
module.exports._internals = {
  betterTitle,
  escapeHtml,
  productDocId,
  extractUrl,
  titleFromUrl,
  isPlaceholderTitle,
  webAppBase,
  upsertUser,
  trackProduct,
  untrackProduct,
  buildTrackKeyboard,
  formatTrackingConfirmation,
  registerHandlers,
  getBot,
  parseBody,
  readUpdate,
  configProblems,
};
