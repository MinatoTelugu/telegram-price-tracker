/**
 * Buy-box isolation on the HTML path, for BOTH stores.
 *
 * The reported bug was global, not one product's bad luck: the Amazon and
 * Flipkart price selectors included unscoped classes that match every price on
 * the page, and firstText() takes the first match in document order. A carousel
 * above the buy box therefore won.
 *
 * Run: node test-buybox-dom.js
 */
const cheerio = require('cheerio');
const scraper = require('./lib/scraper');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

const { firstBuyboxText, isInRelatedBlock } = scraper;

console.log('--- Amazon: a carousel price sits ABOVE the buy box ---');

// Document order matters: the carousel comes first, so the old reader, which
// took the first match anywhere, read ₹18,999 from the neighbouring phone.
const AMAZON = `
<html><body>
  <div id="anonCarousel" class="a-carousel">
    <span class="a-price-whole">18,999</span>
  </div>
  <div id="similarities_feature_div">
    <span class="a-price-whole">19,999</span>
  </div>
  <div id="ppd">
    <div id="corePriceDisplay_desktop_feature_div">
      <span class="a-price"><span class="a-offscreen">₹21,999</span></span>
    </div>
  </div>
  <div data-cel-widget="similarities_feature_div">
    <span class="a-price-whole">9,499</span>
  </div>
</body></html>`;

const $amz = cheerio.load(AMAZON);
const amzSel = ['#corePriceDisplay_desktop_feature_div .a-price .a-offscreen', '#ppd span.a-price-whole'];
const amzScoped = firstBuyboxText($amz, amzSel);
check('the scoped selector reads the buy-box price',
  /21,999/.test(String(amzScoped)), String(amzScoped));

// The same selectors WITHOUT scoping are what used to be configured. Show that
// they would have picked the carousel: that is the bug being fixed.
const unscoped = ['span.a-price-whole'];
const wouldHaveBeen = $amz(unscoped[0]).first().text().trim();
check('the old unscoped selector really did pick the carousel',
  wouldHaveBeen === '18,999', wouldHaveBeen);

check('a carousel element is recognised as related',
  isInRelatedBlock($amz, $amz('#anonCarousel .a-price-whole').first()) === true);
check('a buy-box element is not',
  isInRelatedBlock($amz, $amz('#corePriceDisplay_desktop_feature_div .a-offscreen').first()) === false);
check('a sponsored widget is recognised as related',
  isInRelatedBlock($amz, $amz('[data-cel-widget="similarities_feature_div"] .a-price-whole').first()) === true);

console.log('--- Amazon: the price really is only in the buy box ---');

const AMAZON_CLEAN = `
<html><body>
  <div id="anonCarousel"><span class="a-price-whole">18,999</span></div>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-offscreen">₹21,999</span></span>
  </div>
</body></html>`;
const $c = cheerio.load(AMAZON_CLEAN);
check('the buy-box price is found and the carousel ignored',
  /21,999/.test(String(firstBuyboxText($c, amzSel))));

console.log('--- Flipkart: the same classes appear in Similar Products ---');

const FLIPKART = `
<html><body>
  <div class="_2kHMtA" id="similar">
    <div class="Nx9bqj CxhGGd">₹7,499</div>
  </div>
  <div class="v1zwnj">
    <div class="Nx9bqj CxhGGd">₹21,999</div>
  </div>
  <div id="similarProducts">
    <div class="Nx9bqj">₹8,999</div>
  </div>
</body></html>`;

const $fk = cheerio.load(FLIPKART);
const fkSel = ['div.Nx9bqj.CxhGGd', 'div._30jeq3', 'div.Nx9bqj'];
const fkScoped = firstBuyboxText($fk, fkSel);
check('Flipkart reads the buy-box price, not the similar row',
  /21,999/.test(String(fkScoped)), String(fkScoped));
check('...and the similar row really was first in the document',
  $fk('div.Nx9bqj').first().text().trim() === '₹7,499');
check('a Flipkart similar block is recognised as related',
  isInRelatedBlock($fk, $fk('#similar .Nx9bqj').first()) === true);

console.log('--- when everything is in a carousel, nothing is returned ---');

const ONLY_CAROUSEL = '<html><body><div id="anonCarousel"><span class="a-price-whole">1,999</span></div></body></html>';
const $o = cheerio.load(ONLY_CAROUSEL);
check('no buy-box price in, no price out',
  firstBuyboxText($o, ['span.a-price-whole']) === null);

console.log('--- a page with no carousels is read exactly as before ---');

const PLAIN = '<html><body><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">₹4,999</span></span></div></body></html>';
const $p = cheerio.load(PLAIN);
check('an ordinary page still yields its price',
  /4,999/.test(String(firstBuyboxText($p, ['#corePrice_feature_div .a-price .a-offscreen']))));

console.log('--- the store configs no longer contain unscoped price selectors ---');

const src = require('fs').readFileSync(__dirname + '/lib/scraper.js', 'utf8');
check('Amazon no longer has the bare span.a-price-whole',
  !/^\s*'span\.a-price-whole',/m.test(src));
check('Amazon no longer has the bare .a-price .a-offscreen',
  !/^\s*'\.a-price \.a-offscreen',/m.test(src));
check('the price is read through the buy-box-aware reader',
  /parsePrice\(firstBuyboxText\(\$, cfg\.price\)\)/.test(src));

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
