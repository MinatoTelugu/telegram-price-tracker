/**
 * server.js
 * ---------------------------------------------------------------------------
 * Long-running server for Koyeb / Railway / any host that runs a process
 * (as opposed to Vercel's serverless functions).
 *
 * On Vercel the bot must use a webhook, and a webhook URL can be broken from
 * outside — which is exactly what kept happening. Here the bot uses Telegram
 * LONG POLLING instead: no webhook to break, no URL to re-register, no
 * serverless time limit, no cron frequency cap.
 *
 * This file also serves the WEBSITE and the /api/ endpoints, because Koyeb has
 * no equivalent of Vercel's routing:
 *   /                     -> public/index.html  (the price-history page)
 *   /logo.jpg             -> public/logo.jpg
 *   /api/track?id=...     -> api/track.js
 *   /api/cron, /api/deals -> the job endpoints
 *   /health               -> a small JSON liveness blob
 *
 * Env vars: everything from .env.example, plus optionally
 *   PORT         -> HTTP port (default 8080)
 *   PRICE_CRON   -> cron expression for price checks (default every 6 hours)
 *   DEALS_CRON   -> cron expression for deals       (default every 6 hours, offset)
 * ---------------------------------------------------------------------------
 */

// The bot here uses polling, so nothing must re-register a webhook.
process.env.DISABLE_WEBHOOK_MANAGEMENT = '1';

const http = require('http');
const fs = require('fs');
const path = require('path');
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
if (!process.env.BITLY_ACCESS_TOKEN) {
  console.warn('NOTE: BITLY_ACCESS_TOKEN is not set, so links will not be shortened.');
}
if (!process.env.WEB_APP_URL) {
  console.warn('NOTE: WEB_APP_URL is not set, so the "Price History" button will be hidden.');
}

// ---- helpers --------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

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
  // Internal calls MUST authenticate the same way cron-job.org does. Otherwise,
  // the moment CRON_SECRET is set the endpoint answers 401 to its own timer,
  // and every scheduled run silently does nothing.
  const merged = Object.assign({ host: 'localhost' }, headers || {});
  if (process.env.CRON_SECRET && !merged.authorization) {
    merged.authorization = 'Bearer ' + process.env.CRON_SECRET;
  }
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    Promise.resolve(handler({ method: 'GET', headers: merged, query: {}, url: '/' }, res)).catch(
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

// ---- website + API --------------------------------------------------------
const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'bad url' });
    return;
  }
  const pathname = parsed.pathname;

  // Liveness for the platform's health check.
  if (pathname === '/health' || pathname === '/healthz') {
    sendJson(res, 200, { ok: true, mode: 'long-polling', uptime: process.uptime() });
    return;
  }

  // API endpoints — same files Vercel would run.
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) {
      sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
      return;
    }
    let handler = null;
    try {
      handler = require('./api/' + name);
    } catch (err) {
      console.error('api/' + name + ' could not be loaded:', err.message);
    }
    if (typeof handler !== 'function') {
      sendJson(res, 404, { ok: false, error: 'unknown endpoint: ' + name });
      return;
    }
    // Vercel provides req.query; give the handlers the same shape here.
    const query = {};
    parsed.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    req.query = query;
    try {
      await handler(req, res);
    } catch (err) {
      console.error('api/' + name + ' failed:', err.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Static site.
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (!err) {
      sendFile(res, filePath);
      return;
    }
    // Unknown path with no file extension -> serve the app page.
    if (!path.extname(rel)) {
      sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log('Website + API listening on port ' + port));

// ---- bot (long polling) ---------------------------------------------------
let bot = null;

/**
 * Start polling, retrying instead of crashing. A 409 means another copy of the
 * bot is polling with the same token (e.g. the platform runs two instances, or
 * the bot is also live on Vercel) — we log it clearly and try again rather than
 * dying and triggering a restart loop.
 */
/**
 * Open connections to the hosts we rely on, in the background. Cheap, and it
 * removes DNS + TLS setup from the first real request after a cold start.
 */
async function warmUp() {
  const { httpsAgent } = require('./lib/httpAgent');
  const https = require('https');

  const targets = ['https://www.flipkart.com/', 'https://api.telegram.org/'];
  if (process.env.WEB_APP_URL) targets.push(process.env.WEB_APP_URL);
  if (process.env.CUELINKS_API_URL) targets.push(process.env.CUELINKS_API_URL);
  if (process.env.AFFILIATERS_CONVERTER_URL) targets.push(process.env.AFFILIATERS_CONVERTER_URL);

  await Promise.all(
    targets.map(
      (url) =>
        new Promise((resolve) => {
          try {
            const req = https.request(url, { method: 'HEAD', timeout: 5000, agent: httpsAgent }, () => resolve());
            req.on('error', () => resolve());
            req.on('timeout', () => {
              req.destroy();
              resolve();
            });
            req.end();
          } catch (err) {
            resolve();
          }
        })
    )
  );
  console.log('Warm-up complete for', targets.length, 'hosts');
}

async function startPolling() {
  // Never allow two pollers inside one process: a retry must stop the previous
  // one first, otherwise the bot fights itself and Telegram returns 409 forever.
  if (bot) {
    try {
      bot.stop('restart');
    } catch (err) {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  bot = new Telegraf(token);
  telegramFn._internals.registerHandlers(bot);

  try {
    // Polling cannot work while a webhook is registered, so clear it first.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (err) {
    console.warn('deleteWebhook failed (continuing):', err.message);
  }

  // Warm the connections we depend on, so the FIRST user request after a start
  // does not pay DNS + TLS for every host. A scale-to-zero host that has just
  // woken up is the main reason a reply can feel slow.
  warmUp().catch((err) => console.warn('warm-up failed:', err.message));

  console.log('Starting Telegram polling...');
  try {
    await bot.launch();
    console.log('Bot started in long-polling mode.');
    return;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/409|Conflict/i.test(msg)) {
      console.error(
        'Polling conflict: ANOTHER copy of this bot is polling with the same token. ' +
          'Set this service to exactly ONE instance, and make sure there is no second ' +
          'deployment of it. Retrying in 60 seconds...'
      );
      setTimeout(() => {
        startPolling().catch((e) => console.error('retry failed:', e.message));
      }, 60000);
      return;
    }
    console.error('Polling failed:', msg);
    console.error('Retrying in 30 seconds...');
    setTimeout(() => {
      startPolling().catch((e) => console.error('retry failed:', e.message));
    }, 30000);
  }
}

// ---- start ----------------------------------------------------------------
(async () => {
  // IMPORTANT: do NOT await startPolling() here.
  //
  // Telegraf's bot.launch() resolves only when polling STOPS, so awaiting it on
  // a HEALTHY start means everything below — the schedulers and the first run —
  // is never reached. That silently disabled the in-process price checks (the
  // "Scheduled:" line was missing from the startup log, which is how this was
  // spotted). startPolling retries internally, so it needs no await.
  startPolling().catch((err) => console.error('polling failed:', err.message));

  const priceCron = process.env.PRICE_CRON || '*/30 * * * *';
  const dealsCron = process.env.DEALS_CRON || '30 */6 * * *';

  cron.schedule(priceCron, () => {
    runJob('cron').catch((err) => console.error('price check failed:', err.message));
  });

  cron.schedule(dealsCron, () => {
    runJob('deals').catch((err) => console.error('deals failed:', err.message));
  });

  console.log('Scheduled: price checks "' + priceCron + '", deals "' + dealsCron + '"');

  // Also run once shortly after startup. A restart resets the schedule, so
  // without this the first price check could be hours away and the price
  // history page would look empty.
  setTimeout(() => {
    runJob('cron').catch((err) => console.error('startup price check failed:', err.message));
  }, 60 * 1000);
  setTimeout(() => {
    runJob('deals').catch((err) => console.error('startup deals failed:', err.message));
  }, 150 * 1000);

  // Watchdog: keep the bot reachable even if the Telegram connection drops.
  setInterval(async () => {
    if (!bot) return;
    try {
      await bot.telegram.getMe();
    } catch (err) {
      console.error('watchdog: Telegram unreachable (' + err.message + '), restarting polling...');
      try {
        bot.stop('watchdog');
      } catch (e) {
        /* ignore */
      }
      startPolling().catch((e) => console.error('watchdog restart failed:', e.message));
    }
  }, 5 * 60 * 1000);
})();

function shutdown(signal) {
  console.log(signal + ' received, stopping.');
  try {
    if (bot) bot.stop(signal);
  } catch (err) {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Never die from an unhandled rejection or a stray exception — log it and keep
// running, so the bot stays up instead of dropping offline.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (continuing):', (err && err.message) || err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (continuing):', (err && err.stack) || err);
});
