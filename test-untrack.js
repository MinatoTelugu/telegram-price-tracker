/**
 * test-untrack.js
 * ---------------------------------------------------------------------------
 * Pressing "Stop Tracking" used to give no feedback in the chat. The record was
 * removed, but the card still read as if the product were tracked and its
 * buttons still worked — so the user could not tell whether anything happened.
 *
 * Worse, the callback was answered AFTER an unbounded database write. If that
 * write stalled or threw, the answer never happened at all, and the button just
 * sat there with no popup and no error.
 *
 * What matters here:
 *   1. the popup says what happened, in the user's words,
 *   2. the write is BOUNDED, so a stall still produces an answer,
 *   3. a failure produces a truthful popup rather than a false success,
 *   4. the card is rewritten and its buttons removed,
 *   5. the /list message is NOT mangled (it carries the same button),
 *   6. pressing twice does not stack the header.
 *
 * markCardStopped is lifted out of api/telegram.js and run against a fake ctx.
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
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'));
  if (!m) throw new Error('could not extract ' + name);
  return m[0];
}

eval(grab('markCardStopped'));

const CARD = [
  '📦 <b>The Product has Started Tracking!</b>',
  '',
  '☀️ <b>Samsung Galaxy M17 5G</b>',
  '',
  'Current Price: <b>₹19,999</b>',
  '',
  '<a href="https://www.amazon.in/dp/B0G81TPT89">Click here to open in Amazon!</a>',
].join('\n');

function fakeCtx(message) {
  const calls = { editedText: [], editedCaption: [], answered: [] };
  const ctx = {
    chat: { id: 42 },
    callbackQuery: { message },
    telegram: {
      editMessageText: async (chatId, id, x, text, extra) => {
        calls.editedText.push({ id, text, extra });
      },
      editMessageCaption: async (chatId, id, x, text, extra) => {
        calls.editedCaption.push({ id, text, extra });
      },
    },
  };
  return { ctx, calls };
}

(async () => {
  // 1. a product card is rewritten and its buttons removed
  {
    const { ctx, calls } = fakeCtx({ message_id: 5, text: CARD });
    await markCardStopped(ctx);
    check('the card is edited', calls.editedText.length === 1);
    check('the header becomes "Tracking Stopped"',
      calls.editedText[0].text.startsWith('🛑 <b>Tracking Stopped</b>'));
    check('the old header is gone', !calls.editedText[0].text.includes('Started Tracking'));
    check('the product name survives',
      calls.editedText[0].text.includes('Samsung Galaxy M17 5G'));
    check('the price survives', calls.editedText[0].text.includes('₹19,999'));
    check('the buy link survives', calls.editedText[0].text.includes('amazon.in/dp'));
    check('the buttons are removed',
      JSON.stringify(calls.editedText[0].extra.reply_markup) === JSON.stringify({ inline_keyboard: [] }));
    check('parse_mode is HTML', calls.editedText[0].extra.parse_mode === 'HTML');
  }

  // 2. pressing twice does not stack the header
  {
    const { ctx, calls } = fakeCtx({ message_id: 5, text: CARD });
    await markCardStopped(ctx);
    const once = calls.editedText[0].text;
    const { ctx: ctx2, calls: calls2 } = fakeCtx({ message_id: 5, text: once });
    await markCardStopped(ctx2);
    check('a second press is idempotent', calls2.editedText[0].text === once);
    check('the header appears exactly once',
      (calls2.editedText[0].text.match(/Tracking Stopped/g) || []).length === 1);
  }

  // 3. a photo card is edited through its caption
  {
    const { ctx, calls } = fakeCtx({ message_id: 6, photo: [{ file_id: 'x' }], caption: CARD });
    await markCardStopped(ctx);
    check('a photo card uses editMessageCaption', calls.editedCaption.length === 1);
    check('...and not editMessageText', calls.editedText.length === 0);
    check('the caption header becomes "Tracking Stopped"',
      calls.editedCaption[0].text.startsWith('🛑 <b>Tracking Stopped</b>'));
    check('the photo caption buttons are removed',
      JSON.stringify(calls.editedCaption[0].extra.reply_markup) === JSON.stringify({ inline_keyboard: [] }));
  }

  // 4. the /list message carries the same button and must NOT be mangled
  {
    const list = '📋 <b>Your tracked products</b>\n\n1. Samsung Galaxy M17 5G\n2. Infinix Note 50s';
    const { ctx, calls } = fakeCtx({ message_id: 9, text: list });
    await markCardStopped(ctx);
    check('the /list message is left alone', calls.editedText.length === 0 && calls.editedCaption.length === 0);
  }

  // 5. nothing to edit is not an error
  {
    const { ctx, calls } = fakeCtx(undefined);
    await markCardStopped(ctx);
    check('a missing message is handled quietly', calls.editedText.length === 0);
  }

  // --- the handler itself -----------------------------------------------------
  const handlerStart = src.indexOf("bot.action(/^untrack:");
  const handler = src.slice(handlerStart, src.indexOf('\n  });', handlerStart));

  // 6. the popup, in the user's words
  check('the handler answers the callback query', /answerCbQuery/.test(handler));
  check('the success popup matches the requested wording',
    handler.includes('🛑 Tracking stopped for this product.'));
  check('the success popup is sent', /await answer\('🛑 Tracking stopped for this product\.'\)/.test(handler));

  // 7. the write is bounded, so a stall still produces an answer
  check('the database write is bounded by a timeout',
    /withTimeout\(untrackProduct\(docId, ctx\.from\), 8000\)/.test(handler));

  // 8. a failure tells the truth rather than reporting a false success
  {
    const failAt = handler.indexOf('Could not stop tracking');
    const successAt = handler.indexOf('🛑 Tracking stopped for this product.');
    check('a failed write reports a failure', failAt > -1);
    check('...and returns without claiming success', failAt < successAt);
    check('the database-not-configured case is answered',
      handler.includes('Database not configured'));
  }

  // 9. the card is marked after a successful stop
  {
    const answerAt = handler.indexOf("await answer('🛑 Tracking stopped for this product.')");
    const markAt = handler.indexOf('await markCardStopped(ctx)');
    check('the card is marked stopped', markAt > -1);
    check('...after the popup is answered', answerAt > -1 && answerAt < markAt);
  }

  // 10. the outer catch answers too, so nothing can end with a silent button
  check('the outer catch answers the callback', /\} catch \(err\) \{[\s\S]{0,200}await answer\(/.test(handler));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
