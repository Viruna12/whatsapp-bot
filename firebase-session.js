const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT JSON parse error:', e.message);
  }
} else if (fs.existsSync('./firebase-key.json')) {
  serviceAccount = require('./firebase-key.json');
}

const dbUrl = process.env.FIREBASE_DB_URL || (serviceAccount && serviceAccount.databaseURL);

if (serviceAccount && dbUrl && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  });
}

const db = admin.apps.length ? admin.database() : null;
const sessionRef = db ? db.ref('whatsapp_session') : null;

async function restoreSession(targetPath) {
  if (!sessionRef) {
    console.log('Firebase sessionRef is not available.');
    return false;
  }
  if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

  try {
    const snapshot = await sessionRef.once('value');
    const data = snapshot.val();
    if (data) {
      for (const [hexName, content] of Object.entries(data)) {
        const filename = Buffer.from(hexName, 'hex').toString('utf-8');
        fs.writeFileSync(path.join(targetPath, filename), content, 'utf-8');
      }
      console.log('✅ Session restored from Firebase successfully!');
      return true;
    }
  } catch (err) {
    console.error('Error restoring session:', err.message);
  }
  return false;
}

async function saveSessionToFirebase(targetPath) {
  if (!sessionRef || !fs.existsSync(targetPath)) return;
  try {
    const files = fs.readdirSync(targetPath);
    const updates = {};
    for (const filename of files) {
      const content = fs.readFileSync(path.join(targetPath, filename), 'utf-8');
      const hexName = Buffer.from(filename).toString('hex');
      updates[hexName] = content;
    }
    await sessionRef.set(updates);
    console.log('☁️ Session synced to Firebase successfully.');
  } catch (err) {
    console.error('Error saving session:', err.message);
  }
}

module.exports = { restoreSession, saveSessionToFirebase };
