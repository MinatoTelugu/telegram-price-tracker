/**
 * api/track.js
 * ---------------------------------------------------------------------------
 * Read-only JSON endpoint backing the price-history web page (public/index.html).
 *
 *   GET /api/track?id=amazon_B08N5WRWNW
 *   -> { ok:true, product:{...}, history:[{ t, price }] }
 *
 * Public on purpose: it only exposes price data that is already visible on the
 * merchant's own page. No user data is returned.
 * ---------------------------------------------------------------------------
 */

const { db, COLLECTIONS } = require('../lib/firebase');

const HISTORY_LIMIT = 200; // plenty for 30 days at 4 checks/day

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }

  const id = (req.query && req.query.id) || '';
  if (!id || !/^[a-z]+_[A-Za-z0-9]+$/.test(id)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'invalid_id' }));
    return;
  }

  try {
    const ref = db.collection(COLLECTIONS.PRODUCTS).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const data = snap.data();

    const historySnap = await ref
      .collection(COLLECTIONS.PRICE_HISTORY)
      .orderBy('checkedAt', 'asc')
      .limit(HISTORY_LIMIT)
      .get();

    const history = historySnap.docs.map((d) => {
      const h = d.data();
      const ms = h.checkedAt && h.checkedAt.toMillis ? h.checkedAt.toMillis() : null;
      return { t: ms, price: h.price };
    });

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        product: {
          id,
          marketplace: data.marketplace,
          productId: data.productId,
          title: data.title || null,
          imageUrl: data.imageUrl || null,
          currency: data.currency || 'INR',
          lastPrice: data.lastPrice != null ? data.lastPrice : null,
          mrp: data.mrp != null ? data.mrp : null,
          inStock: typeof data.inStock === 'boolean' ? data.inStock : null,
          lastCheckedAt:
            data.lastCheckedAt && data.lastCheckedAt.toMillis ? data.lastCheckedAt.toMillis() : null,
          affiliateUrl: data.affiliateUrl || null,
          cleanUrl: data.cleanUrl || null,
        },
        history,
      })
    );
  } catch (err) {
    console.error('track endpoint failed', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'server_error' }));
  }
};
