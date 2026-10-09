#!/usr/bin/env node
/**
 * scripts/clean-history.js
 * ---------------------------------------------------------------------------
 * Runs the one-off price-history repair from a terminal, for when you would
 * rather not hit the deployed app.
 *
 * It needs the same Firebase credentials the app uses (FIREBASE_SERVICE_ACCOUNT_KEY,
 * or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY), so the
 * easiest way to run it is with the same environment you deploy with.
 *
 *   node scripts/clean-history.js                 # dry run — reports only
 *   node scripts/clean-history.js --apply         # actually remove the readings
 *   node scripts/clean-history.js --apply --id=<docId>   # one product
 *
 * A dry run first is the point of the default: look at what it lists, and only
 * then re-run with --apply.
 * ---------------------------------------------------------------------------
 */

const { cleanHistory } = require('../lib/cleanHistory');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const productId = argValue('id') || undefined;

  console.log('');
  console.log(apply ? 'MODE: APPLY (readings will be deleted)' : 'MODE: DRY RUN (nothing will be deleted)');
  console.log('');

  const report = await cleanHistory({
    apply,
    productId,
    log: (line) => console.log('  ' + line),
  });

  console.log('');
  console.log('products scanned      : ' + report.scanned);
  console.log('products with bad data: ' + report.affected);
  console.log('readings to remove    : ' + report.removed);
  console.log('refused (too much)    : ' + report.refused);
  console.log('left untouched        : ' + report.untouched);
  if (apply) console.log('lastPrice re-pointed  : ' + report.lastPriceFixed);
  console.log('');

  if (!apply && report.removed > 0) {
    console.log('This was a dry run. Re-run with --apply to remove those ' + report.removed + ' readings.');
    console.log('');
  }
}

main().catch((err) => {
  console.error('');
  console.error('clean-history failed:', (err && err.message) || err);
  console.error('');
  process.exit(1);
});
