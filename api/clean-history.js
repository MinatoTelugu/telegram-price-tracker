/**
 * api/clean-history.js
 * ---------------------------------------------------------------------------
 * Runs the one-off price-history repair described in lib/cleanHistory.js.
 *
 * DRY RUN BY DEFAULT — it only reports what it WOULD remove. Nothing is deleted
 * until you pass apply=1, which makes this safe to call just to look.
 *
 *   https://<your-app>/api/clean-history?secret=<CRON_SECRET>
 *        -> reports what would be removed, deletes nothing
 *
 *   https://<your-app>/api/clean-history?secret=<CRON_SECRET>&apply=1
 *        -> removes the flagged readings and re-points lastPrice
 *
 *   ...&id=<docId>   to do a single product instead of all of them
 *   ...&id=<docId>&max=12000
 *        -> remove every reading at or below ₹12,000 for that product. No
 *           heuristics: use this when you already know the figure is wrong.
 *
 * Auth is the same as /api/cron: an "Authorization: Bearer <CRON_SECRET>"
 * header, or ?secret=<CRON_SECRET> / ?key=<CRON_SECRET> in the query.
 * ---------------------------------------------------------------------------
 */

const { cleanHistory } = require('../lib/cleanHistory');

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const queryKey = (req.query && (req.query.key || req.query.secret)) || '';
    if (provided !== secret && queryKey !== secret) {
      send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
  }

  const q = req.query || {};
  const apply = q.apply === '1' || q.apply === 'true' || q.apply === 'yes';
  const productId = q.id ? String(q.id) : undefined;
  const maxPrice = q.max != null && q.max !== '' ? parseFloat(q.max) : undefined;

  try {
    const report = await cleanHistory({
      apply,
      productId,
      maxPrice,
      log: (line) => console.log('clean-history: ' + line),
    });
    console.log(
      'clean-history: apply=' + apply + ' scanned=' + report.scanned +
        ' affected=' + report.affected + ' removed=' + report.removed +
        ' refused=' + report.refused
    );
    send(res, 200, {
      ok: true,
      note: apply
        ? 'Removed the flagged readings. Reload the price-history page — the chart and the stats are computed from the readings that remain.'
        : 'DRY RUN — nothing was deleted. Add &apply=1 to actually remove these readings.',
      report,
    });
  } catch (err) {
    console.error('clean-history failed:', err && err.message);
    send(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
};
