/**
 * lib/firebase.js
 * ---------------------------------------------------------------------------
 * Firebase Admin + Firestore connection, shared by every serverless function.
 *
 * Credentials can be supplied in EITHER of two ways — whichever is easier for
 * you to paste correctly:
 *
 *   A) FIREBASE_SERVICE_ACCOUNT_KEY
 *        The service-account JSON, either raw (starts with "{") or base64.
 *        Handy on desktop; easy to break by mangling the private key's line
 *        breaks when copying on a phone.
 *
 *   B) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *        Three separate values. No JSON to get wrong. If A is set but fails to
 *        parse AND these three are complete, we fall back to these.
 *
 * If admin.initializeApp() were called twice it would throw, so we guard on
 * admin.apps.length to keep hot invocations cheap.
 * ---------------------------------------------------------------------------
 */

const admin = require('firebase-admin');

/**
 * Repair the many ways a PEM private key gets mangled when it is pasted into an
 * environment variable: surrounding quotes, literal "\n" instead of newlines,
 * newlines turned into spaces, CRLF, a missing trailing newline, or the
 * BEGIN/END lines being lost entirely. We re-extract the label and body and
 * re-wrap the body at 64 characters, which is valid PEM.
 */
function normalizePrivateKey(key) {
  if (!key) return key;
  let k = String(key).trim();

  // Strip surrounding quotes (common when copied straight out of the JSON).
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }

  k = k.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');

  const m = k.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1].trim();
    const body = m[2].replace(/\s+/g, '');
    const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
    return '-----BEGIN ' + label + '-----\n' + wrapped + '\n-----END ' + label + '-----\n';
  }

  // No PEM headers at all — assume a bare base64 body.
  const body = k.replace(/\s+/g, '');
  if (body.length > 100) {
    const wrapped = (body.match(/.{1,64}/g) || []).join('\n');
    return '-----BEGIN PRIVATE KEY-----\n' + wrapped + '\n-----END PRIVATE KEY-----\n';
  }

  return k;
}

/**
 * Parse FIREBASE_SERVICE_ACCOUNT_KEY, which may be raw JSON or base64 of JSON.
 * Handles the common paste corruption where the JSON file's escaped "\n" inside
 * private_key get turned into REAL newlines — that makes the JSON invalid, but
 * it is repairable by re-escaping the newlines inside that one string.
 */
function parseServiceAccountJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const candidates = [text];
  // If it doesn't look like JSON, it is probably base64 of the JSON.
  if (!text.startsWith('{')) {
    try {
      candidates.push(Buffer.from(text, 'base64').toString('utf8'));
    } catch (err) {
      /* not base64 */
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      /* try the repaired form below */
    }
    try {
      const repaired = candidate.replace(
        /("private_key"\s*:\s*")([\s\S]*?)("\s*(?:,|\}))/,
        (m, a, body, c) => a + body.replace(/\r?\n/g, '\\n') + c
      );
      return JSON.parse(repaired);
    } catch (err) {
      /* move on */
    }
  }
  return null;
}

/**
 * Resolve the service-account object from the environment.
 * Exported so it can be unit-tested without initialising the SDK.
 */
function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const hasParts = Boolean(projectId && clientEmail && privateKey);

  if (raw) {
    const parsed = parseServiceAccountJson(raw);
    if (parsed) return parsed;
    if (!hasParts) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_KEY could not be parsed as JSON or base64 JSON: ' +
          'paste the whole service-account file as a single line, or set FIREBASE_PROJECT_ID, ' +
          'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY instead'
      );
    }
    // Combined value is broken but the three parts are present — use those.
    console.warn('FIREBASE_SERVICE_ACCOUNT_KEY was unusable; falling back to the three individual variables.');
  }

  if (hasParts) {
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }

  throw new Error(
    'Firebase credentials are not set. Provide FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON or base64) ' +
      'OR all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.'
  );
}

let app;

if (!admin.apps.length) {
  const serviceAccount = loadServiceAccount();

  // When the key is pasted into an env var, real newlines often arrive as the
  // two characters "\n". Restore them or the credential signing fails. (If the
  // value already has real newlines, this is a harmless no-op.)
  if (serviceAccount.private_key) {
    serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
    // Helpful, non-sensitive diagnostics: shape and length, never the key itself.
    const firstLine = String(serviceAccount.private_key).split('\n')[0];
    console.log('private_key normalised: header="' + firstLine + '" length=' + String(serviceAccount.private_key).length);
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  app = admin.apps[0];
}

const db = admin.firestore();

// Prevents "Cannot use undefined as a Firestore value" crashes when optional
// fields (e.g. an image URL we could not scrape) come back undefined.
db.settings({ ignoreUndefinedProperties: true });

/** Firestore collection names, kept in one place so nothing drifts. */
const COLLECTIONS = {
  USERS: 'users', // one doc per Telegram user
  PRODUCTS: 'products', // one doc per tracked product
  PRICE_HISTORY: 'price_history', // subcollection: products/{id}/price_history
  DEALS_POSTED: 'deals_posted', // one doc per deal already posted to the channel
};

module.exports = { admin, db, COLLECTIONS, loadServiceAccount, normalizePrivateKey, parseServiceAccountJson };
