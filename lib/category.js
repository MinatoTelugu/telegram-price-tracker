/**
 * lib/category.js
 * ---------------------------------------------------------------------------
 * Work out what a product IS from its title.
 *
 * Why the title, and not the page
 * ------------------------------
 * The store's own category field would be better, but it is exactly the thing
 * that changes without warning: Amazon's browse-node ids and Flipkart's
 * breadcrumb markup are both DOM structures, and DOM structures get redesigned.
 * A title is the one piece of a product page that survives every redesign,
 * because it is the product's name and the store cannot change it.
 *
 * So the category is inferred from keywords in the title. That means it is
 * approximate — "Apple iPhone 17 (Black, 256 GB)" is obviously a phone, while a
 * title like "Premium Cotton Blend" is not obviously anything — so the function
 * returns a CONFIDENCE alongside the category, and every caller is free to treat
 * a low-confidence answer as "no category" rather than acting on a guess.
 *
 * The categories are deliberately few. A long taxonomy would be more precise on
 * paper and would rot faster in practice, and the only thing they are used for is
 * choosing which deals to show beside a product.
 * ---------------------------------------------------------------------------
 */

/**
 * Order matters: the FIRST match wins, so the specific categories come before
 * the general ones. "Apple iPhone 17" contains no word from `electronics`, but
 * "Smart TV" contains "tv" — and a "TV" is electronics, not a phone, so phones
 * must be tested before electronics only where they do not overlap. In practice
 * the lists are disjoint, and the order below is belt-and-braces.
 */
const CATEGORIES = [
  {
    id: 'mobile',
    label: 'Mobile Phones',
    // The words that make something a phone.
    words: [
      'smartphone', 'mobile', 'phone', '5g', '4g', 'iphone', 'galaxy',
      'redmi', 'realme', 'iqoo', 'poco', 'vivo', 'oppo', 'oneplus', 'infinix',
      'tecno', 'lava', 'motorola', 'nothing phone', 'pixel', 'honor',
      'smartphone', 'feature phone', 'ram', 'gb ram',
    ],
  },
  {
    id: 'electronics',
    label: 'Electronics',
    words: [
      'laptop', 'notebook pc', 'macbook', 'chromebook', 'tablet', 'ipad',
      'monitor', 'television', 'smart tv', ' tv', 'led tv', 'earbuds', 'earphone',
      'headphone', 'headset', 'speaker', 'soundbar', 'airpods', 'powerbank',
      'power bank', 'charger', 'camera', 'dslr', 'mirrorless', 'smartwatch',
      'smart watch', 'printer', 'router', 'keyboard', 'mouse', 'pendrive',
      'hard disk', 'harddisk', 'ssd', 'graphics card', 'processor', 'motherboard',
      'trimmer', 'drone', 'gaming console', 'playstation', 'xbox',
    ],
  },
  {
    id: 'appliances',
    label: 'Home Appliances',
    words: [
      'refrigerator', 'fridge', 'washing machine', 'air conditioner', ' ac ',
      'microwave', 'oven', 'mixer grinder', 'grinder', 'cooker', 'kettle',
      'toaster', 'induction', 'chimney', 'vacuum cleaner', 'iron', 'fan',
      'cooler', 'heater', 'geyser', 'water purifier', 'dishwasher',
    ],
  },
  {
    id: 'fashion',
    label: 'Fashion',
    words: [
      'tshirt', 't-shirt', 'shirt', 'polo', 'top', 'blouse', 'tunic', 'kurta',
      'kurti', 'saree', 'sari', 'lehenga', 'salwar', 'chudidar', 'dupatta',
      'kaftan', 'caftan', 'abaya', 'kameez', 'anarkali', 'dress', 'gown', 'frock',
      'skirt', 'jeans', 'trouser', 'pant', 'chino', 'cargo', 'jogger', 'shorts',
      'capri', 'legging', 'trackpant', 'palazzo', 'jacket', 'blazer', 'coat',
      'sweater', 'sweatshirt', 'hoodie', 'pullover', 'cardigan', 'shrug',
      'waistcoat', 'sherwani', 'suit', 'shoe', 'sneaker', 'sandal', 'slipper',
      'flipflop', 'flip-flop', 'loafer', 'heel', 'boot', 'footwear', 'handbag',
      'backpack', 'wallet', 'belt', 'sunglass', 'watch', 'jewellery', 'jewelry',
      'earring', 'necklace', 'ring', 'bracelet', 'bangle',
    ],
  },
  {
    id: 'home',
    label: 'Home & Furniture',
    words: [
      'sofa', 'mattress', 'bedsheet', 'bed sheet', 'pillow', 'curtain', 'carpet',
      'rug', 'table', 'chair', 'desk', 'wardrobe', 'almirah', 'bookshelf',
      'shelf', 'storage', 'container', 'cookware', 'bottle', 'flask', 'lunchbox',
      'towel', 'utensil', 'decor', 'lamp', 'lighting', 'wall sticker',
    ],
  },
  {
    id: 'beauty',
    label: 'Beauty & Health',
    words: [
      'lipstick', 'nail polish', 'nailpolish', 'perfume', 'deodorant', 'shampoo',
      'conditioner', 'hair oil', 'serum', 'cream', 'lotion', 'sunscreen',
      'facewash', 'face wash', 'razor', 'shaver', 'sanitary', 'diaper',
      'medicine', 'supplement', 'protein', 'vitamin', 'mask', 'sanitizer',
      'trimmer', 'toothbrush', 'soap',
    ],
  },
];

/** Word-boundary match, tolerating a trailing plural. */
function hasWord(hay, word) {
  const w = String(word).trim();
  if (!w) return false;
  // Escape anything regex-special, then allow an optional plural and require a
  // word boundary on both sides so "top" does not match "laptop".
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '(s|es)?([^a-z0-9]|$)', 'i').test(hay);
}

/**
 * Infer a category from a product title.
 *
 * @param {string} title
 * @returns {{id: string, label: string, confidence: number, matched: string[]}}
 *   confidence is 0..1: 1 when several words agree or a very specific word
 *   matched, lower when a single common word did.
 */
function categoryFromTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return { id: 'other', label: 'Deals', confidence: 0, matched: [] };

  for (const cat of CATEGORIES) {
    const matched = cat.words.filter((w) => hasWord(t, w));
    if (!matched.length) continue;
    // A long, specific word is stronger evidence than a short, common one:
    // "smartphone" all but settles it, "top" does not.
    const longest = matched.reduce((a, b) => (b.length > a.length ? b : a), '');
    let confidence = 0.5;
    if (matched.length > 1) confidence = 0.8;
    if (longest.length >= 8) confidence = Math.max(confidence, 0.9);
    if (longest.length >= 12) confidence = 1;
    return { id: cat.id, label: cat.label, confidence, matched };
  }

  return { id: 'other', label: 'Deals', confidence: 0, matched: [] };
}

/**
 * The search terms to fetch deals for, per category.
 *
 * Used to steer the deal scrape toward what the viewer is actually looking at.
 * Only the categories with a real listing search are listed; anything else falls
 * back to the general set, which is what the channel posts anyway.
 */
const CATEGORY_SOURCES = {
  mobile: [
    'https://www.flipkart.com/search?q=mobile&sort=popularity',
    'https://www.flipkart.com/search?q=smartphone%20under%2015000&sort=popularity',
    'https://www.flipkart.com/search?q=5g%20mobile&sort=popularity',
  ],
  electronics: [
    'https://www.flipkart.com/search?q=laptop&sort=popularity',
    'https://www.flipkart.com/search?q=earbuds&sort=popularity',
    'https://www.flipkart.com/search?q=smartwatch&sort=popularity',
    'https://www.flipkart.com/search?q=smart%20tv&sort=popularity',
  ],
  appliances: [
    'https://www.flipkart.com/search?q=washing%20machine&sort=popularity',
    'https://www.flipkart.com/search?q=refrigerator&sort=popularity',
    'https://www.flipkart.com/search?q=mixer%20grinder&sort=popularity',
  ],
  fashion: [
    'https://www.flipkart.com/search?q=fashion%20sale&sort=popularity',
    'https://www.flipkart.com/search?q=shoes&sort=popularity',
    'https://www.flipkart.com/search?q=kurta&sort=popularity',
  ],
  home: [
    'https://www.flipkart.com/search?q=home%20decor&sort=popularity',
    'https://www.flipkart.com/search?q=mattress&sort=popularity',
  ],
  beauty: [
    'https://www.flipkart.com/search?q=beauty&sort=popularity',
    'https://www.flipkart.com/search?q=personal%20care&sort=popularity',
  ],
};

/** Listing pages for a category, or null when we have none for it. */
function sourcesForCategory(id) {
  return CATEGORY_SOURCES[String(id || '').toLowerCase()] || null;
}

/** Every category id we know, for /diag and tests. */
function allCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, label: c.label }));
}

module.exports = {
  categoryFromTitle,
  sourcesForCategory,
  allCategories,
  CATEGORY_SOURCES,
  hasWord,
};
