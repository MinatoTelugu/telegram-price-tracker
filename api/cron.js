/**
 * api/cron.js
 * ---------------------------------------------------------------------------
 * Scheduled price checker + price-drop notifier.
 *
 * Triggered by Vercel Cron (see vercel.json). Vercel calls this URL with a GET
 * and an "Authorization: Bearer <CRON_SECRET>" header, which we verify so the
 * endpoint cannot be abused by randoms.
 *
 * Each run:
 *   1. load a batch of active products (oldest-checked first)
 *   2. fetch each product's current price
 *   3. append a price-history point + update the product doc
 *   4. if the price dropped past the threshold, message every subscriber
 *   5. prune history older than 30 days
 *
 * Env vars:
 *   CRON_SECRET                    -> matches Vercel's CRON_SECRET (recommended)
 *   BOT_TOKEN                      -> to send Telegram alerts
 *   CRON_BATCH_SIZE                -> products per run (default 20)
 *   PRICE_DROP_THRESHOLD_PERCENT   -> alert threshold, e.g. 1 = 1% (default 1)
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const { fetchProduct, resolveProductName } = require('../lib/scraper');
const { fetchMetadata } = require('../lib/metadata');

// Load Firebase defensively: missing credentials must not crash the process
// (on Koyeb a throw here would kill the whole app at startup).
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
const COLLECTIONS = (fb && fb.COLLECTIONS) || { PRODUCTS: 'products', PRICE_HISTORY: 'price_history' };

const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || '20', 10);
const DROP_THRESHOLD = parseFloat(process.env.PRICE_DROP_THRESHOLD_PERCENT || '1');
const INCREASE_THRESHOLD = parseFloat(process.env.PRICE_INCREASE_THRESHOLD_PERCENT || '5');
const HISTORY_DAYS = 30;
const SCAN_LIMIT = 500; // hard cap on docs read per run (avoids an index)

const FieldValue = (admin && admin.firestore && admin.firestore.FieldValue) || null;

const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/Ai_PriceAlert';
// The web chart page. Must have a default, or the button silently vanishes.
const WEB_BASE = (process.env.WEB_APP_URL || 'https://aipricealertbot.koyeb.app').replace(/\/+$/, '');

/**
 * The four actions that must ride along with EVERY alert, in the same 2x2 grid
 * the tracking card uses:
 *   [ ✅ Buy Now        ]  [ 🔴 Stop Tracking ]
 *   [ 📊 Price History  ]  [ 🛍️ Today's Deals ]
 *
 * Built from the product record, so it works for a price drop, a price rise and
 * a back-in-stock alert alike — and whether or not the page had an image.
 */
function alertKeyboard(docId, product) {
  const buy = (product && (product.affiliateUrl || product.cleanUrl)) || null;
  const row1 = [];
  if (buy) row1.push({ text: '✅ Buy Now', url: buy });
  row1.push({ text: '🔴 Stop Tracking', callback_data: 'untrack:' + docId });
  const row2 = [
    { text: '📊 Price History', url: WEB_BASE + '/?id=' + encodeURIComponent(docId) },
    { text: "🛍️ Today's Deals", url: CHANNEL_URL },
  ];
  return { inline_keyboard: [row1, row2] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one alert. Retries transient failures so a single blip — a network
 * hiccup, or Telegram's 429 rate limit when many subscribers are alerted at
 * once — never costs a user their notification. On 429 we honour the
 * `retry_after` Telegram asks for.
 */
async function sendTelegramMessage(chatId, text, replyMarkup, attempt) {
  const token = process.env.BOT_TOKEN;
  if (!token) return false;
  const tries = attempt || 1;

  try {
    await axios.post(
      'https://api.telegram.org/bot' + token + '/sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    const status = err.response && err.response.status;
    const params = err.response && err.response.data && err.response.data.parameters;
    const retryAfter = params && params.retry_after;
    // 429 and 5xx are worth another go; a 400/403 (blocked, bad chat) is not.
    const transient = !status || status === 429 || status >= 500;

    if (transient && tries < 3) {
      const wait = retryAfter ? Number(retryAfter) * 1000 : tries === 1 ? 600 : 1600;
      console.warn('alert send retry ' + tries + ' for ' + chatId + ' in ' + wait + 'ms (' + err.message + ')');
      await sleep(wait);
      return sendTelegramMessage(chatId, text, replyMarkup, tries + 1);
    }
    console.error('ALERT LOST for ' + chatId + ' after ' + tries + ' attempt(s): ' + err.message);
    return false;
  }
}

/** True when a stored title is missing, a placeholder, or a raw product id. */
function titleLooksUnusable(title, productId) {
  const s = String(title || '').trim();
  if (!s) return true;
  if (productId && s.toLowerCase() === String(productId).toLowerCase()) return true;
  if (s.length < 4) return true;
  // id-like: no spaces, letters and digits only (e.g. ucc25298ca0, B0DFHCZMWY)
  if (!/\s/.test(s) && /^[A-Za-z0-9]{10,}$/.test(s)) return true;
  return false;
}

function formatAlert(product, oldPrice, newPrice, pct, kind) {
  const name = product.title ? String(product.title).slice(0, 80) : product.productId;
  const link = product.affiliateUrl || product.cleanUrl || '';
  const tail = link ? '\n\n🔗 ' + link : '';

  if (kind === 'restock') {
    return (
      '📦 <b>The Product is currently In Stock.</b>\n\n' +
      name +
      '\n\nPreviously Out of Stock' +
      (newPrice != null ? '\n\nCurrent Price: ₹' + newPrice : '') +
      tail
    );
  }
  if (kind === 'rise') {
    return (
      '📈 <b>Price increased</b>\n\n' +
      name +
      '\n\n₹' +
      oldPrice +
      ' → <b>₹' +
      newPrice +
      '</b>  (+' +
      Math.abs(pct).toFixed(1) +
      '%)' +
      tail
    );
  }
  return (
    '📉 <b>Price drop!</b>\n\n' +
    name +
    '\n\n₹' +
    oldPrice +
    ' → <b>₹' +
    newPrice +
    '</b>  (−' +
    Math.abs(pct).toFixed(1) +
    '%)' +
    tail
  );
}

async function pruneOldHistory(docRef) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  try {
    const snap = await docRef
      .collection(COLLECTIONS.PRICE_HISTORY)
      .where('checkedAt', '<', cutoff)
      .limit(200)
      .get();
    if (snap.empty) return 0;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return snap.size;
  } catch (err) {
    console.error('prune failed', err.message);
    return 0;
  }
}

/**
 * Hosts that are pure redirectors for Flipkart app shares. Fetching these
 * directly from a datacenter drops the connection, so they must be EXPANDED to
 * the canonical product URL once and then cached.
 */
const FLIPKART_SHORT_HOSTS = /(^|\.)(dl\.flipkart\.com|fkrt\.cc|fkrt\.it)$/i;

function isFlipkartShortLink(url) {
  try {
    const u = new URL(url);
    if (FLIPKART_SHORT_HOSTS.test(u.hostname)) return true;
    if (!u.hostname.endsWith('flipkart.com')) return false;
    // `/product/p/itme?pid=…` is the Flipkart APP share form — not a product
    // page. Fetching it returns HTTP 500, so it must be expanded first.
    return /^\/s\//i.test(u.pathname) || /^\/product\/p\/itm/i.test(u.pathname);
  } catch (err) {
    return false;
  }
}

/**
 * Expand a Flipkart app share link into a canonical product URL.
 *
 * Two routes, in order:
 *   1. follow the redirect ourselves, reading Location headers (works for
 *      fkrt.cc / fkrt.it, which are reachable);
 *   2. convert the link through Cuelinks, then follow THAT — the converter's
 *      redirector is not on flipkart.com, so it answers even when the store
 *      itself refuses us. Reading its Location header gives the product URL
 *      without ever fetching the store page.
 *
 * Returns null if it cannot be expanded.
 */
async function expandFlipkartShortLink(rawUrl) {
  const { resolveShortUrl } = require('../lib/affiliate');

  try {
    const direct = await resolveShortUrl(rawUrl);
    if (direct && !isFlipkartShortLink(direct)) return direct;
  } catch (err) {
    /* fall through to the converter route */
  }

  try {
    const { convertAffiliateLink } = require('../lib/affiliate');
    const conv = await convertAffiliateLink(rawUrl);
    if (conv && conv.ok && conv.affiliateUrl && conv.affiliateUrl !== rawUrl) {
      const viaConv = await resolveShortUrl(conv.affiliateUrl);
      if (viaConv && !isFlipkartShortLink(viaConv)) return viaConv;
    }
  } catch (err) {
    /* give up */
  }

  return null;
}

async function processProduct(doc) {
  const data = doc.data();
  // Pick the best URL to fetch. fetchUrl caches a canonical URL resolved on an
  // earlier run. Failing that, a dl.flipkart.com / fktr.it SHARE link is a dead
  // end from this host (it drops the connection), so prefer the converter's
  // redirector — following it lands on the real product page, which is what we
  // actually want to read.
  let url = data.fetchUrl || data.cleanUrl || data.affiliateUrl;

  // A Flipkart app share link is a dead end from this host. Expand it to the
  // canonical product URL once, and cache that as fetchUrl so every later run
  // goes straight to the product page.
  if (isFlipkartShortLink(url)) {
    const expanded = await expandFlipkartShortLink(url);
    if (expanded) {
      url = expanded;
      await doc.ref.set({ fetchUrl: expanded }, { merge: true });
      console.log('cron: expanded short link for ' + doc.id + ' -> ' + expanded.slice(0, 90));
    }
  }
  const now = new Date();

  // Keep the stored affiliate link current. A product tracked before the
  // Cuelinks integration (or one whose conversion failed at the time) has no
  // affiliateUrl — so we convert and persist it here, once, rather than leaving
  // the record without a working link.
  if (!data.affiliateUrl && data.cleanUrl) {
    try {
      const { convertAffiliateLink } = require('../lib/affiliate');
      const conv = await convertAffiliateLink(data.cleanUrl);
      if (conv && conv.ok && conv.affiliateUrl) {
        await doc.ref.set(
          { affiliateUrl: conv.affiliateUrl, affiliateVia: conv.via || null },
          { merge: true }
        );
        data.affiliateUrl = conv.affiliateUrl;
        console.log('cron: stored a converted link for ' + doc.id + ' via ' + (conv.via || 'affiliate'));
      }
    } catch (err) {
      console.warn('cron: affiliate conversion failed for ' + doc.id + ' — ' + err.message);
    }
  }

  const result = await fetchProduct(url, data.marketplace);

  if (!result.ok) {
    // Still record that we tried, so rotation moves on to other products.
    const skipUpdate = {
      lastCheckedAt: FieldValue.serverTimestamp(),
      lastCheckError: result.reason,
    };

    // CRITICAL: persist a KNOWN stock state even when there is no price.
    // An out-of-stock product has no price, so it lands here as
    // price_not_found — and if we don't record inStock=false now, the later
    // "back in stock" transition can never be detected and that alert can
    // never fire. This is why restock alerts were silent.
    if (typeof result.inStock === 'boolean') skipUpdate.inStock = result.inStock;
    if (result.title) skipUpdate.title = result.title;
    if (result.resolvedUrl) skipUpdate.fetchUrl = result.resolvedUrl;
    if (result.imageUrl) skipUpdate.imageUrl = result.imageUrl;

    await doc.ref.set(skipUpdate, { merge: true });
    console.warn(
      'cron: ' + doc.id + ' skipped (' + result.reason + ')' +
        (typeof result.inStock === 'boolean' ? ' inStock=' + result.inStock : '') +
        ' fetching ' + String(url).slice(0, 90)
    );
    return { id: doc.id, status: 'skipped', reason: result.reason, url: String(url).slice(0, 120), inStock: typeof result.inStock === 'boolean' ? result.inStock : null, httpStatus: result.status || null, snippet: result.snippet || null };
  }

  const oldPrice = typeof data.lastPrice === 'number' ? data.lastPrice : null;
  const newPrice = result.price;
  // Capture the PREVIOUS stock state BEFORE the update below. Reading it after
  // the write is fragile — the snapshot may already reflect the new value.
  const wasOutOfStock = data.inStock === false;

  // Append the history point.
  await doc.ref.collection(COLLECTIONS.PRICE_HISTORY).add({
    price: newPrice,
    currency: result.currency || 'INR',
    checkedAt: FieldValue.serverTimestamp(),
  });

  const update = {
    lastPrice: newPrice,
    currency: result.currency || 'INR',
    lastCheckedAt: FieldValue.serverTimestamp(),
    lastCheckError: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // Name: keep a real stored title, but replace an id-like/placeholder value
  // with the real product name — resolving it if the page scrape gave none.
  let title = data.title;
  if (titleLooksUnusable(title, data.productId)) {
    if (!titleLooksUnusable(result.title, data.productId)) {
      title = result.title;
    } else {
      try {
        const r = await resolveProductName({
          marketplace: data.marketplace,
          productId: data.productId,
          cleanUrl: data.cleanUrl,
          affiliateUrl: data.affiliateUrl,
          resolvedUrl: data.resolvedUrl || data.fetchUrl,
        });
        if (r && r.title) title = r.title;
      } catch (err) {
        console.warn('cron name resolution failed for', doc.id, err.message);
      }
      // Still unusable (the store refuses this host)? Ask the metadata service.
      if (titleLooksUnusable(title, data.productId)) {
        try {
          const meta = await fetchMetadata(data.cleanUrl || data.affiliateUrl);
          if (meta && meta.title && !titleLooksUnusable(meta.title, data.productId)) {
            title = meta.title;
            console.log('cron: recovered the name via metadata for ' + doc.id);
          }
        } catch (err) {
          console.warn('cron metadata fallback failed for', doc.id, err.message);
        }
      }
    }
    if (title && !titleLooksUnusable(title, data.productId)) update.title = title;
  }
  if (!data.imageUrl && result.imageUrl) update.imageUrl = result.imageUrl;
  // Remember stock state so we can alert on the out-of-stock -> in-stock change.
  if (typeof result.inStock === 'boolean') update.inStock = result.inStock;
  // MRP / original price, when the page actually stated one (never invented).
  if (result.mrp != null && result.mrp > newPrice) update.mrp = result.mrp;
  // Cache the canonical URL we resolved, so future runs skip the resolution.
  if (result.resolvedUrl && result.resolvedUrl !== data.fetchUrl) update.fetchUrl = result.resolvedUrl;
  await doc.ref.set(update, { merge: true });

  await pruneOldHistory(doc.ref);

  // Alerts: price drops, price increases, and back-in-stock.
  let alerted = 0;
  const subscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
  const alertProduct = { ...data, title: title || data.title || result.title };

  const pct =
    oldPrice != null && newPrice != null && oldPrice > 0 && newPrice !== oldPrice
      ? ((newPrice - oldPrice) / oldPrice) * 100
      : null;

  let message = null;
  if (pct != null && pct <= -DROP_THRESHOLD) {
    message = formatAlert(alertProduct, oldPrice, newPrice, pct, 'drop');
  } else if (pct != null && pct >= INCREASE_THRESHOLD) {
    message = formatAlert(alertProduct, oldPrice, newPrice, pct, 'rise');
  }

  // Only on the TRANSITION, so we don't repeat it every run.
  if (wasOutOfStock && result.inStock === true) {
    message = formatAlert(alertProduct, oldPrice, newPrice, 0, 'restock');
  }

  if (message) {
    let first = true;
    for (const chatId of subscribers) {
      // A small gap between recipients keeps us clear of Telegram's per-second
      // limit when a popular product is tracked by many users.
      if (!first) await sleep(60);
      first = false;
      const sent = await sendTelegramMessage(chatId, message, alertKeyboard(doc.id, data));
      if (sent) alerted++;
    }
    if (alerted < subscribers.length) {
      console.warn(
        'cron: ' + doc.id + ' — ' + (subscribers.length - alerted) + ' of ' +
          subscribers.length + ' alert(s) could not be delivered'
      );
    }
  }

  return { id: doc.id, status: 'checked', price: newPrice, oldPrice, alerted };
}

/**
 * Keep the webhook pointed at THIS deployment's own /api/telegram URL.
 * If it has been mangled (stray query string / line break) this repairs it on
 * the next scheduled run, so a bad registration can't silently kill the bot.
 */
async function ensureWebhook(req) {
  // When running under a long-polling host (Koyeb), nothing may set a webhook.
  if (process.env.DISABLE_WEBHOOK_MANAGEMENT === '1') {
    return { ok: true, skipped: 'webhook management disabled' };
  }
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, reason: 'no_token' };

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  if (!host) return { ok: false, reason: 'no_host' };
  const expected = 'https://' + host + '/api/telegram';

  try {
    const info = await axios.get(
      'https://api.telegram.org/bot' + token + '/getWebhookInfo',
      { timeout: 8000 }
    );
    const current = info.data && info.data.result && info.data.result.url;
    if (current === expected) return { ok: true, unchanged: true, url: expected };

    const payload = { url: expected, drop_pending_updates: false };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    await axios.post('https://api.telegram.org/bot' + token + '/setWebhook', payload, { timeout: 8000 });
    return { ok: true, repaired: true, was: current || null, url: expected };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Register the bot's command menu with Telegram (idempotent). */
async function registerCommands() {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, reason: 'no_token' };
  try {
    await axios.post(
      'https://api.telegram.org/bot' + token + '/setMyCommands',
      {
        commands: [
          { command: 'start', description: 'Start the bot' },
          { command: 'list', description: 'Your tracked products' },
          { command: 'mytracks', description: 'Your tracked products' },
          { command: 'untrack', description: 'Stop tracking a product' },
          { command: 'help', description: 'How it works' },
        ],
      },
      { timeout: 8000 }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = async (req, res) => {
  // Auth: Vercel Cron sends "Authorization: Bearer $CRON_SECRET".
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const queryKey = (req.query && (req.query.key || req.query.secret)) || '';
    if (provided !== secret && queryKey !== secret) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
  }

  if (!db) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Firebase is not configured', detail: fbError }));
    return;
  }

  try {
    // Read a page of products WITHOUT a where() clause, then filter in code.
    //
    // Filtering on active == true in the query looks right but silently returns
    // NOTHING if the field is missing or not exactly boolean true on the stored
    // docs — which is exactly how this loop went quiet while /list (which
    // queries by subscribers, not active) still showed the products. Treating a
    // missing `active` as "active" means a product is only skipped when it has
    // been explicitly stopped.
    const snap = await db.collection(COLLECTIONS.PRODUCTS).limit(SCAN_LIMIT).get();
    const totalProducts = snap.docs.length;
    const activeDocs = snap.docs.filter((d) => {
      const v = d.data();
      return v && v.active !== false;
    });

    // Rotate fairly: oldest-checked (and never-checked) products first.
    const docs = activeDocs.slice().sort((a, b) => {
      const av = a.data().lastCheckedAt;
      const bv = b.data().lastCheckedAt;
      const at = av && av.toMillis ? av.toMillis() : 0;
      const bt = bv && bv.toMillis ? bv.toMillis() : 0;
      return at - bt;
    });

    // ?limit=N caps this run — /check uses it so the diagnostic answers in
    // seconds instead of working through every product with retries.
    const requested = req && req.query && req.query.limit ? parseInt(req.query.limit, 10) : null;
    const cap = Number.isFinite(requested) && requested > 0 ? Math.min(requested, BATCH_SIZE) : BATCH_SIZE;
    const batch = docs.slice(0, cap);
    console.log(
      'cron: price check start — ' + docs.length + ' active of ' + totalProducts +
        ' product(s), processing ' + batch.length
    );

    const results = [];
    let alertsTotal = 0;
    for (const doc of batch) {
      try {
        const r = await processProduct(doc);
        results.push(r);
        if (r && r.alerts) alertsTotal += r.alerts;
        console.log(
          'cron: ' + doc.id + ' -> ' + (r && r.status) +
            (r && r.reason ? ' (' + r.reason + ')' : '') +
            (r && r.oldPrice != null && r.newPrice != null ? ' price ' + r.oldPrice + '->' + r.newPrice : '') +
            (r && r.alerts ? ' alerts=' + r.alerts : '')
        );
      } catch (err) {
        console.error('cron: product FAILED ' + doc.id + ' — ' + err.message);
        results.push({ id: doc.id, status: 'error', reason: err.message });
      }
    }
    console.log('cron: done — ' + results.length + ' checked, ' + alertsTotal + ' alert(s) sent');

    // Keep the webhook pointed at this deployment (self-heal if it was mangled).
    const webhook = await ensureWebhook(req);
    const commands = await registerCommands();

    const summary = {
      ok: true,
      webhook,
      commands,
      scanned: docs.length,
      totalProducts,
      processed: batch.length,
      checked: results.filter((r) => r.status === 'checked').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      alertsSent: results.reduce((n, r) => n + (r.alerted || 0), 0),
      results,
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(summary));
  } catch (err) {
    console.error('cron failed', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};

// Exposed for tests.
module.exports.isFlipkartShortLink = isFlipkartShortLink;

// Exposed for tests.
module.exports.alertKeyboard = alertKeyboard;
