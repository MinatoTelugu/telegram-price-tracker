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
const { db, admin, COLLECTIONS } = require('../lib/firebase');
const { fetchProduct } = require('../lib/scraper');

const BATCH_SIZE = parseInt(process.env.CRON_BATCH_SIZE || '20', 10);
const DROP_THRESHOLD = parseFloat(process.env.PRICE_DROP_THRESHOLD_PERCENT || '1');
const HISTORY_DAYS = 30;
const SCAN_LIMIT = 500; // hard cap on docs read per run (avoids an index)

const FieldValue = admin.firestore.FieldValue;

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
  if (!data.title && result.title) update.title = result.title;
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
      const message = formatAlert({ ...data, title: data.title || result.title }, oldPrice, newPrice, dropPct);
      for (const chatId of subscribers) {
        const sent = await sendTelegramMessage(chatId, message);
        if (sent) alerted++;
      }
    }
  }

  return { id: doc.id, status: 'checked', price: newPrice, oldPrice, alerted };
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

    const summary = {
      ok: true,
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
