/**
 * api/deals.js
 * ---------------------------------------------------------------------------
 * Free Deals Auto-Poster.
 *
 * On each run it:
 *   1. scrapes Flipkart listing pages for products discounted past a threshold
 *   2. skips anything already posted recently (tracked in Firestore)
 *   3. builds the affiliate link (Amazon tagged; Flipkart plain for now)
 *   4. shortens it with Bitly (BITLY_ACCESS_TOKEN)
 *   5. posts image + title + price + link to the channel
 *
 * Auth matches api/cron.js: Vercel sends "Authorization: Bearer $CRON_SECRET".
 * Add ?dryRun=1 to see what it found WITHOUT posting.
 *
 * Env vars:
 *   BOT_TOKEN              -> to post to the channel
 *   DEALS_CHANNEL_ID       -> channel chat id (default -1004386388150)
 *   BITLY_ACCESS_TOKEN     -> Bitly v4 token
 *   MIN_DISCOUNT / DEALS_MIN_DISCOUNT -> threshold % (default 20)
 *   ?minDiscount=NN        -> per-run override
 *   DEALS_MAX_PER_RUN      -> posts per run (default 5)
 *   DEALS_REPOST_DAYS      -> don't repost a deal within N days (default 30)
 *   DEALS_SOURCE_URLS      -> comma-separated listing pages to scrape
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const { discoverDealsDetailed } = require('../lib/deals');
const { convertAffiliateLink } = require('../lib/affiliate');
const { shortenUrl } = require('../lib/shorten');

// Load Firebase defensively: missing credentials must not crash the process.
let fb = null;
let fbError = null;
try {
  fb = require('../lib/firebase');
} catch (err) {
  fbError = err.message;
  console.error('Firebase failed to initialise at load time:', err.message);
}
const db = fb && fb.db;
const admin = fb && fb.admin;
const COLLECTIONS = (fb && fb.COLLECTIONS) || { DEALS_POSTED: 'deals_posted' };

const CHANNEL_ID =
  process.env.DEALS_CHANNEL_ID ||
  process.env.TELEGRAM_CHANNEL_ID ||
  process.env.CHANNEL_ID ||
  '-1004386388150';
// Default is 20% — anything at or above it is posted.
const MIN_DISCOUNT = parseFloat(
  process.env.MIN_DISCOUNT || process.env.DEALS_MIN_DISCOUNT || '20'
);
const MAX_PER_RUN = parseInt(process.env.DEALS_MAX_PER_RUN || '5', 10);
const REPOST_DAYS = parseInt(process.env.DEALS_REPOST_DAYS || '30', 10);
const FieldValue = (admin && admin.firestore && admin.firestore.FieldValue) || null;

function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}

function buildCaption(deal, link) {
  const lines = ['🔥 <b>' + deal.discount + '% OFF</b>', '', '<b>' + escapeHtml(deal.title) + '</b>', ''];
  if (deal.price != null && deal.mrp != null) {
    lines.push('💰 <b>' + money(deal.price) + '</b>  <s>' + money(deal.mrp) + '</s>');
  } else if (deal.price != null) {
    lines.push('💰 <b>' + money(deal.price) + '</b>');
  }
  lines.push('', '🔗 ' + link);
  return lines.join('\n');
}

async function alreadyPosted(id) {
  if (!db) return false;
  try {
    const snap = await db.collection(COLLECTIONS.DEALS_POSTED).doc(id).get();
    return snap.exists;
  } catch (err) {
    return false;
  }
}

async function markPosted(id, deal) {
  if (!db) return;
  try {
    await db.collection(COLLECTIONS.DEALS_POSTED).doc(id).set(
      {
        title: deal.title,
        url: deal.url,
        price: deal.price,
        mrp: deal.mrp,
        discount: deal.discount,
        marketplace: deal.marketplace,
        postedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn('markPosted failed', id, err.message);
  }
}

async function postToChannel(deal, link) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');

  const caption = buildCaption(deal, link);

  if (deal.imageUrl) {
    try {
      await axios.post(
        'https://api.telegram.org/bot' + token + '/sendPhoto',
        {
          chat_id: CHANNEL_ID,
          photo: deal.imageUrl,
          caption,
          parse_mode: 'HTML',
        },
        { timeout: 15000 }
      );
      return true;
    } catch (err) {
      console.warn('sendPhoto failed, falling back to text:', err.message);
    }
  }

  await axios.post(
    'https://api.telegram.org/bot' + token + '/sendMessage',
    { chat_id: CHANNEL_ID, text: caption, parse_mode: 'HTML', disable_web_page_preview: false },
    { timeout: 15000 }
  );
  return true;
}

module.exports = async (req, res) => {
  // Auth: same scheme as api/cron.js.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const queryKey = (req.query && (req.query.key || req.query.secret)) || '';
    if (provided !== secret && queryKey !== secret) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
  }

  const dryRun = Boolean(req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true'));

  // Threshold: ?minDiscount=NN wins, then MIN_DISCOUNT / DEALS_MIN_DISCOUNT,
  // then the 20% default. So /api/deals?minDiscount=5 widens a single run.
  const minDiscount = req.query && req.query.minDiscount
    ? Number(req.query.minDiscount)
    : Number(process.env.MIN_DISCOUNT || process.env.DEALS_MIN_DISCOUNT) || 20;

  if (!db) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Firebase is not configured', detail: fbError }));
    return;
  }

  const started = Date.now();
  try {
    console.log('deals: run start — minDiscount=' + minDiscount + '% maxPerRun=' + MAX_PER_RUN + ' channel=' + CHANNEL_ID);

    const scan = await discoverDealsDetailed({ minDiscount, limit: MAX_PER_RUN * 4 });
    const deals = scan.deals;

    // Per-source detail, so a silent 0 is never a mystery again.
    for (const src of scan.sources) {
      console.log(
        'deals: source ' + src.url + ' -> status=' + src.status + ' cards=' + src.cards +
          ' matched=' + src.matched + (src.error ? ' error=' + src.error : '')
      );
    }
    console.log('deals: Fetched ' + deals.length + ' deal(s) from ' + scan.sources.length + ' source(s) in ' + scan.ms + 'ms');
    if (!deals.length) {
      console.log('deals: nothing above the discount threshold — posting nothing this run');
    }

    if (dryRun) {
      console.log('deals: dry run — found ' + deals.length + ' deal(s), not posting');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, dryRun: true, minDiscount, found: deals.length, deals }));
      return;
    }

    const posted = [];
    const skipped = [];
    for (const deal of deals) {
      if (posted.length >= MAX_PER_RUN) break;

      if (await alreadyPosted(deal.id)) {
        skipped.push({ id: deal.id, reason: 'already_posted' });
        continue;
      }

      const affiliate = await convertAffiliateLink(deal.url);
      const targetUrl = affiliate.ok ? affiliate.affiliateUrl : deal.url;
      if (affiliate.ok && !affiliate.hasAffiliateTag) {
        console.warn(
          'deal posted WITHOUT an affiliate tag (marketplace=' + affiliate.marketplace +
            '). Set AMAZON_AFFILIATE_TAG / FLIPKART_AFFILIATE_ID to monetise it.'
        );
      }
      // Bitly stays ON for channel posts only (bot replies use the link directly).
      const shortLink = (await shortenUrl(targetUrl)) || targetUrl;

      try {
        console.log('deals: posting "' + String(deal.title).slice(0, 60) + '" (' + deal.discount + '% off) -> ' + shortLink);
        await postToChannel(deal, shortLink);
        await markPosted(deal.id, deal);
        posted.push({ id: deal.id, title: deal.title, discount: deal.discount, link: shortLink });
        console.log('deals: posted ok — total so far ' + posted.length);
      } catch (err) {
        console.warn('deals: post FAILED for ' + deal.id + ' — ' + err.message);
        skipped.push({ id: deal.id, reason: 'post_failed', error: err.message });
      }
    }

    const ms = Date.now() - started;
    console.log(
      'deals: done — posted=' + posted.length + ' skipped=' + skipped.length +
        ' found=' + deals.length + ' in ' + ms + 'ms'
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: true,
        ok: true,
        channel: CHANNEL_ID,
        deals_posted: posted.length,
        minDiscount,
        found: deals.length,
        postedCount: posted.length,
        posted,
        skippedCount: skipped.length,
        skipped,
        bitlyConfigured: Boolean(process.env.BITLY_ACCESS_TOKEN),
        sources: scan.sources,
        ms,
      })
    );
  } catch (err) {
    console.error('deals failed', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};
