/**
 * server.js
 * ---------------------------------------------------------------------------
 * Long-running server for Koyeb / Railway / any host that runs a process
 * (as opposed to Vercel's serverless functions).
 *
 * Why this exists: on Vercel the bot must use a webhook, and a webhook URL can
 * be broken from outside — which is exactly what kept happening. Here the bot
 * uses Telegram LONG POLLING instead: there is no webhook to break, no URL to
 * re-register, no serverless time limit, and no cron frequency cap.
 *
 * It runs the exact same handlers as the Vercel deployment:
 *   - api/telegram.js  -> the bot handlers (shared)
 *   - api/cron.js      -> price checks + price-drop alerts
 *   - api/deals.js     -> the deals auto-poster
 *
 * Env vars: everything from .env.example, plus optionally
 *   PORT         -> HTTP port for the health endpoint (default 8080)
 *   PRICE_CRON   -> cron expression for price checks (default every 6 hours)
 *   DEALS_CRON   -> cron expression for deals       (default every 6 hours, offset)
 * ---------------------------------------------------------------------------
 */

// The bot here uses polling, so nothing must re-register a webhook.
process.env.DISABLE_WEBHOOK_MANAGEMENT = '1';

const http = require('http');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');

// api/telegram.js loads Firebase defensively, so requiring it can never crash
// the process. The two JOB modules are loaded lazily below for the same reason.
const telegramFn = require('./api/telegram');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is required.');
  process.exit(1);
}

// Tell the operator clearly what is missing, instead of dying silently.
const hasFirebase =
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY) ||
  Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
if (!hasFirebase) {
  console.error(
    'WARNING: Firebase credentials are not set. The bot will still start and reply, ' +
      'but tracking, price checks and deals will not work until you add ' +
      'FIREBASE_SERVICE_ACCOUNT_KEY (or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).'
  );
}

// ---- bot (long polling) ---------------------------------------------------
const bot = new Telegraf(token);
telegramFn._internals.registerHandlers(bot);

// ---- health endpoint ------------------------------------------------------
const port = process.env.PORT || 8080;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: 'long-polling', uptime: process.uptime() }));
  })
  .listen(port, () => console.log('Health server listening on port ' + port));

// ---- helpers --------------------------------------------------------------
/** Load a job module lazily so a bad config can't crash the whole process. */
function loadJob(name) {
  try {
    return require(name === 'deals' ? './api/deals' : './api/cron');
  } catch (err) {
    console.error('Could not load the ' + name + ' job:', err.message);
    return null;
  }
}

/** Run a serverless handler as a normal function. */
function callHandler(handler, headers) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    Promise.resolve(handler({ method: 'GET', headers: headers || {}, query: {}, url: '/' }, res)).catch(
      (err) => resolve({ statusCode: 500, body: String((err && err.message) || err) })
    );
  });
}

async function runJob(name) {
  const handler = loadJob(name);
  if (!handler) return;
  const r = await callHandler(handler, { host: 'localhost' });
  console.log(name + ' ->', r.statusCode, String(r.body).slice(0, 300));
}

// ---- start ----------------------------------------------------------------
(async () => {
  try {
    // Polling cannot work while a webhook is registered, so clear it first.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    console.warn('deleteWebhook failed (continuing):', err.message);
  }

  await bot.launch();
  console.log('Bot started in long-polling mode.');

  const priceCron = process.env.PRICE_CRON || '0 */6 * * *';
  const dealsCron = process.env.DEALS_CRON || '30 */6 * * *';

  cron.schedule(priceCron, () => {
    runJob('cron').catch((err) => console.error('price check failed:', err.message));
  });

  cron.schedule(dealsCron, () => {
    runJob('deals').catch((err) => console.error('deals failed:', err.message));
  });

  console.log('Scheduled: price checks "' + priceCron + '", deals "' + dealsCron + '"');
})();

process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping.');
  try {
    bot.stop('SIGTERM');
  } catch (err) {
    /* ignore */
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  try {
    bot.stop('SIGINT');
  } catch (err) {
    /* ignore */
  }
  process.exit(0);
});
