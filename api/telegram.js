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
 * Env vars used here:
 *   BOT_TOKEN                  -> Telegram bot token from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET    -> the secret_token you pass to setWebhook (optional)
 *   WEB_APP_URL                -> base URL of the price-history page (STEP 5)
 * ---------------------------------------------------------------------------
 */

const { Telegraf, Markup } = require('telegraf');
const { db, admin, COLLECTIONS } = require('../lib/firebase');
const { convertAffiliateLink, isSupportedLink } = require('../lib/affiliate');

const MARKETPLACE_LABEL = { amazon: '🛒 Amazon', flipkart: '🛍️ Flipkart' };

/** Escape a string for Telegram HTML parse mode (& < > only). */
function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Stable Firestore doc id for a product: e.g. "amazon_B08N5WRWNW". */
function productDocId(result) {
  return result.marketplace + '_' + result.productId;
}

/** Return the first whitespace-delimited token that looks like a supported link. */
function extractSupportedUrl(text) {
  if (!text) return null;
  for (const token of String(text).split(/\s+/)) {
    if (isSupportedLink(token)) return token;
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
 * Price fields are left null here; the cron job (STEP 4) fills them on its
 * first run. We deliberately keep ONE product doc per marketplace+productId so
 * price history is shared, with a `subscribers` array of Telegram user ids.
 */
async function trackProduct(result, from) {
  const docId = productDocId(result);
  const ref = db.collection(COLLECTIONS.PRODUCTS).doc(docId);
  const snap = await ref.get();

  const data = {
    marketplace: result.marketplace,
    productId: result.productId,
    cleanUrl: result.cleanUrl,
    affiliateUrl: result.affiliateUrl,
    subscribers: admin.firestore.FieldValue.arrayUnion(String(from.id)),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    active: true,
  };

  if (!snap.exists) {
    data.createdAt = admin.firestore.FieldValue.serverTimestamp();
    data.title = null;
    data.imageUrl = null;
    data.currency = 'INR';
    data.lastPrice = null;
    data.lastCheckedAt = null;
  }

  await ref.set(data, { merge: true });
  return docId;
}

/** Unsubscribe a user from a product. */
async function untrackProduct(docId, from) {
  const ref = db.collection(COLLECTIONS.PRODUCTS).doc(docId);
  await ref.set(
    {
      subscribers: admin.firestore.FieldValue.arrayRemove(String(from.id)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Inline keyboard: "Price Track" (opens the STEP 5 web page) + "Untrack". */
function buildTrackKeyboard(docId) {
  const buttons = [];
  if (process.env.WEB_APP_URL) {
    const base = process.env.WEB_APP_URL.replace(/\/$/, '');
    buttons.push(Markup.button.url('📈 Price Track', base + '/?id=' + encodeURIComponent(docId)));
  }
  buttons.push(Markup.button.callback('🛑 Untrack', 'untrack:' + docId));
  return Markup.inlineKeyboard(buttons);
}

function formatTrackedProduct(result, docId) {
  const lines = [
    '✅ <b>Link converted &amp; tracked</b>',
    '',
    MARKETPLACE_LABEL[result.marketplace] || result.marketplace,
    '📦 <code>' + escapeHtml(result.productId) + '</code>',
    '',
    '🔗 <code>' + escapeHtml(result.affiliateUrl) + '</code>',
  ];
  if (!result.hasAffiliateTag) {
    lines.push('', '⚠️ No affiliate tag configured yet — the link is clean but not monetised.');
  }
  lines.push('', 'Tracking ID: <code>' + escapeHtml(docId) + '</code>');
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

function registerHandlers(bot) {
  bot.start(async (ctx) => {
    try {
      if (ctx.from) await upsertUser(ctx.from);
      await ctx.reply(
        '👋 <b>Welcome to Price Tracker!</b>\n\n' +
          'Send me any Amazon or Flipkart product link and I will:\n' +
          '• convert it into a clean affiliate link\n' +
          '• start tracking its price for 30 days\n\n' +
          '<b>Commands</b>\n' +
          '/mytracks – list your tracked products\n' +
          '/untrack &lt;id&gt; – stop tracking one\n' +
          '/help – how it works',
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('start handler failed', err);
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

  bot.command(['mytracks', 'list'], async (ctx) => {
    try {
      if (!ctx.from) return;
      const snap = await db
        .collection(COLLECTIONS.PRODUCTS)
        .where('subscribers', 'array-contains', String(ctx.from.id))
        .limit(20)
        .get();

      if (snap.empty) {
        await ctx.reply('You are not tracking anything yet. Send an Amazon or Flipkart link to start.');
        return;
      }

      const lines = ['📋 <b>Your tracked products</b>', ''];
      snap.docs.forEach((doc, i) => {
        const d = doc.data();
        const price = d.lastPrice != null ? ' — ₹' + d.lastPrice : '';
        lines.push(
          i + 1 + '. ' + (MARKETPLACE_LABEL[d.marketplace] || d.marketplace) +
            ' <code>' + escapeHtml(doc.id) + '</code>' + price
        );
      });
      lines.push('', 'Use /untrack &lt;id&gt; to stop tracking one.');
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('mytracks handler failed', err);
    }
  });

  bot.command('untrack', async (ctx) => {
    try {
      if (!ctx.from) return;
      const docId = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim();
      if (!docId) {
        await ctx.reply('Usage: /untrack <id>\nGet the id from /mytracks.');
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

  bot.on('text', async (ctx) => {
    try {
      if (!ctx.from) return;
      const text = ctx.message.text || '';
      if (text.startsWith('/')) return; // commands are handled above

      const url = extractSupportedUrl(text);
      if (!url) {
        await ctx.reply(
          'Send me an Amazon or Flipkart product link and I will convert it into an ' +
            'affiliate link and track its price.\n\nExample: https://www.amazon.in/dp/B08N5WRWNW'
        );
        return;
      }

      await ctx.reply('🔎 Converting your link…');
      const result = await convertAffiliateLink(url);

      if (!result.ok) {
        await ctx.reply('⚠️ ' + (CONVERT_ERRORS[result.reason] || 'Could not convert that link.'));
        return;
      }

      await upsertUser(ctx.from);
      const docId = await trackProduct(result, ctx.from);

      await ctx.reply(formatTrackedProduct(result, docId), {
        parse_mode: 'HTML',
        ...buildTrackKeyboard(docId),
      });
    } catch (err) {
      console.error('text handler failed', err);
      try {
        await ctx.reply('Something went wrong while processing that link. Please try again.');
      } catch (_) {
        /* reply already failed; nothing else to do */
      }
    }
  });

  bot.action(/^untrack:(.+)$/, async (ctx) => {
    try {
      if (!ctx.from) return;
      const docId = ctx.match[1];
      await untrackProduct(docId, ctx.from);
      if (ctx.answerCbQuery) await ctx.answerCbQuery('Stopped tracking').catch(() => {});
    } catch (err) {
      console.error('action handler failed', err);
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

module.exports = async (req, res) => {
  // GET (or anything non-POST) acts as a liveness probe for setup/debugging.
  if (req.method !== 'POST') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Telegram webhook is live.');
    return;
  }

  // Verify the secret_token Telegram echoes back on every delivery.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const received = req.headers['x-telegram-bot-api-secret-token'];
    if (received !== secret) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
  }

  const update = parseBody(req.body);
  if (!update) {
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
  extractSupportedUrl,
  upsertUser,
  trackProduct,
  untrackProduct,
  buildTrackKeyboard,
  formatTrackedProduct,
  registerHandlers,
  getBot,
  parseBody,
};
