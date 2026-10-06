/**
 * lib/firebase.js
 * ---------------------------------------------------------------------------
 * Firebase Admin + Firestore connection, shared by every serverless function.
 *
 * Why a singleton: Vercel may invoke the same lambda container many times, and
 * admin.initializeApp() throws if called twice on the same app. Guarding on
 * admin.apps.length keeps hot invocations cheap and avoids the duplicate-app
 * error.
 *
 * Credentials come from a single env var (see STEP 6 for how to generate it):
 *   FIREBASE_SERVICE_ACCOUNT_KEY  -> the service-account JSON, either raw
 *                                    (starts with "{") or base64-encoded.
 * ---------------------------------------------------------------------------
 */

const admin = require('firebase-admin');

let app;

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY is not set. Add it to your Vercel ' +
        'Environment Variables (and to .env.local for `vercel dev`).'
    );
  }

  // Accept either a raw JSON string or a base64-encoded one. Base64 is handy
  // because Vercel dashboards and CI tools often mangle multi-line JSON.
  let serviceAccount;
  try {
    const trimmed = raw.trim();
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    serviceAccount = JSON.parse(json);
  } catch (err) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY could not be parsed as JSON or base64 ' +
        'JSON: ' + err.message
    );
  }

  // When the key is pasted into an env var, real newlines often arrive as the
  // two characters "\n". Restore them or the credential signing fails.
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
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
};

module.exports = { admin, db, COLLECTIONS };
