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
const { convertAffiliateLink, isSupportedLink } = require('../lib/affiliate');

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
 * Price fields are left null here; the cron job fills them on its first run.
 * One product doc per marketplace+productId, so price history is shared.
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

/** Telegram channel the "Today's Deals" button points at. */
const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/Ai_PriceAlert';

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
  const historyUrl = process.env.WEB_APP_URL
    ? process.env.WEB_APP_URL.replace(/\/$/, '') + '/?id=' + encodeURIComponent(docId)
    : null;

  const row1 = [];
  if (buyUrl) row1.push(Markup.button.url('✅ Buy Now', buyUrl));
  row1.push(Markup.button.callback('🔴 Stop Tracking', 'untrack:' + docId));

  const row2 = [];
  if (historyUrl) row2.push(Markup.button.url('📊 Price History', historyUrl));
  row2.push(Markup.button.url("🛍️ Today's Deals", CHANNEL_URL));

  return Markup.inlineKeyboard([row1, row2]);
}

function formatTrackedProduct(result, docId) {
  const lines = [
    'Take a look at this product...',
    "😉 I've started tracking this product. Now, you can sit back and relax! I will send you an alert when the price of this product drops!!",
    '',
    'Click /list to see all the products I am tracking for you 😃',
  ];
  if (!result.hasAffiliateTag) {
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
    try {
      if (db && ctx.from) await upsertUser(ctx.from);
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
      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }
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

      if (!db) {
        await ctx.reply(DB_DOWN);
        return;
      }

      await upsertUser(ctx.from);
      const docId = await trackProduct(result, ctx.from);

      await ctx.reply(formatTrackedProduct(result, docId), {
        ...buildTrackKeyboard(docId, result),
      });
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
  extractSupportedUrl,
  upsertUser,
  trackProduct,
  untrackProduct,
  buildTrackKeyboard,
  formatTrackedProduct,
  registerHandlers,
  getBot,
  parseBody,
  readUpdate,
  configProblems,
};
