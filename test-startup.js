/**
 * test-startup.js — guards the server startup sequence.
 *
 * The bug this exists for: `await startPolling()` before the schedulers.
 * Telegraf's bot.launch() resolves only when polling STOPS, so on a HEALTHY
 * start that await never returns and every line after it — the cron
 * registration and the first run — is silently skipped. The bot looked fine
 * (polling worked, the "Scheduled:" line was just missing) while the in-process
 * price checks never ran at all.
 *
 * A source-level check, because the failure mode is "code that never executes".
 */
const fs = require('fs');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else {
    fail++;
    console.log('  ✗ FAIL: ' + name);
  }
}

const src = fs.readFileSync(__dirname + '/server.js', 'utf8');

const pollIdx = src.indexOf('startPolling()');
const schedIdx = src.indexOf('cron.schedule(priceCron');
// Strip comments first: the explanatory comment above the fix mentions the very
// pattern we are guarding against, and would otherwise match itself.
const stripComments = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

const startupBlock = stripComments(src.slice(src.indexOf('(async () => {'), schedIdx));

check('the startup block schedules the price cron', schedIdx !== -1);
check(
  'startPolling() is NOT awaited before scheduling',
  !/await\s+startPolling\(\)/.test(startupBlock)
);
check('startPolling() is still called', pollIdx !== -1);
check(
  'its rejection is handled, so it cannot crash the process',
  /startPolling\(\)\.catch\(/.test(src)
);
check('the deals cron is scheduled too', src.includes('cron.schedule(dealsCron'));
check('a startup run is still queued', src.includes('setTimeout(') && src.includes('runJob('));

// --- the enrichment must not silently strip the inline keyboard ---------------
// Telegram REMOVES a message's inline keyboard when editMessageText is called
// without reply_markup. That is why Amazon cards (whose background enrichment
// always ran) lost their buttons while Flipkart's kept theirs.
const tg = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
const editCall = tg.slice(tg.indexOf('editMessageText(ctx.chat.id, sentMessage.message_id'));
check('the enrichment edits the card', editCall.length > 0);
check(
  'and passes reply_markup, so the buttons survive the edit',
  editCall.slice(0, 600).includes('reply_markup')
);
check('a photo card upgrade exists for cards that gain an image', tg.includes('upgraded the card to a photo card'));

// --- an out-of-stock product must never produce a price alert ----------------
const cron = fs.readFileSync(__dirname + '/api/cron.js', 'utf8');
check('the cron detects the out-of-stock state before alerting', cron.includes('outOfStockNow'));
check('a drop alert is gated on being in stock', /!outOfStockNow && pct != null && pct <= -DROP_THRESHOLD/.test(cron));
check('a rise alert is gated on being in stock', /!outOfStockNow && pct != null && pct >= INCREASE_THRESHOLD/.test(cron));
check('the alert carries a bold in-stock status line', cron.includes('STATUS: IN STOCK'));
check('the alert carries a bold out-of-stock status line', cron.includes('STATUS: OUT OF STOCK'));
check('the alert has a price-drop header', cron.includes('PRICE DROP ALERT'));
check('the alert has a back-in-stock header', cron.includes('BACK IN STOCK ALERT'));

const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
check('the stock check reads the whole page', /\$\('body'\)\.text\(\)\.replace\(\/\\s\+\/g, ' '\)\.toLowerCase\(\)/.test(scr));
check('the stock check treats "Notify Me" as out of stock', scr.includes("'notify me'"));
check('the rupee fallback skips exchange/EMI figures', scr.includes('firstRealPrice'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
