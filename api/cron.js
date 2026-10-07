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
const HISTORY_DAYS = 30;
const SCAN_LIMIT = 500; // hard cap on docs read per run (avoids an index)

const FieldValue = (admin && admin.firestore && admin.firestore.FieldValue) || null;

async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) return false;
  try {
    await axios.post(
      'https://api.telegram.org/bot' + token + '/sendMessage',
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    console.error('sendMessage failed for', chatId, err.message);
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

function formatAlert(product, oldPrice, newPrice, dropPct) {
  const name = product.title ? product.title.slice(0, 80) : product.productId;
  const link = product.affiliateUrl || product.cleanUrl;
  return (
    '📉 <b>Price drop!</b>\n\n' +
    name + '\n\n' +
    '₹' + oldPrice + ' → <b>₹' + newPrice + '</b>  (−' + dropPct.toFixed(1) + '%)\n\n' +
    '🔗 ' + link
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

async function processProduct(doc) {
  const data = doc.data();
  // fetchUrl caches the resolved canonical URL (set on a previous run).
  const url = data.fetchUrl || data.cleanUrl || data.affiliateUrl;
  const now = new Date();

  const result = await fetchProduct(url, data.marketplace);

  if (!result.ok) {
    // Still record that we tried, so rotation moves on to other products.
    await doc.ref.set(
      { lastCheckedAt: FieldValue.serverTimestamp(), lastCheckError: result.reason },
      { merge: true }
    );
    return { id: doc.id, status: 'skipped', reason: result.reason, httpStatus: result.status || null, snippet: result.snippet || null };
  }

  const oldPrice = typeof data.lastPrice === 'number' ? data.lastPrice : null;
  const newPrice = result.price;

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
    }
    if (title && !titleLooksUnusable(title, data.productId)) update.title = title;
  }
  if (!data.imageUrl && result.imageUrl) update.imageUrl = result.imageUrl;
  // Cache the canonical URL we resolved, so future runs skip the resolution.
  if (result.resolvedUrl && result.resolvedUrl !== data.fetchUrl) update.fetchUrl = result.resolvedUrl;
  await doc.ref.set(update, { merge: true });

  await pruneOldHistory(doc.ref);

  // Price-drop alert.
  let alerted = 0;
  if (oldPrice != null && newPrice < oldPrice) {
    const dropPct = ((oldPrice - newPrice) / oldPrice) * 100;
    if (dropPct >= DROP_THRESHOLD) {
      const subscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
      const message = formatAlert({ ...data, title: title || data.title || result.title }, oldPrice, newPrice, dropPct);
      for (const chatId of subscribers) {
        const sent = await sendTelegramMessage(chatId, message);
        if (sent) alerted++;
      }
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
    // Single-field filter -> no composite index required.
    const snap = await db
      .collection(COLLECTIONS.PRODUCTS)
      .where('active', '==', true)
      .limit(SCAN_LIMIT)
      .get();

    // Rotate fairly: oldest-checked (and never-checked) products first.
    const docs = snap.docs.slice().sort((a, b) => {
      const av = a.data().lastCheckedAt;
      const bv = b.data().lastCheckedAt;
      const at = av && av.toMillis ? av.toMillis() : 0;
      const bt = bv && bv.toMillis ? bv.toMillis() : 0;
      return at - bt;
    });

    const batch = docs.slice(0, BATCH_SIZE);
    const results = [];
    for (const doc of batch) {
      try {
        results.push(await processProduct(doc));
      } catch (err) {
        console.error('product failed', doc.id, err.message);
        results.push({ id: doc.id, status: 'error', reason: err.message });
      }
    }

    // Keep the webhook pointed at this deployment (self-heal if it was mangled).
    const webhook = await ensureWebhook(req);
    const commands = await registerCommands();

    const summary = {
      ok: true,
      webhook,
      commands,
      scanned: docs.length,
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
