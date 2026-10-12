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
const { isUsableTitle } = require('../lib/titles');
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
// Any move at least this large, from a source we cannot verify against the store,
// is checked against an INDEPENDENT source before it is believed.
//
// It was 10%, and that was too high: the reported product flipped between ₹21,999
// and ₹19,999 — 9.1% — which slipped under the gate, so the wrong value was
// recorded and shown. A 4.5% flip to ₹22,999 did too. The false moves are small
// percentages, so the gate has to be small as well. A confirmation costs one
// extra lookup, and only when the price has actually moved.
// An identical alert is suppressed for this long. Long enough to swallow a
// double cron run, short enough that a genuine repeat a few hours later still
// reaches the user.
const ALERT_COOLDOWN_MINUTES = parseInt(process.env.ALERT_COOLDOWN_MINUTES || '180', 10);
// How often the expensive per-product passes may run. These read whole history
// collections, so they are the difference between a comfortable quota and none.
const SELF_CLEAN_MIN_HOURS = parseInt(process.env.SELF_CLEAN_MIN_HOURS || '12', 10);
const PRUNE_MIN_HOURS = parseInt(process.env.PRUNE_MIN_HOURS || '24', 10);
const CONFIRM_THRESHOLD = parseFloat(process.env.PRICE_CONFIRM_THRESHOLD_PERCENT || '3');
const HISTORY_DAYS = 30;
// The history sanity pass runs by itself, once a day, so a polluted history is
// repaired without anyone having to remember a command. Set CLEAN_HOUR=-1 to
// switch it off and drive it by hand instead.
const CLEAN_HOUR = parseInt(process.env.CLEAN_HOUR || '3', 10);
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
 * What makes two alerts "the same alert".
 *
 * The header and the price, with the markup and the emoji stripped: the emoji is
 * the stock state, and a restock alert flipping from 🟢 to 🔴 is a different
 * event, not a repeat. The name is deliberately NOT part of the identity — a
 * title that gains a word between runs must not defeat the cooldown.
 */
function alertIdentity(text) {
  const t = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 200);
}

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
/**
 * Whether a stored title needs replacing.
 *
 * This used to be a weaker rule than the bot's, and the two drifted — which is
 * how an A+ marketing mashup could be written into a product document. It now
 * defers to the single shared definition in lib/titles.js.
 */
function titleLooksUnusable(title, productId) {
  return !isUsableTitle(title, productId);
}

function formatAlert(product, oldPrice, newPrice, pct, kind, inStockNow) {
  const name = product.title ? String(product.title).slice(0, 80) : product.productId;

  // ── THE LAYOUT ────────────────────────────────────────────────────────────
  //   🟢 BACK IN STOCK ALERT
  //   ───────────────────
  //
  //   realme P4 5G (Steel Grey, 128 GB) (6 GB RAM)
  //
  //   💰 Current Price: ₹25999
  //
  // The title and the price each sit in their own BLOCKQUOTE. That is what gives
  // the message its air: Telegram draws a rule down the side and indents the
  // text, so the name reads as a quotation rather than as one more line of
  // running text. The emoji is the stock state — 🟢 in stock, 🔴 out of stock —
  // and the header says what actually happened.
  //
  // No raw URL in the body. Every alert is sent with alertKeyboard(), whose
  // "Buy Now" button carries the same url, and printing it again underneath only
  // made the message read as clutter. The button IS the link.
  const HEAD = {
    drop: 'PRICE DROP ALERT',
    rise: 'PRICE INCREASE ALERT',
    restock: 'BACK IN STOCK ALERT',
    outofstock: 'OUT OF STOCK ALERT',
  };
  // 🟢 when the product is in stock, 🔴 when it is not. The header and the emoji
  // always agree, because a red dot beside "BACK IN STOCK" is worse than no
  // emoji at all.
  const inStock = inStockNow !== false;
  const dot = inStock ? '🟢' : '🔴';

  const line = (text) => '<blockquote>' + text + '</blockquote>';

  const parts = [dot + ' <b>' + (HEAD[kind] || HEAD.drop) + '</b>', '───────────────────', '', line(name), ''];

  if (kind === 'restock') {
    if (newPrice != null) parts.push(line('💰 Current Price: ₹' + newPrice));
  } else if (kind === 'outofstock') {
    if (oldPrice != null) parts.push(line('💸 Last Known Price: ₹' + oldPrice));
  } else if (kind === 'rise') {
    if (newPrice != null) parts.push(line('💰 Current Price: ₹' + newPrice));
    if (oldPrice != null) parts.push(line('❌ Previous Price: ₹' + oldPrice));
    if (pct != null) parts.push(line('▲ ' + Math.abs(pct).toFixed(1) + '%'));
  } else {
    if (newPrice != null) parts.push(line('💰 Current Price: ₹' + newPrice));
    if (oldPrice != null) parts.push(line('❌ Previous Price: ₹' + oldPrice));
    if (pct != null) parts.push(line('▼ ' + Math.abs(pct).toFixed(1) + '%'));
  }

  return parts.join('\n');
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
  const newPriceRaw = result.price;
  // A LARGE move is confirmed before it is believed or alerted on.
  //
  // The reported product flipped between ₹21,999 and ₹22,999 from one check to
  // the next — while the store's own page showed ₹21,999 throughout — and each
  // flip produced a "PRICE INCREASE ALERT +15%" for a price that never changed.
  // For a store that refuses us the price comes from a third-party reading, and
  // one such reading can be another seller's or another variant's figure.
  //
  // So: when the change is large, read once more. If the second reading agrees,
  // the move is real and everything proceeds. If it disagrees, the FIRST reading
  // was the odd one — the confirmed value is adopted instead, and no alert is
  // sent. If the re-read fails, we change nothing and carry on as before, because
  // an inability to check must never silence a genuine alert.
  let confirmedPrice = newPriceRaw;
  let unconfirmed = false;
  if (oldPrice != null && confirmedPrice != null && oldPrice > 0 && Math.abs(((confirmedPrice - oldPrice) / oldPrice) * 100) >= CONFIRM_THRESHOLD) {
    try {
      // The second reading must come from a DIFFERENT source. Re-reading the same
      // one only confirms its own mistake: the reported price stayed ₹22,999 on
      // every read because every read used the same text scan.
      //
      // For Amazon the independent check is the hosted API, whose price IS the
      // buybox. For anything else it is the page itself.
      let again = null;
      if (data.marketplace === 'amazon') {
        const { lookupAsin } = require('../lib/amazonapi');
        const asin = result.productId || data.productId;
        const item = asin ? await lookupAsin(asin).catch(() => null) : null;
        if (item && item.price != null) again = { ok: true, price: item.price };
      }
      if (!again) {
        again = await fetchProduct(
          result.resolvedUrl || data.fetchUrl || data.cleanUrl || data.affiliateUrl,
          data.marketplace
        );
      }
      if (again && again.ok && again.price != null) {
        if (again.price !== confirmedPrice) {
          // The two sources DISAGREE, so neither can be trusted — and the log
          // shows why that matters: the store lists ₹21,999, one reading said
          // ₹28,998, the independent re-read said ₹27,999 (which is the 4GB
          // variant's struck-through MRP, not a selling price). Adopting either
          // would be a guess.
          //
          // So keep the price we already had, write nothing, and alert nobody.
          // A genuine change is AGREED by both readings and proceeds normally;
          // only a contradiction stops here.
          console.warn(
            'cron: ' + doc.id + ' — ' + confirmedPrice + ' vs ' + again.price +
              ': the sources disagree, so neither is trusted. Keeping the stored price and sending no alert'
          );
          unconfirmed = true;
        } else {
          console.log('cron: ' + doc.id + ' — price ' + confirmedPrice + ' confirmed on a second read');
        }
      }
    } catch (err) {
      console.warn('cron: ' + doc.id + ' — could not confirm the move (' + err.message + '); proceeding');
    }
  }


  if (unconfirmed) {
    // Nothing recorded, nothing alerted: the price is left exactly as it was, so
    // the dashboard keeps showing the last figure we could actually stand behind.
    return {
      id: doc.id,
      status: 'unconfirmed',
      url: String(url).slice(0, 120),
      inStock: typeof result.inStock === 'boolean' ? result.inStock : null,
      httpStatus: result.status || null,
    };
  }

  const newPrice = confirmedPrice;

  // A BARE GUESS IS NOT A READING.
  //
  // When the store refuses this host we fall back to a reader service, which
  // hands back the page as free text, and the price becomes "the first ₹ in the
  // buy area". That is a guess: it is how a card showed ₹19,999 for a product
  // the store listed at ₹21,999, and how the wrong number then became a history
  // point, a lowest, an average and a 30-day range.
  //
  // So a guess may CONFIRM a price it agrees with, but it may never MOVE one,
  // and it is never written as a reading. A real change has to come from a
  // source that states the price — the page's own markup, or the hosted API.
  if (result.guess && oldPrice != null && newPrice !== oldPrice) {
    console.warn(
      'cron: ' + doc.id + ' — price ' + newPrice +
        ' came from a text guess and differs from the stored ' + oldPrice +
        '; not recording it and sending no alert'
    );
    return {
      id: doc.id,
      status: 'guessed',
      url: String(url).slice(0, 120),
      inStock: typeof result.inStock === 'boolean' ? result.inStock : null,
      httpStatus: result.status || null,
    };
  }

  // Capture the PREVIOUS stock state BEFORE the update below. Reading it after
  // the write is fragile — the snapshot may already reflect the new value.
  const wasOutOfStock = data.inStock === false;

  // Append the history point — but never a guessed one. The SOURCE is recorded
  // with it, so a later run can tell a reading we stood behind from one we did
  // not, and so a rise can be judged against a baseline worth trusting.
  if (!result.guess) {
    await doc.ref.collection(COLLECTIONS.PRICE_HISTORY).add({
      price: newPrice,
      src: result.priceKind || null,
      currency: result.currency || 'INR',
      checkedAt: FieldValue.serverTimestamp(),
    });
  }

  const update = {
    lastPrice: newPrice,
    lastPriceSource: result.priceKind || null,
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

  // SELF-CORRECTION, the moment we have something to correct against.
  //
  // The reading we just recorded is trusted (a labelled price, one anchored on
  // the M.R.P., or the hosted API's buybox) — that is the trigger. This product's
  // history is now checked against it and against the MRP, and whatever they
  // contradict is removed: readings above the MRP or far under it, excursions
  // that bounce back, and runs sitting away from the trusted price with the
  // readings on both sides back at it.
  //
  // It runs here, per product, so no one has to clean products one URL at a
  // time. A GUESS never triggers it — only a price we can stand behind does.
  // Never awaited in a way that can fail the check: selfCleanProduct swallows its
  // own errors and returns null.
  //
  // AND ONLY OCCASIONALLY. This pass reads the product's ENTIRE history — up to
  // 2000 documents — and it used to run on EVERY check for EVERY product. At
  // hourly checks across a dozen products that is tens of thousands of reads a
  // day on its own, which is how a free-tier quota gets exhausted:
  //   8 RESOURCE_EXHAUSTED: Quota exceeded
  // Nothing it does needs to happen hourly. A polluted history is not an
  // emergency, so it now runs at most once per SELF_CLEAN_MIN_HOURS per product.
  const lastClean = data.lastSelfCleanAt && data.lastSelfCleanAt.toMillis
    ? data.lastSelfCleanAt.toMillis()
    : null;
  const cleanDue =
    lastClean == null || Date.now() - lastClean > SELF_CLEAN_MIN_HOURS * 3600 * 1000;

  if (!result.guess && cleanDue) {
    try {
      const { selfCleanProduct } = require('../lib/selfClean');
      const cleanReport = await selfCleanProduct({
        productId: doc.id,
        trustedPrice: newPrice,
        mrp: result.mrp != null ? result.mrp : data.mrp,
        log: (line) => console.log(line),
      });
      // Stamp it whether or not anything was removed, so the throttle holds.
      await doc.ref
        .set({ lastSelfCleanAt: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => {});
      if (cleanReport && cleanReport.removed) {
        console.log(
          'cron: ' + doc.id + ' self-corrected — removed ' + cleanReport.removed +
            ' bad readings, kept ' + cleanReport.kept
        );
      }
    } catch (err) {
      console.warn('cron: self-clean failed for ' + doc.id + ' (' + err.message + '); history untouched');
    }
  }

  // The history prune is a query plus deletes. Daily is plenty — running it on
  // every check was pure quota burn for no benefit.
  const lastPrune = data.lastPruneAt && data.lastPruneAt.toMillis ? data.lastPruneAt.toMillis() : null;
  if (lastPrune == null || Date.now() - lastPrune > PRUNE_MIN_HOURS * 3600 * 1000) {
    await pruneOldHistory(doc.ref);
    await doc.ref
      .set({ lastPruneAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {});
  }

  // Alerts: price drops, price increases, and back-in-stock.
  let alerted = 0;
  const subscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
  const alertProduct = { ...data, title: title || data.title || result.title };

  const pct =
    oldPrice != null && newPrice != null && oldPrice > 0 && newPrice !== oldPrice
      ? ((newPrice - oldPrice) / oldPrice) * 100
      : null;

  // A product that is OUT OF STOCK right now must never produce a price alert.
  // Its page carries exchange, EMI, coupon and sponsored figures, and a wrong
  // one there is exactly how a false "price dropped to ₹10,490" was sent for a
  // ₹19,999 phone that was not even in stock.
  const outOfStockNow = result.inStock === false;

  // Only the DROP is suppressed while out of stock — that was the reported bug,
  // a false drop on an item showing "Notify Me". A RISE is never that kind of
  // false alarm, and suppressing it too (an earlier version did) meant an
  // out-of-stock item produced NO alerts of any kind, which is indistinguishable
  // from the bot being broken.
  // A RISE NEEDS A BASELINE WE CAN VOUCH FOR.
  //
  // The reported product sent "PRICE INCREASE ALERT +10%" and "+15%" for a price
  // that had not changed: the stored figure was ₹19,999, left there by a text
  // scan that had picked the wrong figure, so every correct reading after it
  // looked like a rise. An alert is only meaningful if the number it is measured
  // AGAINST is real.
  //
  // So the previous reading must have come from a source that states the price.
  // Readings recorded before the source was tracked carry none, and are treated
  // as unverified — a rise against one is not sent. A DROP is unaffected: it is
  // the alert people actually want, and the out-of-stock guard above already
  // covers the case where a drop is an artifact.
  const VERIFIED = new Set(['labelled', 'mrp-anchored', 'api', 'page']);
  const baselineVerified = VERIFIED.has(data.lastPriceSource);

  let message = null;
  if (!outOfStockNow && pct != null && pct <= -DROP_THRESHOLD) {
    message = formatAlert(alertProduct, oldPrice, newPrice, pct, 'drop', result.inStock);
  } else if (pct != null && pct >= INCREASE_THRESHOLD) {
    if (baselineVerified) {
      message = formatAlert(alertProduct, oldPrice, newPrice, pct, 'rise', result.inStock);
    } else {
      console.log(
        'cron: ' + doc.id + ' — suppressing a +' + pct.toFixed(1) +
          '% rise alert: the stored ' + oldPrice + ' came from a source we cannot vouch for'
      );
    }
  }

  // Only on the TRANSITION, so we don't repeat it every run.
  if (wasOutOfStock && result.inStock === true) {
    message = formatAlert(alertProduct, oldPrice, newPrice, 0, 'restock', true);
  }

  // ...and the other direction. A product going OUT of stock is news too — it
  // tells a watcher that the price they are holding out for is gone for now.
  // Only on the transition, same as restock.
  //
  // BUT ONLY WHEN WE ACTUALLY READ THE PRODUCT.
  //
  // The reported alert went out for an item Amazon showed at ₹22,499, In stock,
  // and it carried no price at all — the tell that nothing was really read. An
  // out-of-stock verdict is the one alert that costs the user something if it is
  // wrong: they stop waiting for a price that is right there. So it needs
  // corroboration, not just a flag:
  //   - we must have a price (a page that yielded nothing has not been read),
  //   - and we must have seen the product IN stock before, which the transition
  //     already requires.
  // A restock alert has no such risk, and a price alert needs a price by
  // definition, so neither is gated this way.
  const readReliably = result.price != null && !result.guess;
  if (!wasOutOfStock && result.inStock === false) {
    if (readReliably) {
      message = formatAlert(alertProduct, oldPrice, newPrice, 0, 'outofstock', false);
    } else {
      console.log(
        'cron: ' + doc.id + ' — suppressing an OUT OF STOCK alert: the reading came ' +
          'with no usable price, so the stock state is not trustworthy'
      );
    }
  }

  // ── COOLDOWN ─────────────────────────────────────────────────────────────
  // The same alert must not go out twice in quick succession.
  //
  // The screenshots showed exactly that: "BACK IN STOCK ALERT" delivered at
  // 11:57 and again at 11:58, identical. Two cron runs a minute apart — or one
  // run that re-read the same page — each decided the transition had happened.
  // To the user that is spam, and it is the kind that makes a bot feel broken.
  //
  // So the alert's identity (its kind plus the price it carries) is remembered
  // on the product, and an identical one is suppressed inside the window. A
  // genuinely different alert — a new price, or a different kind — is NOT held
  // back, because that is new information.
  if (message) {
    const alertKey = alertIdentity(message);
    const lastKey = data.lastAlertKey || null;
    const lastAt =
      data.lastAlertAt && data.lastAlertAt.toMillis ? data.lastAlertAt.toMillis() : null;
    const cooldownMs = ALERT_COOLDOWN_MINUTES * 60 * 1000;
    if (lastKey === alertKey && lastAt != null && Date.now() - lastAt < cooldownMs) {
      const waited = Math.round((Date.now() - lastAt) / 1000);
      console.log(
        'cron: ' + doc.id + ' — suppressing a repeat alert (same as ' + waited +
          's ago, cooldown ' + ALERT_COOLDOWN_MINUTES + 'm)'
      );
      message = null;
    }
  }

  if (message) {
    // Remember what was sent, so the next run can tell a repeat from news.
    try {
      await doc.ref.set(
        { lastAlertKey: alertIdentity(message), lastAlertAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      console.warn('cron: could not record the alert identity for ' + doc.id + ' (' + err.message + ')');
    }
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

/**
 * Run the history repair automatically, once a day.
 *
 * A polluted history has to be cleared for the chart and the lowest/average
 * stats to mean anything, and asking a person to remember a command (and a token)
 * means it never happens. This runs in the background, is bounded, and never
 * fails the price check it rides along with.
 */
let lastAutoCleanDay = null;
async function maybeAutoClean() {
  try {
    if (CLEAN_HOUR < 0) return;
    const now = new Date();
    // IST, to match the schedules the user sets.
    const istHour = new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
    const day = now.toISOString().slice(0, 10);
    if (istHour !== CLEAN_HOUR || lastAutoCleanDay === day) return;
    lastAutoCleanDay = day;

    const { cleanHistory } = require('../lib/cleanHistory');
    const report = await cleanHistory({
      apply: true,
      log: (line) => console.log('auto-clean: ' + line),
    });
    console.log(
      'auto-clean: done — scanned=' + report.scanned + ' affected=' + report.affected +
        ' removed=' + report.removed + ' lastPriceFixed=' + report.lastPriceFixed
    );
  } catch (err) {
    console.warn('auto-clean failed (the price check is unaffected):', err.message);
  }
}

const runCron = async (req, res) => {
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

    // Repair the history in the background, once a day. Never awaited.
    maybeAutoClean().catch(() => {});

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

/**
 * One cron run at a time.
 *
 * Two overlapping runs cost twice the reads and writes and buy nothing: both
 * would check the same products and both would write history. Overlap happens
 * more easily than it looks — a slow sweep still going when the next schedule
 * tick lands, a retried /api/cron, or a second instance that has not yet stood
 * its jobs down. This is the last place where the pipeline could be entered
 * twice at once, so it is closed here rather than trusted to the callers.
 */
let cronInFlight = false;
let cronLastFinishedAt = 0;

const handler = async (req, res) => {
  if (cronInFlight) {
    console.warn('cron: a run is already in flight — skipping this one rather than stacking a second');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, skipped: 'already_running' }));
    return;
  }
  cronInFlight = true;
  try {
    return await runCron(req, res);
  } finally {
    cronInFlight = false;
    cronLastFinishedAt = Date.now();
  }
};

module.exports = handler;

// Exposed for tests.
module.exports.isCronInFlight = () => cronInFlight;
module.exports.cronLastFinishedAt = () => cronLastFinishedAt;
module.exports.isFlipkartShortLink = isFlipkartShortLink;
module.exports.alertKeyboard = alertKeyboard;
