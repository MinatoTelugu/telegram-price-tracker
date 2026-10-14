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
// Look at the whole enrichment function, so the check survives the calls being
// reformatted across lines.
const enrichStart = tg.indexOf('async function enrichTracked');
const enrich = tg.slice(enrichStart, tg.indexOf('\n}', enrichStart));
check('the enrichment edits the card',
  enrich.includes('editMessageText') || enrich.includes('editMessageCaption'));
check(
  'and passes reply_markup, so the buttons survive the edit',
  enrich.includes('reply_markup: keyboard.reply_markup')
);
check('a photo card is edited through its caption, which is the only way that works',
  enrich.includes('editMessageCaption'));
check('a photo card upgrade exists for cards that gain an image', tg.includes('upgraded the card to a photo card'));

// --- an out-of-stock product must never produce a price alert ----------------
const cron = fs.readFileSync(__dirname + '/api/cron.js', 'utf8');
check('the cron detects the out-of-stock state before alerting', cron.includes('outOfStockNow'));
check('a drop alert is gated on being in stock', /!outOfStockNow && pct != null && pct <= -DROP_THRESHOLD/.test(cron));
// A rise is NOT gated on stock: gating both meant an out-of-stock item produced
// no alerts of any kind, which is indistinguishable from the bot being broken.
check('a rise alert is NOT gated on stock state',
  /pct != null && pct >= INCREASE_THRESHOLD/.test(cron) &&
    !/!outOfStockNow && pct != null && pct >= INCREASE_THRESHOLD/.test(cron));
check('a drop alert IS still gated on stock state',
  /!outOfStockNow && pct != null && pct <= -DROP_THRESHOLD/.test(cron));
// The status is no longer a separate "STATUS: IN STOCK" line. The dot IS the
// status, and the header says what happened — so the two can never disagree.
check('the dot is green in stock and red out of stock',
  /inStock \? '🟢' : '🔴'/.test(cron));
check('the header is chosen from the event, not hardcoded',
  /restock: 'BACK IN STOCK ALERT'/.test(cron) && /outofstock: 'OUT OF STOCK ALERT'/.test(cron));
check('a product going out of stock raises its own alert',
  /!wasOutOfStock && result\.inStock === false/.test(cron));
// ...but only when the product was actually READ. The reported alert went out for
// an item Amazon showed at ₹22,499 In stock, and it carried no price at all.
check('the out-of-stock alert is gated on a real reading',
  /const readReliably = result\.price != null && !result\.guess/.test(cron));
check('...and a stock state with no price is refused, with a log line',
  /suppressing an OUT OF STOCK alert/.test(cron));
check('the scraper no longer decides stock from a whole-page scan', (() => {
  const src = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
  const body = src.slice(src.indexOf('function detectOutOfStock'), src.indexOf('function priceFromTextMatch'));
  return !/\$\('body'\)\.text\(\)/.test(body) && /return false;/.test(body);
})());
// The card layout replaced the blockquote layout. The user asked for a design
// modelled on a rendered card: a header, the store, the product, a price row and
// a closing line — and sent as a PHOTO so the image carries it.
check('the alert is a card, not a blockquote list',
  /<b>' \+ \(HEAD\[kind\]/.test(cron) && !/const line = \(text\) => '<blockquote>'/.test(cron));
check('...with the store named', /market\) parts\.push/.test(cron) && /\uD83D\uDECD/.test(JSON.parse('"\ud83d\udecd"')));
check('...and a You Save row', /You Save/.test(cron));
check('...and a closing line', /Grab this deal before it/.test(cron));
check('...sent as a PHOTO when the product has an image', /sendPhoto/.test(cron));
check('...falling back to text if the photo is refused', /sending the card as text instead/.test(cron));
check('the buy button names the store', /Buy on ' \+ store/.test(cron));
check('an identical alert is suppressed inside a cooldown window',
  /ALERT_COOLDOWN_MINUTES/.test(cron) && /suppressing a repeat alert/.test(cron));
check('...and the cooldown remembers what was sent',
  /lastAlertKey: alertIdentity\(message\)/.test(cron));
check('the alert has a price-drop header', cron.includes('PRICE DROP ALERT'));
check('the alert has a back-in-stock header', cron.includes('BACK IN STOCK ALERT'));

const scr = fs.readFileSync(__dirname + '/lib/scraper.js', 'utf8');
// The whole-page stock scan was REMOVED — a variant row saying "Currently\n// unavailable" marked the whole listing out of stock. That was the reported bug.\ncheck('the stock check does NOT read the whole page', !/\$\('body'\)\.text\(\)/.test(scr));\ncheck('the stock check is decided by the buy box', /#availability/.test(scr) && /buyboxSaysOut/.test(scr));
check('the stock check treats "Notify Me" as out of stock', scr.includes("'notify me'"));
check('the rupee fallback skips exchange/EMI figures', scr.includes('firstRealPrice'));

// ---------------------------------------------------------------------------
// PRICE_CRON was hourly on the deployment. tooFrequent() only read the MINUTE
// field, so "0 * * * *" had minute "0", looked fine, and ran 24x/day until the
// Firestore quota was gone. The hour field is where "hourly" lives. It is read
// now, and an over-frequent schedule is clamped rather than merely warned about.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const grab = (n) => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) return null;
    let d = 0, j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return null;
  };
  const parts = ['minIntervalHours', 'tooFrequent', 'enforceMinInterval'].map(grab);
  check('the cron interval parser exists', parts.every(Boolean));
  eval(parts.map((p) => p.replace(/^function (\w+)/, 'var $1 = function')).join('\n'));

  check('hourly is recognised as too frequent', tooFrequent('0 * * * *', 4));
  check('every-2-hours is too frequent at a 4h floor', tooFrequent('0 */2 * * *', 4));
  check('every-6-hours is not', !tooFrequent('0 */6 * * *', 4));
  check('once a day is not', !tooFrequent('0 3 * * *', 4));
  check('hourly clamps to 4-hourly', enforceMinInterval('0 * * * *', 4) === '0 */4 * * *');
  check('2-hourly clamps to 4-hourly', enforceMinInterval('0 */2 * * *', 4) === '0 */4 * * *');
  check('6-hourly is left alone', enforceMinInterval('0 */6 * * *', 4) === '0 */6 * * *');
  check('a twice-daily schedule is left alone', enforceMinInterval('0 9,21 * * *', 4) === '0 9,21 * * *');
  check('the clamp is applied at startup', /enforceMinInterval\(process\.env\.PRICE_CRON/.test(src));
  check('...and at both places the cron is read', (src.match(/enforceMinInterval\(process\.env\.PRICE_CRON/g) || []).length === 2);
}


// ---------------------------------------------------------------------------
// From the live log: "Polling conflict: ANOTHER copy of this bot is polling".
// Stopping the timers is not enough — a tick already in flight, or the startup
// call racing the conflict check, would still run the whole job.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  check('runJob refuses while this instance does not own the poll',
    /async function runJob\(name\) \{[\s\S]{0,400}if \(jobsPaused\) \{/.test(src));
  check('...and says so rather than failing quietly', /skipped \(this instance does not own the poll\)/.test(src));
}

// ---------------------------------------------------------------------------
// STARVATION. From the real /diag: "operations this process: 2" (only
// list:read), no cron:scan at all, last price check the previous evening. The
// quota was fine — the job was never run, because Telegram can hand the 409 to
// both instances in turn and then BOTH stand down. A paused instance must still
// run a schedule that has clearly been starved.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
  check('the starved-schedule escape exists', /STARVATION ESCAPE/.test(src));
  check('...and a paused instance can still run a starved job', /const starved =/.test(src));
  check('...after three missed intervals', /3 \* PRICE_INTERVAL_MS/.test(src));
  check('...and says so loudly', /BOTH instances are paused/.test(src));
  check('the interval is derived from the schedule', /const PRICE_INTERVAL_MS =/.test(src));
  check('...and the price job records when it last ran', /if \(name === 'cron'\) lastPriceJobAt = Date.now\(\)/.test(src));
  check('an ordinary paused skip still happens', /does not own the poll/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);