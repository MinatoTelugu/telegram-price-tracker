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
const { convertAffiliateLink } = require('../lib/affiliate');
const { fetchProduct } = require('../lib/scraper');
const { shortenUrl } = require('../lib/shorten');

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
function webAppBase() {
  const raw = process.env.WEB_APP_URL;
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).origin;
  } catch (err) {
    return String(raw).replace(/\/+$/, '');
  }
}

/** Turn a URL slug like "apple-iphone-15-blue-128-gb" into "Apple Iphone 15 Blue 128 Gb". */
function prettifySlug(slug) {
  const s = decodeURIComponent(String(slug)).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 3) return null;
  return s
    .split(' ')
    .map((w) => (/^[A-Z0-9]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
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
    if (i > 0) {
      const slug = parts[i - 1];
      // The app share link is /product/p/itme?pid=... — "product" is not a name.
      if (slug && slug.toLowerCase() !== 'product') return prettifySlug(slug);
    }
    return null;
  }
  if (host.includes('amazon')) {
    const i = parts.findIndex((p) => p === 'dp' || p === 'product' || p === 'd');
    if (i > 0) {
      const slug = parts[i - 1];
      if (slug && slug.toLowerCase() !== 'product') return prettifySlug(slug);
    }
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

const LIST_DIVIDER = '_______________________________________';

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

    const [activeSnap, stoppedSnap] = await Promise.all([
      db.collection(COLLECTIONS.PRODUCTS).where('subscribers', 'array-contains', uid).limit(30).get(),
      db.collection(COLLECTIONS.PRODUCTS).where('stoppedBy', 'array-contains', uid).limit(30).get(),
    ]);

    const seen = new Set();
    const items = [];
    activeSnap.docs.forEach((d) => { seen.add(d.id); items.push({ doc: d, data: d.data(), active: true }); });
    stoppedSnap.docs.forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); items.push({ doc: d, data: d.data(), active: false }); } });

    if (!items.length) {
      await ctx.reply('You are not tracking anything yet. Send an Amazon or Flipkart link to start.');
      return;
    }

    // Fill in missing product names: derive from the link first (instant), then
    // try the page if there is budget. Bounded so the list stays quick.
    let backfilled = 0;
    for (const it of items) {
      if (it.data.title) continue;
      const src = it.data.resolvedUrl || it.data.cleanUrl || it.data.affiliateUrl || '';

      let got = titleFromUrl(src);
      if (!got && src && backfilled < 3) {
        try {
          const info = await withTimeout(fetchProduct(src, it.data.marketplace), 6000);
          if (info && info.ok && info.title) {
            got = info.title;
            backfilled++;
          }
        } catch (err) {
          /* non-fatal — fall back to the id */
        }
      }

      if (got) {
        it.data.title = got;
        if (it.doc.ref) {
          try {
            await it.doc.ref.set({ title: got }, { merge: true });
          } catch (e) {
            /* non-fatal */
          }
        }
      }
    }

    const lines = [];
    let index = 0;
    for (const it of items) {
      index++;
      const d = it.data;
      const token = (d.stopToken || stopTokenFor(it.doc.id)).toUpperCase();
      const title =
        d.title ||
        titleFromUrl(d.resolvedUrl || d.cleanUrl || d.affiliateUrl || '') ||
        d.productId ||
        it.doc.id;
      const market = d.marketplace === 'amazon' ? 'Amazon' : d.marketplace === 'flipkart' ? 'Flipkart' : d.marketplace;
      const buy = d.affiliateUrl || d.cleanUrl;
      const buyLink = buy ? (await shortenUrl(buy)) || buy : null;
      const base = webAppBase();
      const hist = base ? base + '/?id=' + encodeURIComponent(it.doc.id) : null;

      lines.push(index + '. <b>' + escapeHtml(title) + '</b>');
      lines.push('');
      if (buyLink) lines.push('<a href="' + escapeHtml(buyLink) + '">Click here to view in ' + escapeHtml(market) + '!</a>');
      lines.push('');
      if (hist) lines.push('<a href="' + escapeHtml(hist) + '">[ View Price History! ]</a>');
      lines.push('');
      if (it.active) {
        lines.push('Click /stop_' + token + ' to stop this product.');
      } else {
        lines.push('🔴 You stopped tracking this. Send the link again to resume.');
      }
      lines.push(LIST_DIVIDER);
    }
    lines.push('');
    lines.push('🦋 <b>Total Products: ' + items.length + '</b>');

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
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
 * Optional welcome image. Only used when BOT_LOGO_URL is explicitly set to a
 * public image URL — we no longer guess at /logo.jpg, because when Telegram
 * cannot fetch the image it costs a slow failed request on every /start.
 */
function botLogoUrl() {
  return process.env.BOT_LOGO_URL || null;
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
  const base = webAppBase();
  const historyUrl = base ? base + '/?id=' + encodeURIComponent(docId) : null;

  const row1 = [];
  if (buyUrl) row1.push(Markup.button.url('✅ Buy Now', buyUrl));
  row1.push(Markup.button.callback('🔴 Stop Tracking', 'untrack:' + docId));

  const row2 = [];
  if (historyUrl) row2.push(Markup.button.url('📊 Price History', historyUrl));
  row2.push(Markup.button.url("🛍️ Today's Deals", CHANNEL_URL));

  return Markup.inlineKeyboard([row1, row2]);
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
  const link = result.cleanUrl || result.affiliateUrl;
  const open = openUrl || result.affiliateUrl || link;
  const lines = [
    '<a href="' + escapeHtml(link) + '">' + escapeHtml(link) + '</a>',
    '',
    '<b>The Product has Started Tracking!</b>',
    '',
    '☀️ <b>' + escapeHtml(info.title || result.productId) + '</b>',
  ];
  if (info.price != null) {
    const sym = (info.currency || 'INR') === 'INR' ? '₹' : '';
    lines.push('', 'Current Price: <b>' + sym + Number(info.price).toLocaleString('en-IN') + '</b>');
  }
  lines.push('', '<a href="' + escapeHtml(open) + '">Click here to open in ' + market + '!</a>');
  lines.push('', '⏱️ Updated at [ ' + formatStamp(new Date()) + ' ]');
  if (!result.hasAffiliateTag && !tagWarningHidden()) {
    lines.push('', '⚠️ No affiliate tag configured yet — the link is clean but not monetised.');
  }
  return lines.join('\n');
}

const CONVERT_ERRORS = {
  unsupported_marketplace: 'That link is not from Amazon or Flipkart.',
  asin_not_found: 'I could not find the Amazon product ID in that link.',
  flipkart_id_not_found: 'I could not find the Flipkart product ID in that link.',
  shortlink_unresolved: 'I could not open that short link (it may have expired).',
  invalid_url: 'That does not look like a valid link.',
  empty_input: 'Please send a link.',
};

const DB_DOWN = '⚠️ My database is not configured yet, so I cannot track that link. Please try again later.';

function registerHandlers(bot) {
  bot.start(async (ctx) => {
    const caption =
      '🎉 <b>Welcome to Ai Price Alert Bot!</b>\n\n' +
      'Send me an Amazon or Flipkart product link and I will:\n' +
      '• convert it into a clean affiliate link\n' +
      '• start tracking its price for 30 days\n' +
      '• alert you when the price drops\n\n' +
      '<b>Commands</b>\n' +
      '/mytracks – your tracked products\n' +
      '/untrack &lt;id&gt; – stop tracking one\n' +
      '/help – how it works';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url("🛍️ Today's Deals", CHANNEL_URL)],
      [Markup.button.callback('📋 My List', 'mylist')],
    ]);

    // Reply FIRST so the welcome is instant; the DB write happens after it.
    try {
      const logoUrl = botLogoUrl(); // opt-in via BOT_LOGO_URL
      if (logoUrl && typeof ctx.replyWithPhoto === 'function') {
        try {
          await withTimeout(ctx.replyWithPhoto(logoUrl, { caption, parse_mode: 'HTML', ...keyboard }), 6000);
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
          '1. Paste an Amazon or Flipkart link (short links like amzn.to work too).\n' +
          '2. I convert it into your affiliate link and start tracking the price.\n' +
          '3. Every few hours a cron job checks the price and alerts you on a drop.\n' +
          '4. Tap “📈 Price Track” to see the 30-day graph.\n\n' +
          '/mytracks – your tracked products\n' +
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
      const snap = await db
        .collection(COLLECTIONS.PRODUCTS)
        .where('stopToken', '==', token)
        .limit(1)
        .get();
      if (snap.empty) {
        await ctx.reply('I could not find that product. Send /list to see your tracking list.');
        return;
      }
      const doc = snap.docs[0];
      const d = doc.data();
      await untrackProduct(doc.id, ctx.from);
      await ctx.reply('🛑 Stopped tracking <b>' + escapeHtml(d.title || d.productId || doc.id) + '</b>.', {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('stop handler failed', err);
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
          'Send me a product link. I convert Amazon and Flipkart links into ' +
            'affiliate links and track their prices.\n\nExample: https://www.amazon.in/dp/B08N5WRWNW'
        );
        return;
      }

      await ctx.reply('🔎 Converting your link…');
      const result = await convertAffiliateLink(url);

      if (!result.ok) {
        await ctx.reply('⚠️ ' + (CONVERT_ERRORS[result.reason] || 'Could not convert that link.'));
        return;
      }

      // Other platforms: hand the link back unchanged, no affiliate tag, no tracking.
      if (result.marketplace === 'other') {
        await ctx.reply(
          '🔗 Here is your link, unchanged — no affiliate tag added.\n\n' +
            result.affiliateUrl +
            '\n\nI can track prices for Amazon and Flipkart links only.'
        );
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
      try {
        const scraped = await withTimeout(
          fetchProduct(result.cleanUrl || result.affiliateUrl, result.marketplace),
          8000
        );
        if (scraped && scraped.ok) {
          info = {
            title: scraped.title || info.title,
            price: scraped.price,
            currency: scraped.currency || 'INR',
            imageUrl: scraped.imageUrl || null,
          };
        }
      } catch (err) {
        console.warn('track-time scrape failed:', err.message);
      }

      const docId = await trackProduct(result, ctx.from, info);

      // Shorten the outgoing link with Bitly when a token is configured.
      const shortLink = await shortenUrl(result.affiliateUrl || result.cleanUrl);
      const replyText = formatTrackingConfirmation(result, info, shortLink || null);
      const extra = { parse_mode: 'HTML', ...buildTrackKeyboard(docId, result) };
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
  escapeHtml,
  productDocId,
  extractUrl,
  titleFromUrl,
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
