/**
 * lib/paapi.js
 * ---------------------------------------------------------------------------
 * Amazon Product Advertising API (PA-API 5) — the OFFICIAL way to read an
 * Amazon title, price and image.
 *
 * Why this exists: Amazon refuses ordinary page requests from a datacenter IP,
 * so scraping amazon.in from Koyeb returns a robot-check page. No header, agent
 * or cookie change fixes that — it is an IP-level refusal. PA-API is an
 * authenticated API call that is *meant* to be made from a server, so it is not
 * blocked, and it returns exactly the fields the bot needs.
 *
 * It is entirely optional. With no credentials configured, every function here
 * returns null and the scraper falls back to its existing behaviour.
 *
 * Configuration — environment variables only, never hardcoded:
 *   PAAPI_ACCESS_KEY     your Associates API access key
 *   PAAPI_SECRET_KEY     your Associates API secret
 *   PAAPI_PARTNER_TAG    your Associates tag, e.g. offerszones03-21
 *   PAAPI_HOST           default webservices.amazon.in
 *   PAAPI_REGION         default eu-west-1  (the region for amazon.in)
 *   PAAPI_MARKETPLACE    default www.amazon.in
 *
 * Access is granted by Amazon to Associates with qualifying sales.
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');
const axios = require('axios');
require('./httpAgent');

const SERVICE = 'ProductAdvertisingAPI';
const TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems';
const PATH = '/paapi5/getitems';
const TIMEOUT = parseInt(process.env.PAAPI_TIMEOUT_MS || '6000', 10);

function paapiConfigured() {
  return Boolean(process.env.PAAPI_ACCESS_KEY && process.env.PAAPI_SECRET_KEY && process.env.PAAPI_PARTNER_TAG);
}

function host() {
  return process.env.PAAPI_HOST || 'webservices.amazon.in';
}
function region() {
  return process.env.PAAPI_REGION || 'eu-west-1';
}
function marketplace() {
  return process.env.PAAPI_MARKETPLACE || 'www.amazon.in';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}

/** AWS Signature Version 4 for the PA-API request. */
function sign(body, amzDate) {
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonicalHeaders =
    'content-encoding:amz-1.0\n' +
    'content-type:application/json; charset=utf-8\n' +
    'host:' + host() + '\n' +
    'x-amz-date:' + amzDate + '\n' +
    'x-amz-target:' + TARGET + '\n';
  const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';

  const canonicalRequest = [
    'POST',
    PATH,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = dateStamp + '/' + region() + '/' + SERVICE + '/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + process.env.PAAPI_SECRET_KEY, dateStamp);
  const kRegion = hmac(kDate, region());
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return (
    'AWS4-HMAC-SHA256 Credential=' + process.env.PAAPI_ACCESS_KEY + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  );
}

/**
 * Look up one ASIN.
 * @returns {Promise<{title: string|null, price: number|null, mrp: number|null, image: string|null, inStock: boolean|null}|null>}
 */
async function lookupAsin(asin) {
  if (!paapiConfigured() || !asin) return null;

  const body = JSON.stringify({
    ItemIds: [String(asin)],
    Resources: [
      'ItemInfo.Title',
      'Offers.Listings.Price',
      'Offers.Listings.SavingBasis',
      'Offers.Listings.Availability.Message',
      'Images.Primary.Large',
    ],
    PartnerTag: process.env.PAAPI_PARTNER_TAG,
    PartnerType: 'Associates',
    Marketplace: marketplace(),
  });

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  try {
    const res = await axios.post('https://' + host() + PATH, body, {
      timeout: TIMEOUT,
      headers: {
        'content-encoding': 'amz-1.0',
        'content-type': 'application/json; charset=utf-8',
        'x-amz-date': amzDate,
        'x-amz-target': TARGET,
        host: host(),
        Authorization: sign(body, amzDate),
      },
      validateStatus: () => true,
    });

    if (res.status !== 200 || !res.data || !res.data.ItemsResult) {
      const detail = res.data && res.data.Errors ? JSON.stringify(res.data.Errors).slice(0, 200) : 'status ' + res.status;
      console.warn('paapi lookup failed for ' + asin + ': ' + detail);
      return null;
    }

    const item = (res.data.ItemsResult.Items || [])[0];
    if (!item) return null;

    const title = item.ItemInfo && item.ItemInfo.Title && item.ItemInfo.Title.DisplayValue;
    const listing = item.Offers && item.Offers.Listings && item.Offers.Listings[0];
    const price = listing && listing.Price && listing.Price.Amount != null ? Number(listing.Price.Amount) : null;
    const mrp =
      listing && listing.SavingBasis && listing.SavingBasis.Amount != null
        ? Number(listing.SavingBasis.Amount)
        : null;
    const image =
      item.Images && item.Images.Primary && item.Images.Primary.Large && item.Images.Primary.Large.URL;
    const availability = listing && listing.Availability && listing.Availability.Message;
    const inStock = availability ? !/out of stock|currently unavailable|unavailable/i.test(availability) : null;

    return {
      title: title ? String(title).replace(/\s+/g, ' ').trim() : null,
      price: price,
      mrp: mrp && price && mrp > price ? mrp : null,
      image: image || null,
      inStock,
      source: 'paapi',
    };
  } catch (err) {
    console.warn('paapi request failed for ' + asin + ': ' + err.message);
    return null;
  }
}

module.exports = { lookupAsin, paapiConfigured };

// Exposed for tests.
module.exports._sign = sign;
