/**
 * lib/cleanHistory.js
 * ---------------------------------------------------------------------------
 * A one-off repair for price history polluted by a bad scrape.
 *
 * A product page is full of rupee figures that are NOT the product's price —
 * exchange offers, EMI instalments, cashback, coupon lines, sponsored rows. The
 * scraper once took the first one it met, and a ₹19,999 phone was recorded at
 * ₹10,490. The scraper is fixed, so no NEW bad points appear — but the old ones
 * are still in Firestore, and the web page derives its chart, its "Lowest" and
 * its "Average" straight from them. That is why the price-history page still
 * showed ₹10,490.
 *
 * This module removes those points, so the chart and the stats correct
 * themselves on the next page load (the page computes them client-side — there
 * is no cached figure to invalidate).
 *
 * ---------------------------------------------------------------------------
 * How a bad point is recognised
 * ---------------------------------------------------------------------------
 * Not "any low price" — a genuine price drop is low too, and must survive. The
 * signature of a bad scrape is that it is low AND IT DOES NOT LAST:
 *
 *     ... 19999, 19999, [10490], 19999, 19999 ...
 *            ^ a real drop stays down; this one is back up by the next check
 *
 * So a point is dropped only when BOTH hold:
 *   1. it sits far below the product's own median (default: under 60% of it), and
 *   2. the nearest readings on each side are well ABOVE it (default: 25% higher).
 *
 * The scan repeats, so a run of consecutive bad points is removed together.
 *
 * Safety rails, because this deletes data:
 *   - DRY RUN by default. Nothing is written unless apply is true.
 *   - A product with fewer than CLEAN_MIN_POINTS readings is left alone: there
 *     is no median worth trusting.
 *   - If a product would lose more than CLEAN_MAX_FRACTION of its readings,
 *     that is not an outlier problem — it is refused and reported instead.
 *   - Only the flagged history documents are deleted; the product document is
 *     touched solely to re-point lastPrice at the newest surviving reading.
 * ---------------------------------------------------------------------------
 */

const LOW_RATIO = parseFloat(process.env.CLEAN_LOW_RATIO || '0.6');
// How far the price must BOUNCE BACK above the low reading to count as a misread.
// A real deal that ends rises a little (₹13,999 -> ₹19,999 is 1.43x); a misread
// snaps back enormously (₹10,490 -> ₹19,999 is 1.91x). 1.5 sits between them, so
// a deal ending is left alone while the exchange-offer figure is removed.
const RECOVER_RATIO = parseFloat(process.env.CLEAN_RECOVER_RATIO || '1.5');
const MIN_POINTS = parseInt(process.env.CLEAN_MIN_POINTS || '5', 10);
const MAX_FRACTION = parseFloat(process.env.CLEAN_MAX_FRACTION || '0.5');
const MAX_PASSES = 5;
// A low price holding for longer than this many consecutive readings (6 hours at
// a 30-minute check) is a real drop. It is deliberately generous: the bad scrape
// repeats the same wrong figure every run, so its run is long too.
const MAX_RUN = parseInt(process.env.CLEAN_MAX_RUN || '12', 10);
const BATCH_LIMIT = 450; // Firestore caps a batch at 500 writes

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function tsOf(point) {
  const c = point.checkedAt;
  if (!c) return 0;
  if (typeof c.toMillis === 'function') return c.toMillis();
  if (c.seconds != null) return c.seconds * 1000;
  const d = new Date(c);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Pick the points to drop from one product's readings.
 *
 * `points` is [{ id, price, checkedAt }] in any order. Returns the ids to drop,
 * in the order they should be reported.
 */
function findBadPoints(points, opts) {
  const lowRatio = (opts && opts.lowRatio) || LOW_RATIO;
  const recoverRatio = (opts && opts.recoverRatio) || RECOVER_RATIO;
  const minPoints = (opts && opts.minPoints) || MIN_POINTS;
  const maxFraction = (opts && opts.maxFraction) || MAX_FRACTION;

  const readings = points
    .filter((p) => typeof p.price === 'number' && isFinite(p.price) && p.price > 0)
    .sort((a, b) => tsOf(a) - tsOf(b));

  // Explicit override: remove every reading at or below a price you name. This
  // needs no heuristics, so it is the reliable route when you already know the
  // figure is wrong (see --max / &max=).
  const maxPrice = opts && opts.maxPrice;
  if (typeof maxPrice === 'number' && isFinite(maxPrice)) {
    const hits = readings.filter((p) => p.price <= maxPrice);
    if (!hits.length) return { drop: [], reason: 'no readings at or below ₹' + maxPrice };
    return {
      drop: hits.map((p) => p.id),
      dropped: hits,
      reason: null,
      explicit: true,
    };
  }

  if (readings.length < minPoints) {
    return { drop: [], reason: 'too few readings to judge (' + readings.length + ')' };
  }

  // The floor is anchored to the HIGH side of the distribution, not the plain
  // median: when the bad price was recorded several times in a row it drags a
  // plain median down with it, the floor sinks to meet it, and the bad readings
  // pass their own test. The high readings are not contaminated that way.
  const prices = readings.map((p) => p.price);
  const med = median(prices);
  const highPrices = prices.filter((n) => n > med);
  const reference = highPrices.length ? median(highPrices) : med;
  const floor = reference * lowRatio;

  // A point survives or it does not; the flag is recomputed each pass against
  // the points that are still standing, so a RUN of bad readings goes together.
  let alive = readings.slice();
  const dropped = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // 1. Candidates: readings far below the high-anchored floor.
    const isCand = alive.map((p) => p.price < floor);

    // 2. Group CONSECUTIVE candidates into runs. Judging each reading on its
    //    own immediate neighbours was wrong: inside a run of bad readings they
    //    see each other, conclude the price never bounced back, and survive.
    const runs = [];
    for (let i = 0; i < alive.length; ) {
      if (!isCand[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < alive.length && isCand[j + 1]) j++;
      runs.push([i, j]);
      i = j + 1;
    }

    // 3. A run is a scrape artifact only when the readings on BOTH sides come
    //    back well above it AND the run is short. A low price that HOLDS across
    //    many readings is a real drop, and is left alone.
    const doomed = [];
    for (const pair of runs) {
      const a = pair[0];
      const b = pair[1];
      const runMax = Math.max.apply(null, alive.slice(a, b + 1).map((p) => p.price));
      const before = alive[a - 1];
      const after = alive[b + 1];
      const recoveredBefore = !before || before.price >= runMax * recoverRatio;
      const recoveredAfter = !after || after.price >= runMax * recoverRatio;
      const shortEnough = b - a + 1 <= MAX_RUN;
      if (recoveredBefore && recoveredAfter && shortEnough) {
        for (let k = a; k <= b; k++) doomed.push(alive[k]);
      }
    }

    if (!doomed.length) break;
    const ids = new Set(doomed.map((p) => p.id));
    dropped.push(...doomed);
    alive = alive.filter((p) => !ids.has(p.id));
  }

  if (!dropped.length) {
    // Say what was looked at and kept. A run that is left in place because it is
    // LONG (a possible real drop) is the interesting case.
    const keptLow = alive.filter((p) => p.price < floor);
    if (keptLow.length) {
      return {
        drop: [],
        reason:
          'nothing removed: ' + keptLow.length + ' low reading(s) were kept, ' +
          'most likely a real drop (a low price holding for more than ' + MAX_RUN +
          ' readings, or a recovery too small to be a misread)',
        kept: keptLow.map((p) => p.price),
      };
    }
    return { drop: [], reason: 'nothing failed the check' };
  }

  if (dropped.length > readings.length * maxFraction) {
    return {
      drop: [],
      reason:
        'refused: ' + dropped.length + ' of ' + readings.length +
        ' readings would go (> ' + Math.round(maxFraction * 100) + '% of the history)',
    };
  }

  return { drop: dropped.map((p) => p.id), reason: null, dropped };
}

/**
 * Walk every product (or one product) and remove the readings that fail the
 * check. Returns a report; writes nothing unless `apply` is true.
 */
async function cleanHistory(options) {
  const opts = options || {};
  const apply = opts.apply === true;
  const fb = opts.fb || require('./firebase');
  const db = fb.db;
  const admin = fb.admin;
  const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
  const PRODUCTS = (fb.COLLECTIONS && fb.COLLECTIONS.PRODUCTS) || 'products';
  const HISTORY = (fb.COLLECTIONS && fb.COLLECTIONS.PRICE_HISTORY) || 'price_history';
  const log = opts.log || (() => {});

  if (!db) throw new Error('Firestore is not initialised');

  // Which products? All of them, or the one asked for.
  let docs = [];
  if (opts.productId) {
    const one = await db.collection(PRODUCTS).doc(String(opts.productId)).get();
    if (one.exists) docs = [one];
  } else {
    // A cap, so a big collection cannot run the request out of time. Callers
    // can page with `startAfter` if they ever need to.
    const limit = parseInt(opts.limit || '300', 10);
    const snap = await db.collection(PRODUCTS).limit(limit).get();
    docs = snap.docs;
  }

  const report = {
    apply,
    scanned: 0,
    affected: 0,
    removed: 0,
    refused: 0,
    kept: 0,
    untouched: 0,
    lastPriceFixed: 0,
    products: [],
  };

  for (const doc of docs) {
    report.scanned++;
    const d = doc.data() || {};
    const name = d.title || d.productId || doc.id;

    let histSnap;
    try {
      histSnap = await doc.ref.collection(HISTORY).orderBy('checkedAt', 'asc').get();
    } catch (err) {
      // A missing index, or a reading with no checkedAt — fall back to a plain
      // read rather than skipping the product entirely.
      histSnap = await doc.ref.collection(HISTORY).get();
    }

    const points = histSnap.docs.map((h) => {
      const hd = h.data() || {};
      return { id: h.id, ref: h.ref, price: hd.price, checkedAt: hd.checkedAt };
    });

    const verdict = findBadPoints(points, Object.assign({}, opts, { maxPrice: opts.maxPrice }));
    if (!verdict.drop.length) {
      report.untouched++;
      if (verdict.reason && verdict.reason.startsWith('refused')) {
        report.refused++;
        report.products.push({ id: doc.id, name, status: 'refused', reason: verdict.reason });
        log('REFUSED  ' + name + ' — ' + verdict.reason);
      } else if (verdict.kept && verdict.kept.length) {
        report.kept++;
        report.products.push({
          id: doc.id,
          name,
          status: 'kept',
          reason: verdict.reason,
          keptPrices: verdict.kept,
        });
        log('KEPT     ' + name + ' — ' + verdict.reason + ' (₹' + verdict.kept.join(', ₹') + ')');
      }
      continue;
    }

    report.affected++;
    report.removed += verdict.drop.length;

    const dropSet = new Set(verdict.drop);
    const survivors = points
      .filter((p) => !dropSet.has(p.id) && typeof p.price === 'number')
      .sort((a, b) => tsOf(a) - tsOf(b));
    const newest = survivors.length ? survivors[survivors.length - 1] : null;

    // The page shows "CURRENT PRICE" from the product document, so if the newest
    // reading was itself a bad one, re-point it at the newest survivor.
    const needsLastPriceFix =
      newest && typeof d.lastPrice === 'number' && d.lastPrice !== newest.price;

    report.products.push({
      id: doc.id,
      name,
      status: apply ? 'cleaned' : 'would clean',
      removed: verdict.drop.length,
      kept: survivors.length,
      median: median(points.map((p) => p.price).filter((n) => typeof n === 'number')),
      droppedPrices: verdict.dropped ? verdict.dropped.map((p) => p.price) : [],
      lastPriceFrom: typeof d.lastPrice === 'number' ? d.lastPrice : null,
      lastPriceTo: needsLastPriceFix ? newest.price : null,
    });

    log(
      (apply ? 'CLEAN    ' : 'WOULD    ') + name + ' — drop ' + verdict.drop.length +
        ' of ' + points.length + ' readings' +
        (needsLastPriceFix ? ', lastPrice ' + d.lastPrice + ' -> ' + newest.price : '')
    );

    if (!apply) continue;

    // Delete in batches, and fix lastPrice in the same batch where we can.
    const refs = points.filter((p) => dropSet.has(p.id)).map((p) => p.ref);
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      refs.slice(i, i + BATCH_LIMIT).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    if (needsLastPriceFix) {
      const update = { lastPrice: newest.price, updatedAt: FieldValue ? FieldValue.serverTimestamp() : new Date() };
      await doc.ref.set(update, { merge: true });
      report.lastPriceFixed++;
    }
  }

  return report;
}

module.exports = { cleanHistory, findBadPoints, median };
