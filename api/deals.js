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
 *   CHANNEL_ID             -> channel chat id (default -1004386388150)
 *                             (DEALS_CHANNEL_ID / TELEGRAM_CHANNEL_ID still accepted)
 *   BITLY_ACCESS_TOKEN     -> Bitly v4 token
 *   MIN_DISCOUNT / DEALS_MIN_DISCOUNT -> threshold % (default 20)
 *   ?minDiscount=NN        -> per-run override
 *   DEALS_MAX_PER_RUN      -> posts per run (default 5)
 *   DEALS_REPOST_DAYS      -> don't repost a deal within N days (default 30)
 *   DEALS_SOURCE_URLS      -> comma-separated listing pages to scrape
 * ---------------------------------------------------------------------------
 */

const axios = require('axios');
const crypto = require('crypto');
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

/**
 * The target channel. CHANNEL_ID is the primary name; DEALS_CHANNEL_ID and
 * TELEGRAM_CHANNEL_ID are still read as fallbacks so an existing deployment
 * keeps working after the rename — CHANNEL_ID wins when both are set.
 * Read at call time, not at load, so a change is picked up without a rebuild.
 */
function channelId() {
  return (
    process.env.CHANNEL_ID ||
    process.env.DEALS_CHANNEL_ID ||
    process.env.TELEGRAM_CHANNEL_ID ||
    '-1004386388150'
  );
}
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

/**
 * A stable fingerprint of a product's NAME. Two listings of the same scarf can
 * have different ids (and even slightly different titles), which is exactly how
 * the same product got posted twice back to back.
 */
function titleFingerprint(title) {
  const NOISE = /\b(multicolor|multicolour|fancy|stylish|pack|of|for|with|and|the|new|latest|mss|fashion|buy|online|india|combo|set)\b/g;
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(NOISE, ' ')
    .split(' ')
    .filter((w) => w.length > 2);
  if (!words.length) return null;
  // SORT the words: "Scarf Stole Fancy Scarf" and "Stole Scarf Fancy Scarf" are
  // the same product, and listing titles reorder words freely.
  const canon = Array.from(new Set(words)).sort().join(' ');
  return 'fp_' + crypto.createHash('sha1').update(canon).digest('hex').slice(0, 16);
}

/** men | women | null — from the product title. */
function classifyGender(title) {
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  if (/\b(women|womens|woman|girls|girl|ladies|female|her)\b/.test(t)) return 'women';
  if (/\b(men|mens|man|boys|boy|male|gents|him)\b/.test(t)) return 'men';
  return null;
}

/** Was this key posted within the last `hours`? */
async function recentlyPosted(key, hours) {
  if (!db || !key) return false;
  try {
    const snap = await db.collection(COLLECTIONS.DEALS_POSTED).doc(key).get();
    if (!snap.exists) return false;
    const d = snap.data() || {};
    const at = d.postedAt && d.postedAt.toMillis ? d.postedAt.toMillis() : null;
    if (!at) return true;
    return Date.now() - at < hours * 3600 * 1000;
  } catch (err) {
    return false;
  }
}

/** How many men's / women's items went out recently — the rolling ratio. */
async function recentGenderCounts(limit = 12) {
  if (!db) return { men: 0, women: 0 };
  try {
    const snap = await db
      .collection(COLLECTIONS.DEALS_POSTED)
      .orderBy('postedAt', 'desc')
      .limit(limit)
      .get();
    let men = 0;
    let women = 0;
    for (const d of snap.docs) {
      const row = d.data() || {};
      if (row.isFingerprint) continue; // dedup markers are not posts
      const g = row.gender;
      if (g === 'men') men++;
      else if (g === 'women') women++;
    }
    return { men, women };
  } catch (err) {
    return { men: 0, women: 0 };
  }
}

/**
 * Order the candidates so that, counting from the recent history, roughly 80% of
 * fashion posts are men's and 20% women's. A greedy pick: at each step choose
 * the gender that is furthest BELOW its target share, so a run can never drift
 * into back-to-back women's posts.
 */
function orderForRatio(deals, recent, maxPerRun) {
  const WOMEN_SHARE = 0.2;
  const pool = { men: [], women: [], other: [] };
  for (const d of deals) {
    const g = classifyGender(d.title);
    pool[g === 'men' ? 'men' : g === 'women' ? 'women' : 'other'].push(d);
  }

  const out = [];
  // Target for THIS run: 8 men to every 2 women.
  const targetWomen = Math.max(1, Math.round(maxPerRun * WOMEN_SHARE));
  // If the channel is already over its women quota, do not open with one.
  const overWomen = (recent.women || 0) > (recent.men || 0) * (WOMEN_SHARE / (1 - WOMEN_SHARE));

  let womenPicked = 0;
  for (let i = 0; i < maxPerRun; i++) {
    // Spread the women's slots evenly through the run.
    const stride = Math.max(2, Math.round(maxPerRun / targetWomen));
    const womenSlot = womenPicked < targetWomen && (i + 1) % stride === 0;
    const allowWomen = womenSlot && pool.women.length && !(i === 0 && overWomen);

    if (allowWomen) {
      out.push(pool.women.shift());
      womenPicked++;
    } else if (pool.men.length) {
      out.push(pool.men.shift());
    } else if (pool.women.length && womenPicked < targetWomen) {
      out.push(pool.women.shift());
      womenPicked++;
    } else if (pool.other.length) {
      out.push(pool.other.shift());
    } else {
      break;
    }
  }
  return out;
}

/** The product photo, fetched from the product page when the card had none. */
async function imageFromProductPage(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      timeout: 2500,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
              html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m && /^https?:\/\//i.test(m[1])) return m[1].replace(/^http:/i, 'https:');
  } catch (err) {
    /* no image available */
  }
  return null;
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

async function markPosted(id, deal, isFingerprint) {
  if (!db) return;
  try {
    await db.collection(COLLECTIONS.DEALS_POSTED).doc(id).set(
      {
        title: deal.title,
        gender: classifyGender(deal.title),
        isFingerprint: Boolean(isFingerprint),
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

/**
 * Turn an axios failure into Telegram's own words. Telegram replies with
 * { ok:false, error_code, description } — the description is the actual reason
 * ("bot is not a member of the channel chat", "not enough rights", ...), which
 * is far more useful than "Request failed with status code 403".
 */
function describeTelegramError(err) {
  const d = err && err.response && err.response.data;
  if (d && typeof d === 'object') {
    const desc = d.description || JSON.stringify(d);
    return 'HTTP ' + (d.error_code || (err.response && err.response.status) || '?') + ' — ' + String(desc).slice(0, 300);
  }
  return err.message;
}

/**
 * Pre-flight check. Answers, before we try to post: can the bot SEE this chat,
 * what kind of chat is it, and what is the bot's own status in it? This is what
 * turns a bare 403 into an actionable sentence.
 */
async function verifyChannel() {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, error: 'BOT_TOKEN is not set' };

  const api = 'https://api.telegram.org/bot' + token + '/';
  const out = { channel: channelId() };

  try {
    const chat = await axios.get(api + 'getChat', { params: { chat_id: channelId() }, timeout: 10000 });
    const r = chat.data && chat.data.result;
    out.ok = true;
    out.title = r && r.title;
    out.type = r && r.type;
    out.username = r && r.username;
  } catch (err) {
    out.ok = false;
    out.error = describeTelegramError(err);
    return out; // the bot cannot even see the chat — nothing else will work
  }

  try {
    const me = await axios.get(api + 'getMe', { timeout: 10000 });
    const bot = me.data && me.data.result;
    out.bot = bot && bot.username;
    if (bot && bot.id) {
      const member = await axios.get(api + 'getChatMember', {
        params: { chat_id: channelId(), user_id: bot.id },
        timeout: 10000,
      });
      out.botStatus = member.data && member.data.result && member.data.result.status; // 'administrator' | 'member' | 'left' | ...
      out.canPostMessages =
        member.data && member.data.result && member.data.result.can_post_messages !== false;
    }
  } catch (err) {
    out.memberError = describeTelegramError(err);
  }
  return out;
}

async function postToChannel(deal, link) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');

  const caption = buildCaption(deal, link);
  const api = 'https://api.telegram.org/bot' + token + '/';
  let photoError = null;

  if (!deal.imageUrl) {
    console.log('deals: no image for ' + deal.id + ' — sending text with a link preview');
  }

  // Action buttons on every post.
  const reply_markup = {
    inline_keyboard: [
      [{ text: '🛒 Buy Now', url: link }],
      [{ text: '🔥 More Deals', url: CHANNEL_URL }],
    ],
  };

  // No image on the card? Fetch the product page and take its og:image, so the
  // post is a photo card rather than a bare link preview.
  if (!deal.imageUrl && deal.url) {
    const fetched = await imageFromProductPage(deal.url);
    if (fetched) {
      deal.imageUrl = fetched;
      console.log('deals: fetched og:image for ' + deal.id);
    }
  }

  if (deal.imageUrl) {
    try {
      await axios.post(
        api + 'sendPhoto',
        { chat_id: channelId(), photo: deal.imageUrl, caption, parse_mode: 'HTML', reply_markup },
        { timeout: 15000 }
      );
      console.log('deals: sent as a PHOTO — ' + String(deal.imageUrl).slice(0, 70));
      return true;
    } catch (err) {
      photoError = describeTelegramError(err);
      console.warn('deals: sendPhoto failed — ' + photoError + ' (falling back to text)');
    }
  }

  try {
    await axios.post(
      api + 'sendMessage',
      { chat_id: channelId(), text: caption, parse_mode: 'HTML', disable_web_page_preview: false, reply_markup },
      { timeout: 15000 }
    );
    return true;
  } catch (err) {
    const textError = describeTelegramError(err);
    console.warn('deals: sendMessage failed — ' + textError);
    // Both routes failed: report BOTH reasons so the cause is unambiguous.
    throw new Error(
      'telegram: ' + textError + (photoError ? ' | sendPhoto: ' + photoError : '') + ' (channel ' + channelId() + ')'
    );
  }
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
    console.log('deals: run start — minDiscount=' + minDiscount + '% maxPerRun=' + MAX_PER_RUN + ' channel=' + channelId());

    // Pre-flight the channel: if the bot cannot post, say so once, clearly.
    const channel = await verifyChannel();
    if (channel.ok) {
      console.log(
        'deals: channel ok — title="' + channel.title + '" type=' + channel.type +
          ' bot=@' + channel.bot + ' botStatus=' + channel.botStatus +
          ' canPostMessages=' + channel.canPostMessages
      );
      if (channel.botStatus && channel.botStatus !== 'administrator') {
        console.warn(
          'deals: the bot is NOT an administrator of ' + channelId() +
            ' (status=' + channel.botStatus + '). Telegram requires admin rights to post to a channel.'
        );
      }
    } else {
      console.error('deals: channel check FAILED for ' + channelId() + ' — ' + channel.error);
    }

    const scan = await discoverDealsDetailed({ minDiscount, limit: MAX_PER_RUN * 4 });
    const deals = scan.deals;

    // Per-source detail, so a silent 0 is never a mystery again.
    for (const src of scan.sources) {
      console.log(
        'deals: source ' + src.url + ' -> status=' + src.status + ' cards=' + src.cards +
          ' parsed=' + src.parsed + ' matched=' + src.matched + (src.error ? ' error=' + src.error : '')
      );
      // Raw parses, so a 0-match run says WHY (missing title? price? discount?).
      for (const sample of src.samples || []) {
        console.log(
          'deals:   sample title="' + sample.title + '" price=' + sample.price +
            ' mrp=' + sample.mrp + ' discount=' + sample.discount + ' raw="' + sample.discRaw +
            '" image=' + (sample.image ? sample.image : 'NONE')
        );
      }
    }
    console.log('deals: Fetched ' + deals.length + ' deal(s) from ' + scan.sources.length + ' source(s) in ' + scan.ms + 'ms');
    if (!deals.length) {
      console.log('deals: nothing above the discount threshold — posting nothing this run');
    }

    if (dryRun) {
      console.log('deals: dry run — found ' + deals.length + ' deal(s), not posting');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ ok: true, dryRun: true, channel: channelId(), minDiscount, found: deals.length, deals })
      );
      return;
    }

    const posted = [];
    const skipped = [];

    // Enforce the 80/20 men/women ratio, counting what has gone out recently, so
    // a run can never drift into back-to-back women's posts.
    const recent = await recentGenderCounts(12);
    const ordered = orderForRatio(deals, recent, MAX_PER_RUN * 3);
    console.log(
      'deals: ratio — recent men=' + recent.men + ' women=' + recent.women +
        ', ordered ' + ordered.length + ' candidate(s) for a 80/20 mix'
    );

    for (const deal of ordered) {
      if (posted.length >= MAX_PER_RUN) break;

      if (await alreadyPosted(deal.id)) {
        skipped.push({ id: deal.id, reason: 'already_posted' });
        continue;
      }

      // Same PRODUCT under a different listing id / slightly different title:
      // never repost it within 48 hours.
      const fp = titleFingerprint(deal.title);
      if (fp && (await recentlyPosted(fp, 48))) {
        skipped.push({ id: deal.id, reason: 'duplicate_title', fingerprint: fp });
        console.log('deals: skipped a duplicate title — ' + String(deal.title).slice(0, 60));
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
        // Record the title fingerprint as well, so a re-listed duplicate is
        // caught even though its id differs.
        const fpKey = titleFingerprint(deal.title);
        if (fpKey) await markPosted(fpKey, deal, true);
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
        channel: channelId(),
        deals_posted: posted.length,
        minDiscount,
        found: deals.length,
        postedCount: posted.length,
        posted,
        skippedCount: skipped.length,
        skipped,
        bitlyConfigured: Boolean(process.env.BITLY_ACCESS_TOKEN),
        sources: scan.sources,
        channelCheck: channel,
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

// Exposed for tests.
module.exports.titleFingerprint = titleFingerprint;
module.exports.classifyGender = classifyGender;
module.exports.orderForRatio = orderForRatio;
