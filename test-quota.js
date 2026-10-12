/**
 * test-quota.js
 * ---------------------------------------------------------------------------
 * The quota breaker. Firestore RETRIES RESOURCE_EXHAUSTED (its retry-request
 * layer is visible in the live log), which is pure waste — the quota refills at
 * midnight Pacific, not because we asked twice. These checks cover the breaker
 * that stops the retry storm, and that it can be turned off.
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const g = require('./lib/quotaGuard.js');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// The error shape the live log showed.
const quotaErr = Object.assign(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.'), { code: 8, details: 'Quota exceeded.' });
const permErr = Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 });
const netErr = new Error('socket hang up');

g.reset();
check('a code-8 error is recognised as a quota error', g.isQuotaError(quotaErr));
check('...by message too, when the code is absent', g.isQuotaError(new Error('RESOURCE_EXHAUSTED: Quota exceeded.')));
check('permission-denied is NOT a quota error', !g.isQuotaError(permErr));
check('a network error is NOT a quota error', !g.isQuotaError(netErr));
check('nothing is blocked to begin with', !g.isBlocked());

check('a quota error trips the breaker', g.noteError(quotaErr) === true);
check('...and the breaker is now open', g.isBlocked());
check('...with a sensible countdown', g.secondsRemaining() > 0 && g.secondsRemaining() <= 10 * 60);
check('...and it reports how many times it has tripped', g.status().trips === 1);
check('...and it keeps the reason for the log', /Quota exceeded/.test(g.status().lastReason || ''));

check('a second quota error does not re-trip it', g.noteError(quotaErr) === false);
check('...and the trip count stays at one', g.status().trips === 1);

check('a NON-quota error does not trip the breaker', g.noteError(netErr) === false);
check('...and does not extend it either', g.status().trips === 1);

// A permission error must NOT be retried away by the breaker — it is a config
// problem, and blocking database work would hide it behind a "limit reached"
// message, which is exactly the confusion we are trying to remove.
check('a permission error leaves the breaker alone', !g.isQuotaError(permErr));

g.reset();
check('reset clears the breaker', !g.isBlocked() && g.status().trips === 0);

// The wiring: both entry points must consult it, and /list must have a
// last-known-good copy to fall back on rather than a bare apology.
const tg = fs.readFileSync(path.join(__dirname, 'api/telegram.js'), 'utf8');
const cron = fs.readFileSync(path.join(__dirname, 'api/cron.js'), 'utf8');
check('the bot uses the shared quota guard', /require\('\.\.\/lib\/quotaGuard'\)/.test(tg));
check('...for one definition of a quota error', /return quotaGuard\.isQuotaError\(err\);/.test(tg));
check('/list checks the breaker before querying', /if \(quotaGuard\.isBlocked\(\)\) \{/.test(tg));
check('...and serves the saved copy instead', /Last saved copy — the database is at its limit/.test(tg));
check('the cron refuses to run while the breaker is open', /quota_guard_open/.test(cron));
check('...and stops early once it trips mid-run', /stopping this run early instead of failing through the rest/.test(cron));
check('a failed /list reports to the breaker', /quotaGuard\.noteError\(err\);\s*\n\s*console\.error\('sendTrackingList failed'/.test(tg));

// The tally: what the process itself has asked the database for.
g.resetTally();
check('the tally starts empty', g.tally().total === 0);
g.count('cron:scan');
g.count('cron:product', 3);
check('...and counts by operation', g.tally().total === 4);
check('...keeping the breakdown', g.tally().byOp['cron:product'] === 3);
g.resetTally();
check('...and can be reset', g.tally().total === 0);

check('/diag reports the quota breaker', /breaker: /.test(tg) && /quotaGuard\.status\(\)/.test(tg));
check('...and the per-process operation tally', /operations this process: /.test(tg) && /quotaGuard\.tally\(\)/.test(tg));
check('the cron counts its scan', /quotaGuard\.count\('cron:scan'\)/.test(cron));
check('...and each product it checks', /quotaGuard\.count\('cron:product'\)/.test(cron));
check('/list counts its own read', /quotaGuard\.count\('list:read'\)/.test(tg));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
