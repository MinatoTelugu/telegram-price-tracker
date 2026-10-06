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

const telegramFn = require('./api/telegram');
const cronFn = require('./api/cron');
const dealsFn = require('./api/deals');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is required.');
  process.exit(1);
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

// ---- run a serverless handler as a normal function ------------------------
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

  cron.schedule(priceCron, async () => {
    const r = await callHandler(cronFn, { host: 'localhost' });
    console.log('price check ->', r.statusCode, String(r.body).slice(0, 300));
  });

  cron.schedule(dealsCron, async () => {
    const r = await callHandler(dealsFn, { host: 'localhost' });
    console.log('deals ->', r.statusCode, String(r.body).slice(0, 300));
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
