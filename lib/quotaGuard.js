/**
 * lib/quotaGuard.js
 * ---------------------------------------------------------------------------
 * A circuit breaker for the Firestore free-tier quota.
 *
 * The problem it solves
 * ---------------------
 * When Firestore returns RESOURCE_EXHAUSTED (gRPC code 8), the official client
 * does not stop — it RETRIES, with backoff, through its own retry-request layer.
 * The stack trace in the live log is that layer at work:
 *
 *   at makeRequest (/app/node_modules/retry-request/index.js:159:28)
 *   code: 8, details: 'Quota exceeded.'
 *
 * Retrying a quota error is pure waste. The quota does not refill because we
 * asked twice; it refills at midnight Pacific. So every retry burns time, burns
 * the request budget further, and — worse — every OTHER call the bot makes in
 * that window also fails and also retries. A single exhausted quota turns into a
 * storm of doomed requests, and the user sees a bot that is completely down
 * rather than one that is merely out of budget until tomorrow.
 *
 * What it does
 * ------------
 * The first time a quota error is seen, the breaker opens for QUOTA_BREAK_MINUTES
 * (default 10). While it is open:
 *   - /list serves its last-known-good copy instead of querying;
 *   - the cron refuses to start, rather than reading and failing product by
 *     product;
 *   - the deals job skips its posted-check, which is what produced six
 *     "could not check whether X was posted" lines in one log.
 *
 * It is deliberately IN MEMORY and per process. Nothing about it is persisted,
 * because the whole point is to stop talking to the database.
 *
 * What it is NOT
 * --------------
 * It does not swallow the error or hide it. The caller still learns the call
 * failed and still logs it. It only stops us from repeating a request we already
 * know will fail.
 *
 * Configuration — environment variables only:
 *   QUOTA_BREAK_MINUTES   default 10, 0 disables the breaker entirely
 * ---------------------------------------------------------------------------
 */

const BREAK_MINUTES = Math.max(0, parseInt(process.env.QUOTA_BREAK_MINUTES || '10', 10));

let blockedUntil = 0;
let lastReason = null;
let tripCount = 0;

/** Is this error Firestore saying "you are out of quota"? */
function isQuotaError(err) {
  if (!err) return false;
  const code = err.code !== undefined ? err.code : err.status;
  if (code === 8 || code === '8') return true;
  const msg = String((err && err.message) || err);
  return /RESOURCE_EXHAUSTED|Quota exceeded|quota exceeded/i.test(msg);
}

/**
 * Note a Firestore failure. A quota error opens the breaker; anything else is
 * ignored here (the callers handle their own errors).
 *
 * Returns true when this call is what opened the breaker, so a caller can log
 * the transition once instead of once per failed product.
 */
function noteError(err) {
  if (!BREAK_MINUTES || !isQuotaError(err)) return false;
  lastReason = String((err && err.message) || err).slice(0, 200);
  const now = Date.now();
  if (now < blockedUntil) return false; // already open, not a new trip
  blockedUntil = now + BREAK_MINUTES * 60 * 1000;
  tripCount++;
  console.warn(
    'quota guard: Firestore is out of quota — pausing database work for ' +
      BREAK_MINUTES + ' minute(s). The quota refills on its own; retrying now only ' +
      'wastes the remaining budget. (' + lastReason + ')'
  );
  return true;
}

/** Is the breaker open right now? */
function isBlocked() {
  if (!BREAK_MINUTES) return false;
  return Date.now() < blockedUntil;
}

/** Seconds until it closes, for a message the user can act on. 0 when open. */
function secondsRemaining() {
  if (!isBlocked()) return 0;
  return Math.ceil((blockedUntil - Date.now()) / 1000);
}

/** For tests and /diag. */
function status() {
  return {
    enabled: BREAK_MINUTES > 0,
    breakMinutes: BREAK_MINUTES,
    blocked: isBlocked(),
    secondsRemaining: secondsRemaining(),
    trips: tripCount,
    lastReason,
  };
}

/**
 * A running tally of the database operations THIS process has made.
 *
 * The spec sheets ask for "Firebase usage metrics". I cannot read your Firebase
 * console — I have no access to it — but the bot can count its own calls, and
 * that is the number that matters: it tells you which job is spending the quota,
 * broken down by what did it. If reads-per-hour is far higher than the schedule
 * explains, you are running more than one instance.
 *
 * Counts are per process and reset on redeploy, which is also useful: a restart
 * that immediately shows a large total means the load is not a slow leak.
 */
const TALLY = Object.create(null);

function count(op, n) {
  const key = String(op || 'other');
  TALLY[key] = (TALLY[key] || 0) + (n === undefined ? 1 : n);
}

/** A copy, sorted by size, for /diag. */
function tally() {
  const out = {};
  let total = 0;
  for (const k of Object.keys(TALLY).sort((a, b) => TALLY[b] - TALLY[a])) {
    out[k] = TALLY[k];
    total += TALLY[k];
  }
  return { total, byOp: out };
}

function resetTally() {
  for (const k of Object.keys(TALLY)) delete TALLY[k];
}

/** For tests only. */
function reset() {
  blockedUntil = 0;
  lastReason = null;
  tripCount = 0;
}

module.exports = {
  count,
  tally,
  resetTally,
  isQuotaError,
  noteError,
  isBlocked,
  secondsRemaining,
  status,
  reset,
};
