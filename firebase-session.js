const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env variable');
  }
} else if (fs.existsSync('./firebase-key.json')) {
  serviceAccount = require('./firebase-key.json');
}

const dbUrl = process.env.FIREBASE_DB_URL || (serviceAccount && serviceAccount.databaseURL);

if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  });
}

const db = admin.apps.length ? admin.database() : null;
const sessionRef = db ? db.ref('whatsapp_session') : null;

// Firebase එකෙන් Session Restore කිරීම
async function restoreSession() {
  if (!sessionRef) {
    console.log('⚠️ Firebase Database reference is not initialized.');
    return false;
  }
  if (!fs.existsSync('./session')) fs.mkdirSync('./session', { recursive: true });

  try {
    const snapshot = await sessionRef.once('value');
    const sessionData = snapshot.val();

    if (sessionData) {
      for (const [key, content] of Object.entries(sessionData)) {
        const filename = Buffer.from(key, 'hex').toString('utf-8');
        fs.writeFileSync(path.join('./session', filename), content, 'utf-8');
      }
      console.log('✅ Session restored from Firebase successfully!');
      return true;
    }
  } catch (err) {
    console.error('Firebase Restore Error:', err.message);
  }
  return false;
}

// Session එක Firebase එකට Backup කිරීම
async function saveSessionToFirebase() {
  if (!sessionRef || !fs.existsSync('./session')) return;
  try {
    const files = fs.readdirSync('./session');
    const updates = {};
    for (const filename of files) {
      const content = fs.readFileSync(path.join('./session', filename), 'utf-8');
      const safeKey = Buffer.from(filename).toString('hex');
      updates[safeKey] = content;
    }
    await sessionRef.set(updates);
    console.log('☁️ Session synced to Firebase successfully.');
  } catch (err) {
    console.error('Firebase Save Error:', err.message);
  }
}

module.exports = { restoreSession, saveSessionToFirebase };
