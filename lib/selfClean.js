/**
 * lib/selfClean.js
 * ---------------------------------------------------------------------------
 * Self-correction for a single product's price history, run automatically
 * right after a TRUSTED price reading is recorded.
 *
 * The problem this solves
 * ---------------------------------------------------------------------------
 * lib/cleanHistory.js is a good repair, but it ran once a day, over the whole
 * collection, and only knew what the distribution and the MRP told it. A bad
 * reading therefore sat on the chart — dragging the "Lowest", the "Average" and
 * the 30-day range — until the next nightly pass, and asking the owner to clean
 * products one URL at a time was never realistic.
 *
 * So the correction now happens per product, the moment we have something
 * trustworthy to correct AGAINST:
 *
 *   "a newly fetched price is validated as correct (MRP/labelled anchored)"
 *
 * That is exactly the trigger. When the scraper reports a price it can stand
 * behind — a labelled price, a price anchored on the M.R.P., or the hosted API's
 * buybox — this pass re-reads that product's history and removes what the
 * trusted figure contradicts.
 *
 * What is removed, and why each rule is safe
 * ---------------------------------------------------------------------------
 *  1. IMPOSSIBLE readings. Above the MRP, or below 40% of it. A selling price
 *     above the M.R.P. is not a selling price, and an EMI instalment is well
 *     under 40% of it. No comparison with the rest of the history is involved,
 *     so these go even when the whole history is wrong.
 *
 *  2. TRANSIENT excursions. A reading far from the trusted price whose
 *     neighbours come back towards it. A real price that moves STAYS moved; a
 *     scrape artifact is there and gone. This is the same reasoning as
 *     cleanHistory's run test, with the trusted price as the reference instead
 *     of a median that the bad readings themselves can drag around.
 *
 *  3. A SHIFTED SERIES. A whole run sitting away from the trusted price, with
 *     the readings before and after it back at the trusted level. The run has to
 *     be a genuine excursion — bracketed on both sides — so a price that
 *     legitimately stepped and stayed is left alone.
 *
 * What is NOT removed
 * ---------------------------------------------------------------------------
 * A history that is uniformly wrong at a PLAUSIBLE level. If every reading ever
 * taken was the wrong figure but that figure is a believable price for the
 * product, the numbers themselves carry no evidence of the error, and no rule
 * can tell it from a real price that simply moved. Deleting such a history would
 * be guesswork dressed up as automation. Those readings age out of the 30-day
 * window on their own, and the nightly pass keeps looking at them.
 *
 * Safety rails, because this deletes data without a human in the loop
 * ---------------------------------------------------------------------------
 *  - Only runs when the reading is trusted. A guess never triggers it.
 *  - Never touches the newest reading.
 *  - Leaves a product with fewer than SELF_CLEAN_MIN_POINTS readings alone.
 *  - Refuses to remove more than SELF_CLEAN_MAX_FRACTION of a history in one
 *    pass, and reports that instead of doing it. Impossible readings are exempt
 *    from the cap, since they are wrong on their own terms.
 *  - Every removal is logged with the reason.
 *  - Failure is swallowed by the caller: a cleaning pass must never be able to
 *    break a price check.
 * ---------------------------------------------------------------------------
 */

const { findBadPoints } = require('./cleanHistory');

// How far a reading may sit from the trusted price before it is a candidate.
// Generous on purpose: a real price moves by a few percent all the time, and
// only a clear excursion is worth acting on.
const BAND = parseFloat(process.env.SELF_CLEAN_BAND_PERCENT || '30') / 100;
// A reading this far from the trusted price is not an excursion, it is a
// different product's figure — an instalment, a case, a variant.
const CERTAIN_BAND = parseFloat(process.env.SELF_CLEAN_CERTAIN_PERCENT || '55') / 100;
const MIN_POINTS = parseInt(process.env.SELF_CLEAN_MIN_POINTS || '5', 10);
const MAX_FRACTION = parseFloat(process.env.SELF_CLEAN_MAX_FRACTION || '0.5');
// A run longer than this is treated as a real price and kept, however far from
// the trusted price it sits. Real prices do step and hold.
const MAX_RUN = parseInt(process.env.SELF_CLEAN_MAX_RUN || '20', 10);
const MRP_FLOOR = 0.4;
const MRP_CEILING = 1.02;

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
}

/**
 * Decide what to remove from one product's history.
 *
 * Exported so it can be tested without Firestore, and so the same judgement can
 * be applied to a history that has not been written yet.
 *
 * @param {Array<{id: string, price: number, t?: number, checkedAt?: *}>} points
 * @param {{trustedPrice?: number, mrp?: number}} opts
 * @returns {{drop: Array, dropped: Array, reason: string|null, certain: boolean}}
 */
function findSelfCleanPoints(points, opts) {
  const o = opts || {};
  const trusted = num(o.trustedPrice);
  const mrp = num(o.mrp);

  const readings = (points || [])
    .filter((p) => num(p.price) != null)
    .slice()
    .sort((a, b) => tsOf(a) - tsOf(b));

  if (readings.length < MIN_POINTS) {
    return { drop: [], dropped: [], reason: 'too few readings to judge (' + readings.length + ')', certain: false };
  }

  // -------------------------------------------------------------------------
  // 1. Impossible readings — wrong on their own terms, so never capped.
  // -------------------------------------------------------------------------
  const certain = readings.filter((p) => {
    if (mrp == null) return false;
    return p.price > mrp * MRP_CEILING || p.price < mrp * MRP_FLOOR;
  });

  // -------------------------------------------------------------------------
  // 2 + 3. Excursions away from the trusted price.
  // -------------------------------------------------------------------------
  const candidates = [];
  if (trusted != null) {
    const near = trusted * (1 - BAND);
    const far = trusted * (1 - CERTAIN_BAND);
    const above = trusted * (1 + BAND);

    for (const p of readings) {
      if (p.price >= near && p.price <= above) continue; // inside the band, fine
      candidates.push({ point: p, certain: p.price < far || p.price > trusted * (1 + CERTAIN_BAND) });
    }
  }

  // Group candidates into consecutive runs, then judge each run as a whole.
  // Judging a reading on its own immediate neighbours was wrong: inside a run of
  // bad readings they see each other and conclude nothing bounced back.
  const indexOf = new Map();
  readings.forEach((p, i) => indexOf.set(p, i));

  const runs = [];
  for (const c of candidates) {
    const i = indexOf.get(c.point);
    const last = runs[runs.length - 1];
    if (last && i === last.end + 1) {
      last.end = i;
      last.items.push(c);
    } else {
      runs.push({ start: i, end: i, items: [c] });
    }
  }

  const doomed = [];
  for (const run of runs) {
    // A reading that is a different product's figure outright goes regardless of
    // how long it sat there — it was never a price for this product.
    if (run.items.every((c) => c.certain)) {
      doomed.push(...run.items.map((c) => c.point));
      continue;
    }
    // Otherwise the run must be BRACKETED: readings back at the trusted level on
    // BOTH sides of it, and short. That is the signature of a series that went
    // away and came back — it was never this product's price.
    //
    // A run at the START or the END of the history is deliberately kept. There,
    // nothing shows that it came back, and "the price stepped down and stayed
    // down" looks exactly the same as "the old readings were wrong". Choosing
    // between those two would be a guess, and a guess that deletes real history
    // is worse than one that leaves a bad reading for the nightly pass.
    if (run.end - run.start + 1 > MAX_RUN) continue;
    const before = readings[run.start - 1];
    const after = readings[run.end + 1];
    if (!before || !after) continue;
    const inside = (p) => p && Math.abs(p.price - trusted) <= trusted * BAND;
    if (!inside(before) || !inside(after)) continue;
    doomed.push(...run.items.map((c) => c.point));
  }

  const seen = new Set();
  const dropped = [];
  for (const p of [...certain, ...doomed]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    dropped.push(p);
  }

  if (!dropped.length) {
    return {
      drop: [],
      dropped: [],
      reason: trusted != null ? 'nothing contradicts the trusted price of ' + trusted : 'nothing failed the check',
      certain: false,
    };
  }

  // The newest reading is the one we just recorded. It is never removed, whatever
  // a rule says about it — and if a rule wants it gone, the rule is wrong.
  const newest = readings[readings.length - 1];
  const finalDropped = dropped.filter((p) => p.id !== newest.id);

  if (!finalDropped.length) {
    return { drop: [], dropped: [], reason: 'only the newest reading was flagged; kept', certain: false };
  }

  // The fraction guard. Impossible readings are exempt: they are wrong on their
  // own terms, and for a history where EVERY reading is the wrong figure the cap
  // would refuse to touch any of it.
  const certainIds = new Set(certain.map((p) => p.id));
  const capped = finalDropped.filter((p) => certainIds.has(p.id));
  const optional = finalDropped.filter((p) => !certainIds.has(p.id));
  const room = readings.length * MAX_FRACTION - capped.length;
  const keptOptional = optional.length > room ? optional.slice(room) : [];
  const useOptional = optional.length > room ? optional.slice(0, Math.max(0, Math.floor(room))) : optional;
  const final = [...capped, ...useOptional];

  if (!final.length) {
    return {
      drop: [],
      dropped: [],
      reason: 'would remove more than ' + Math.round(MAX_FRACTION * 100) + '% of the history; refused',
      certain: false,
    };
  }

  return {
    drop: final.map((p) => p.id),
    dropped: final,
    reason: null,
    certain: capped.length === final.length && final.length > 0,
    heldBack: keptOptional.length,
  };
}

/** Firestore Timestamp | Date | seconds | millis -> millis. */
function tsOf(point) {
  if (!point) return 0;
  const t = point.t != null ? point.t : point.checkedAt;
  if (t == null) return 0;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  const d = new Date(t);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Run the pass for one product. Deletes what the trusted price contradicts and
 * re-points lastPrice at the newest surviving reading.
 *
 * Never throws: the caller is a price check, and a cleaning failure must not
 * take it down.
 *
 * @returns {Promise<object|null>} a report, or null when there was nothing to do
 */
async function selfCleanProduct(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const productId = o.productId;
  if (!productId) return null;

  try {
    const fb = o.fb || require('./firebase');
    const db = fb.db;
    if (!db) return null;
    const admin = fb.admin;
    const FieldValue = admin && admin.firestore && admin.firestore.FieldValue;
    const PRODUCTS = (fb.COLLECTIONS && fb.COLLECTIONS.PRODUCTS) || 'products';
    const HISTORY = (fb.COLLECTIONS && fb.COLLECTIONS.PRICE_HISTORY) || 'price_history';

    const doc = await db.collection(PRODUCTS).doc(String(productId)).get();
    if (!doc.exists) return null;

    // 500, not 2000. This runs per product and the quota is finite; a history
    // longer than 500 readings is already pruned by the cron's daily pass.
    const histSnap = await doc.ref.collection(HISTORY).limit(500).get();
    const points = histSnap.docs.map((h) => {
      const d = h.data() || {};
      return { id: h.id, ref: h.ref, price: d.price, checkedAt: d.checkedAt };
    });

    const mrp = num(o.mrp) || num((doc.data() || {}).mrp);
    const verdict = findSelfCleanPoints(points, { trustedPrice: o.trustedPrice, mrp });
    if (!verdict.drop.length) return { productId, removed: 0, reason: verdict.reason };

    // Delete, in batches so a large history cannot exhaust the request.
    const byId = new Map(points.map((p) => [p.id, p]));
    let removed = 0;
    for (let i = 0; i < verdict.drop.length; i += 400) {
      const batch = db.batch();
      for (const id of verdict.drop.slice(i, i + 400)) {
        const p = byId.get(id);
        if (p) {
          batch.delete(p.ref);
          removed++;
        }
      }
      await batch.commit();
    }

    // Re-point lastPrice at the newest surviving reading, so the dashboard and
    // the card cannot keep showing a figure we just deleted.
    const droppedIds = new Set(verdict.drop);
    const survivors = points.filter((p) => !droppedIds.has(p.id) && num(p.price) != null);
    survivors.sort((a, b) => tsOf(a) - tsOf(b));
    const newest = survivors[survivors.length - 1];
    if (newest && FieldValue) {
      await doc.ref.update({ lastPrice: newest.price, updatedAt: FieldValue.serverTimestamp() });
    }

    log(
      'self-clean: ' + productId + ' removed ' + removed + ' of ' + points.length +
        ' readings (trusted=' + (o.trustedPrice != null ? o.trustedPrice : 'n/a') +
        ', mrp=' + (mrp != null ? mrp : 'n/a') + ')' +
        (verdict.heldBack ? ', held back ' + verdict.heldBack + ' over the fraction guard' : '')
    );

    return {
      productId,
      removed,
      kept: points.length - removed,
      lastPrice: newest ? newest.price : null,
      heldBack: verdict.heldBack || 0,
      reason: null,
    };
  } catch (err) {
    log('self-clean: ' + productId + ' failed (' + (err && err.message) + '); history left as it was');
    return null;
  }
}

module.exports = { selfCleanProduct, findSelfCleanPoints, tsOf, BAND, MAX_FRACTION };
