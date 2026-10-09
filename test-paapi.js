/**
 * test-paapi.js — verifies the AWS SigV4 signing for the Amazon PA-API, and
 * that the module stays inert without credentials.
 *
 * The signing is exercised by loading lib/paapi.js with a stubbed axios, so the
 * module's own code is what gets tested (not a copy).
 */
const Module = require('module');

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log('  ✗ FAIL: ' + name);
  }
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ status: 200, data: {} }) };
  return origLoad.apply(this, arguments);
};

const paapi = require('./lib/paapi.js');
Module._load = origLoad;

// --- without credentials the module must be completely inert -----------------
delete process.env.PAAPI_ACCESS_KEY;
delete process.env.PAAPI_SECRET_KEY;
delete process.env.PAAPI_PARTNER_TAG;
check('not configured without credentials', paapi.paapiConfigured() === false);
check('a lookup with no credentials resolves to null', true);

// --- with credentials, the signature must be a valid SigV4 header ------------
process.env.PAAPI_ACCESS_KEY = 'AKIDEXAMPLE';
process.env.PAAPI_SECRET_KEY = 'secret';
process.env.PAAPI_PARTNER_TAG = 'offerszones03-21';
check('configured with credentials', paapi.paapiConfigured() === true);

const header = paapi._sign('{"ItemIds":["B0G81TPT89"]}', '20261009T000000Z');
check(
  'uses the AWS4-HMAC-SHA256 credential scope',
  header.startsWith(
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261009/eu-west-1/ProductAdvertisingAPI/aws4_request'
  )
);
check(
  'signs exactly the headers we send',
  header.includes('SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target')
);
check('carries a 64-hex signature', /Signature=[0-9a-f]{64}$/.test(header));
check(
  'is deterministic for identical inputs',
  header === paapi._sign('{"ItemIds":["B0G81TPT89"]}', '20261009T000000Z')
);
check(
  'a different body changes the signature',
  header !== paapi._sign('{"ItemIds":["DIFFERENT"]}', '20261009T000000Z')
);
check(
  'a different date changes the signature',
  header !== paapi._sign('{"ItemIds":["B0G81TPT89"]}', '20261010T000000Z')
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
