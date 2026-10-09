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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
