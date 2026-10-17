/**
 * test-pagination.js
 * ---------------------------------------------------------------------------
 * The /list paging arithmetic, tested at every product count that was asked for:
 * 0, 1, 5, 6, 21 and 26, plus out-of-range and non-numeric page arguments.
 *
 * The arithmetic is replicated from api/telegram.js rather than imported,
 * because the real function replies to Telegram. The replication is kept honest
 * by asserting the SOURCE contains the same expressions — so if the code changes
 * shape, this test fails instead of silently testing an old copy.
 *
 * Why this file exists at all: a screenshot caught "page NaN/5" that the suite
 * did not, because the suite called the handler with no page argument or with a
 * number, and Telegraf calls it with `next` — a function. The `next` case is now
 * explicit here.
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const src = fs.readFileSync(path.join(__dirname, 'api/telegram.js'), 'utf8');
const PAGE_SIZE = parseInt((src.match(/LIST_PAGE_SIZE \|\| '(\d+)'/) || [])[1], 10);

// The source must still contain the guarded arithmetic this file replicates.
check('the page size is configured', PAGE_SIZE >= 1, 'got ' + PAGE_SIZE);
check('the page argument is type-guarded',
  /typeof page === 'number' && Number\.isFinite\(page\) \? page : 0/.test(src));
check('the page is clamped to the last page', /Math\.min\(Math\.max\(0, requested\), pages - 1\)/.test(src));
check('the slice uses the guarded offset', /items\.slice\(start, start \+ LIST_PAGE_SIZE\)/.test(src));
check('zero products have their own message', /You are not tracking anything yet/.test(src));

function plan(total, pageArg) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = typeof pageArg === 'number' && Number.isFinite(pageArg) ? pageArg : 0;
  const current = Math.min(Math.max(0, requested), pages - 1);
  const start = current * PAGE_SIZE;
  const all = Array.from({ length: total }, (_, i) => i + 1);
  return { pages, current, start, shown: all.slice(start, start + PAGE_SIZE) };
}

const next = () => {};  // exactly how Telegraf calls a command handler

check('21 products -> 5 pages', plan(21, next).pages === 5);
check('page 1 shows 1-5', JSON.stringify(plan(21, next).shown) === '[1,2,3,4,5]');
check('page 2 shows 6-10', JSON.stringify(plan(21, 1).shown) === '[6,7,8,9,10]');
check('page 3 shows 11-15', JSON.stringify(plan(21, 2).shown) === '[11,12,13,14,15]');
check('page 4 shows 16-20', JSON.stringify(plan(21, 3).shown) === '[16,17,18,19,20]');
check('page 5 shows 21 alone', JSON.stringify(plan(21, 4).shown) === '[21]');
check('every one of the 21 is reachable',
  [0, 1, 2, 3, 4].flatMap((p) => plan(21, p).shown).length === 21);

check('a page past the end clamps to the last', plan(21, 99).current === 4);
check('a negative page clamps to the first', plan(21, -5).current === 0);
check('a non-numeric page (Telegraf next) is page 0', plan(21, next).current === 0);
check('...and the indicator is never NaN', Number.isFinite(plan(21, next).current + 1));

check('0 products -> 1 page, nothing shown',
  plan(0, next).pages === 1 && plan(0, next).shown.length === 0);
check('1 product -> 1 page', plan(1, next).pages === 1);
check('5 products -> 1 page', plan(5, next).pages === 1);
check('6 products -> 2 pages', plan(6, next).pages === 2);
check('6 products, page 2 -> item 6 alone', JSON.stringify(plan(6, 1).shown) === '[6]');
check('26 products -> 6 pages', plan(26, next).pages === 6);
check('26 products, page 6 -> item 26 alone', JSON.stringify(plan(26, 5).shown) === '[26]');

// Navigation rules.
const nav = (total, page) => {
  const p = plan(total, page);
  return {
    prev: p.current > 0,
    nextBtn: p.current < p.pages - 1,
    label: (p.current + 1) + '/' + p.pages,
  };
};
check('page 1 has no Previous', nav(21, next).prev === false);
check('page 1 has Next', nav(21, next).nextBtn === true);
check('page 5 has Previous', nav(21, 4).prev === true);
check('page 5 has no Next', nav(21, 4).nextBtn === false);
check('a single page has neither', nav(5, next).prev === false && nav(5, next).nextBtn === false);
check('labels read 1/5 ... 5/5',
  ['1/5', '2/5', '3/5', '4/5', '5/5'].every((l, i) => nav(21, i).label === l));

// ---------------------------------------------------------------------------
// THE PAGING BUTTONS. A screen recording showed them doing nothing when pressed.
//
// The callback faked a Telegraf context with Object.create(ctx) and overrode
// .reply. Telegraf carries its context properties through getters and its own
// middleware state, so a prototype-shimmed copy is not the same object and the
// edit never reached Telegram. There is now an explicit mode instead.
// ---------------------------------------------------------------------------
check('the callback does not fake a context', !/Object\.create\(ctx\)\s*;/.test(src));
check('...it passes an explicit edit mode', /sendTrackingList\(ctx, page, 'edit'\)/.test(src));
check('...and the function honours it', /if \(mode === 'edit'\) \{/.test(src));
check('...editing the existing message', /await ctx\.editMessageText\(text, opts\)/.test(src));
check('...and replying when it is not an edit', /\} else \{\s*\n\s*await ctx\.reply\(text, opts\)/.test(src));
check('an unchanged edit is tolerated, not treated as an error',
  /message is not modified/i.test(src));
check('the callback is acknowledged BEFORE the database read',
  src.indexOf('ctx.answerCbQuery().catch(() => {});') < src.indexOf("sendTrackingList(ctx, page, 'edit')"));
check('the page buttons carry a page number', /'listpage:' \+ \(current \+ 1\)/.test(src));
check('...and Prev/Next only appear where they lead somewhere',
  /if \(current > 0\) nav\.push/.test(src) && /if \(current < pages - 1\) nav\.push/.test(src));

// ---------------------------------------------------------------------------
// NAVIGATION CONTROLS. The paging row plus a way home.
// ---------------------------------------------------------------------------
check('Previous is spelled out', /'⬅️ Previous'/.test(src));
check('Next is spelled out', /'Next ➡️'/.test(src));
check('the indicator sits between them', /' \/ ' \+ pages, 'listpage:' \+ current/.test(src));
check('Home is a button', /Markup\.button\.callback\('🏠 Home', 'home'\)/.test(src));
check('...on its own row, so it is always reachable',
  /buttonRows\.push\(\[Markup\.button\.callback\('🏠 Home', 'home'\)\]\)/.test(src));
check('...and it is OUTSIDE the pages>1 block, so a single page has it too',
  src.indexOf("'🏠 Home', 'home'") > src.indexOf('if (pages > 1) {'));
check('Home has a handler', /bot\.action\(\/\^home/.test(src));
check('...which edits rather than piling up messages', /await ctx\.editMessageText\(caption, opts\)/.test(src));
check('...and falls back to a reply when the message cannot be edited',
  /await ctx\.reply\(caption, opts\)\.catch/.test(src));
check('the main menu is defined once, so /start and Home cannot drift',
  (src.match(/function mainMenu\(\)/g) || []).length === 1);
check('...and /start uses it', /const \{ caption, keyboard \} = mainMenu\(\)/.test(src));

// ---------------------------------------------------------------------------
// THE TYPED FALLBACK. A screenshot showed the list rendering items 3-5 with NO
// keyboard at all. The buttons are attached on every list in this build, so that
// screenshot predates it — but a list you cannot page through is the bug, so
// typing the page number now works too, whatever the keyboard does.
// ---------------------------------------------------------------------------
check('/list accepts a page number', /bot\.command\(\['mytracks', 'list'\], async \(ctx\)/.test(src));
check('...read from the message, not from the second argument',
  /ctx\.message && ctx\.message\.text/.test(src));
check('...so /list 2 means page 2', /parseInt\(m\[1\], 10\) - 1/.test(src));
check('...and a group-chat mention is tolerated', /@\\w\+/.test(src));
check('no typed hint clutters the list — the buttons are the way to page',
  !/Tap the buttons, or type/.test(src));
check('...but /list N still works silently for anyone who types it',
  /parseInt\(m\[1\], 10\) - 1/.test(src));

// The parse itself, exercised.
const parsePage = (msg) => {
  const m = /^\/(?:list|mytracks)(?:@\w+)?\s+(\d+)\s*$/.exec(String(msg).trim());
  return m ? Math.max(0, parseInt(m[1], 10) - 1) : 0;
};
check('/list -> page 1', parsePage('/list') === 0);
check('/list 2 -> page 2', parsePage('/list 2') === 1);
check('/list 5 -> page 5', parsePage('/list 5') === 4);
check('/list@Bot 3 -> page 3', parsePage('/list@AiPriceAlertBot 3') === 2);
check('/mytracks 4 -> page 4', parsePage('/mytracks 4') === 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
