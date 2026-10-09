/**
 * test-placeholder.js
 * ---------------------------------------------------------------------------
 * The fallback chain can take 40-60 seconds, and the chat used to sit silent
 * the whole time — users assumed the bot was dead and left. A "processing"
 * message is now sent before ANY network work, and edited into the real card.
 *
 * What matters here:
 *   1. the placeholder goes out BEFORE the slow steps (the short-link
 *      expansion is itself one of them),
 *   2. it is EDITED into the card, not left behind or duplicated,
 *   3. an edit that fails falls back to delete-and-resend,
 *   4. the keyboard survives the edit (omitting reply_markup removes it),
 *   5. NO early return can strand the placeholder,
 *   6. the typing indicator is stopped on every exit.
 *
 * finishPlaceholder is lifted out of api/telegram.js and run against a fake
 * ctx, so the code under test is the real code.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) pass++;
  else {
    fail++;
    console.log('  ✗ FAIL: ' + name);
  }
}

const src = fs.readFileSync(__dirname + '/api/telegram.js', 'utf8');
function grab(name) {
  // Keep any "async " prefix — dropping it makes the extracted body fail to
  // parse the moment it contains an await.
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}

// --- the text the user actually sees -----------------------------------------
{
  const m = src.match(/const PROCESSING_TEXT =\s*\n?\s*'([\s\S]*?)';/);
  check('PROCESSING_TEXT exists', Boolean(m));
  const text = m ? m[1] : '';
  check('it says the link is being processed', /Processing your link/i.test(text));
  check('it tells the user to wait', /wait/i.test(text));
  check('it names what is happening', /Fetching product details/i.test(text));
}

// --- finishPlaceholder, run for real ------------------------------------------
eval(grab('finishPlaceholder'));

function fakeCtx(opts) {
  const o = opts || {};
  const calls = { edited: [], deleted: [], replies: [] };
  const ctx = {
    chat: { id: 42 },
    telegram: {
      editMessageText: async (chatId, id, x, text, extra) => {
        if (o.editFails) throw new Error('message is not modified');
        calls.edited.push({ chatId, id, text, extra });
      },
      deleteMessage: async (chatId, id) => calls.deleted.push({ chatId, id }),
    },
    reply: async (text, extra) => {
      calls.replies.push({ text, extra });
      return { message_id: 99 };
    },
  };
  return { ctx, calls };
}

(async () => {
  const placeholder = { message_id: 7 };
  const keyboard = { reply_markup: { inline_keyboard: [[{ text: 'x' }]] } };

  // 1. it EDITS the placeholder rather than sending a second message
  {
    const { ctx, calls } = fakeCtx();
    const returned = await finishPlaceholder(ctx, placeholder, 'CARD', { reply_markup: keyboard.reply_markup });
    check('the placeholder is edited, not replaced', calls.edited.length === 1 && calls.replies.length === 0);
    check('the edit targets the placeholder message', calls.edited[0].id === 7);
    check('the edit carries the card text', calls.edited[0].text === 'CARD');
    check('the edit sets parse_mode', calls.edited[0].extra.parse_mode === 'HTML');
    check('the edit keeps the keyboard', calls.edited[0].extra.reply_markup === keyboard.reply_markup);
    check('the returned message is the placeholder (so enrichment edits it)',
      returned && returned.message_id === 7);
  }

  // 2. a failed edit falls back to delete-and-resend
  {
    const { ctx, calls } = fakeCtx({ editFails: true });
    const returned = await finishPlaceholder(ctx, placeholder, 'CARD', {});
    check('a failed edit deletes the placeholder', calls.deleted.length === 1 && calls.deleted[0].id === 7);
    check('a failed edit resends the card', calls.replies.length === 1 && calls.replies[0].text === 'CARD');
    check('a failed edit returns the new message', returned && returned.message_id === 99);
  }

  // 3. no placeholder at all (sending it failed) still delivers the card
  {
    const { ctx, calls } = fakeCtx();
    await finishPlaceholder(ctx, null, 'CARD', {});
    check('with no placeholder the card is simply sent', calls.replies.length === 1 && calls.edited.length === 0);
  }

  // --- the wiring ------------------------------------------------------------
  const handlerStart = src.indexOf("bot.on('text'");
  const handler = src.slice(handlerStart, src.indexOf('bot.action(', handlerStart));

  // 4. the placeholder goes out before the slow work
  {
    const atPlaceholder = handler.indexOf('placeholder = await ctx.reply(PROCESSING_TEXT');
    const atExpansion = handler.indexOf('expandShortLink(url)');
    const atConvert = handler.indexOf('convertAffiliateLink(url)');
    const atFetch = handler.indexOf('fetchProduct(');
    check('the placeholder is sent at all', atPlaceholder > -1);
    check('it is sent BEFORE the short-link expansion', atPlaceholder > -1 && atPlaceholder < atExpansion);
    check('it is sent BEFORE the converter call', atPlaceholder < atConvert);
    check('it is sent BEFORE any product fetch', atPlaceholder < atFetch);
  }

  // 5. no early return can strand it
  {
    const after = handler.slice(handler.indexOf('placeholder = await ctx.reply(PROCESSING_TEXT'));
    const returns = after.match(/\breturn;/g) || [];
    const replacements = after.match(/finishPlaceholder\(/g) || [];
    check('there are several exit paths', returns.length >= 4);
    // Every exit is preceded by a finishPlaceholder call.
    check('every exit path replaces the placeholder (>= one call per return)',
      replacements.length >= returns.length);
  }

  // 6. the typing indicator runs for the whole wait and is always stopped
  {
    check('there is a keepTyping helper', /function keepTyping/.test(src));
    const kt = grab('keepTyping');
    check('it repeats, because Telegram lapses after ~5s', /setInterval/.test(kt));
    check('it can be stopped', /clearInterval/.test(kt));
    check('it is started', /stopTyping = keepTyping\(ctx\)/.test(handler));
    check('it is stopped in a finally, so early returns are covered',
      /\} finally \{\s*\n\s*if \(stopTyping\) stopTyping\(\);/.test(src));
  }

  // 7. the slow path now enriches too, so its card fills in
  {
    check('the slow path enriches in the background', /enrichTracked\(ctx, sentSlow/.test(handler));
    check('the fast path still enriches', /enrichTracked\(ctx, sent,/.test(handler));
    check('enrichment handles a photo card via its caption',
      /editMessageCaption\(/.test(src) && /sentMessage\.photo && ctx\.telegram\.editMessageCaption/.test(src));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
