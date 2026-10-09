/**
 * test-wiring.js
 * ---------------------------------------------------------------------------
 * Loads the REAL api/telegram.js and exercises the functions the tracking path
 * depends on.
 *
 * Why this exists: the title rules were moved into lib/titles.js, but one of the
 * constants they need — PLACEHOLDER_SLUGS — was not added to the require in
 * api/telegram.js. Nothing caught it, because `node --check` only parses: the
 * failure was a ReferenceError at CALL time, inside titleFromUrl. Every link hit
 * it, the handler caught it, and the user saw "Something went wrong while
 * processing that link."
 *
 * A parse check cannot see that. Calling the functions can.
 *
 * If the dependencies are not installed the module cannot be loaded at all; that
 * is reported as a SKIP (loudly) rather than a failure, so this test is honest
 * about what it did and did not check.
 * ---------------------------------------------------------------------------
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

let telegram;
try {
  telegram = require('./api/telegram.js');
} catch (err) {
  const missingDep = err && /Cannot find module/.test(String(err.message));
  if (missingDep) {
    console.log('');
    console.log('SKIPPED: dependencies are not installed, so api/telegram.js cannot be');
    console.log('loaded and its functions cannot be called. Run `npm install` first.');
    console.log('Nothing was verified.');
    console.log('');
    process.exit(0);
  }
  console.log('api/telegram.js FAILED TO LOAD: ' + err.message);
  process.exit(1);
}

const I = telegram._internals || {};
check('the module exposes its internals for testing', Object.keys(I).length > 0);

// --- the functions the tracking path calls -----------------------------------
// A ReferenceError in any of these is invisible to a syntax check.
const calls = [
  ['titleFromUrl', () => I.titleFromUrl('https://www.flipkart.com/samsung-galaxy-m17-5g-mobile/p/itm123?pid=MOB1')],
  ['titleFromUrl (short link)', () => I.titleFromUrl('https://amzn.in/d/0iqccib1')],
  ['titleFromUrl (dp link)', () => I.titleFromUrl('https://www.amazon.in/dp/B0G81TPT89')],
  ['extractUrl', () => I.extractUrl('see https://amzn.in/d/0iqccib1 now')],
  ['cleanProductName', () => I.cleanProductName('Amazon.in: Samsung Galaxy M17 5G Mobile : Electronics')],
  ['isPlaceholderTitle', () => I.isPlaceholderTitle('B0G81TPT89', 'B0G81TPT89')],
  ['isErrorPageTitle', () => I.isErrorPageTitle('503 - Service Unavailable Error')],
  ['betterTitle', () => I.betterTitle('Samsung Galaxy M17 5G Mobile', null)],
  ['looksLikeMarketingCopy', () => I.looksLikeMarketingCopy('IQOO Prismatic Dimensity Processor OriginOS')],
  ['productDocId', () => I.productDocId({ marketplace: 'amazon', productId: 'B0G81TPT89' })],
  ['escapeHtml', () => I.escapeHtml('<b>x</b>')],
  ['isPlaceholderTitle (real)', () => I.isPlaceholderTitle('Samsung Galaxy M17 5G Mobile', 'B0G81TPT89')],
];
for (const [name, fn] of calls) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  check(name + ' runs without throwing' + (threw ? ' (' + threw.message + ')' : ''), !threw);
}

// --- the specific regression -------------------------------------------------
// PLACEHOLDER_SLUGS lived in api/telegram.js and moved to lib/titles.js. If it is
// not imported, this call throws — and that is exactly what broke every link.
{
  let threw = null;
  try {
    // titleFromUrl -> isPlaceholderSlug -> PLACEHOLDER_SLUGS
    I.titleFromUrl('https://www.flipkart.com/p/itm123');
  } catch (err) {
    threw = err;
  }
  check('the constant behind titleFromUrl is wired up', !threw);
}

// --- every constant lib/titles.js exports must be reachable ------------------
{
  const titles = require('./lib/titles');
  const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
  const names = Object.keys(titles).filter((n) => /^[A-Z]/.test(n));
  const unreachable = names.filter((n) => {
    // Used as a bare identifier somewhere in telegram.js, but not imported.
    const used = new RegExp('(^|[^\\w.$])' + n + '\\b(?!\\s*:)').test(src);
    const imported = new RegExp('\\b' + n + '\\b\\s*,').test(
      src.slice(src.indexOf("require('../lib/titles')") - 400, src.indexOf("require('../lib/titles')"))
    );
    return used && !imported;
  });
  check('every constant the bot uses is imported from lib/titles.js' +
    (unreachable.length ? ' (missing: ' + unreachable.join(', ') + ')' : ''), unreachable.length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
// Exit explicitly: requiring the network stack can trip the sandbox's
// WebAssembly memory limit during shutdown, which would mask the result.
process.exit(fail ? 1 : 0);
