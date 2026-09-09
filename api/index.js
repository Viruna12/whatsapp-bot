const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const app = express();

// Firebase Init
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } catch (e) {
    console.error('Firebase Parse Error:', e.message);
  }
}

const dbUrl = process.env.FIREBASE_DB_URL || (serviceAccount && serviceAccount.databaseURL);

if (serviceAccount && dbUrl && !admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: dbUrl
    });
  } catch (e) {
    console.error('Firebase Init Error:', e.message);
  }
}

// 1. Web UI (Pairing Page)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Pairing Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #111b21; padding: 2.5rem; border-radius: 16px; width: 90%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #202c33; }
    h2 { color: #00a884; margin-top: 0; }
    p { font-size: 14px; color: #8696a0; margin-bottom: 20px; line-height: 1.4; }
    input { width: 100%; padding: 14px; margin-bottom: 15px; border-radius: 8px; border: 1px solid #2a3942; background: #202c33; color: #fff; box-sizing: border-box; font-size: 16px; outline: none; text-align: center; font-weight: bold; }
    input:focus { border-color: #00a884; }
    button { width: 100%; padding: 14px; border: none; border-radius: 8px; background: #00a884; color: #111b21; font-weight: bold; cursor: pointer; font-size: 16px; transition: 0.2s; }
    button:hover { background: #02906f; }
    button:disabled { background: #3b4a54; color: #8696a0; cursor: not-allowed; }
    .code-box { margin-top: 20px; padding: 15px; background: #202c33; border-radius: 8px; border: 1px dashed #00a884; font-size: 26px; font-weight: bold; letter-spacing: 5px; color: #25d366; display: none; }
    .status { margin-top: 15px; font-size: 14px; color: #ffd279; line-height: 1.4; }
    .success { color: #25d366; font-size: 17px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <h2>WhatsApp Pair Code</h2>
    <p>Enter your phone number with country code (e.g. <b>94773796358</b>)</p>
    
    <input type="text" id="phone" placeholder="947xxxxxxxx" value="94773796358" />
    <button id="btn" onclick="startPairing()">Get Pairing Code</button>
    
    <div id="code" class="code-box"></div>
    <div id="status" class="status"></div>
  </div>

  <script>
    function startPairing() {
      const phone = document.getElementById('phone').value.trim().replace(/[^0-9]/g, '');
      const btn = document.getElementById('btn');
      const codeBox = document.getElementById('code');
      const status = document.getElementById('status');

      if (!phone) return alert('Enter a valid phone number');

      btn.disabled = true;
      btn.innerText = 'Connecting to WhatsApp...';
      codeBox.style.display = 'none';
      status.innerText = '⏳ Connecting and requesting notification...';

      const evt = new EventSource('/pair-stream?number=' + phone);

      evt.onmessage = function(e) {
        const data = JSON.parse(e.data);

        if (data.code) {
          codeBox.innerText = data.code;
          codeBox.style.display = 'block';
          btn.innerText = 'Waiting for your approval...';
          status.innerHTML = '🔔 <b>Check your Phone!</b><br>Tap the WhatsApp notification or enter this code in <b>Linked Devices > Link with phone number</b>.';
        }

        if (data.connected) {
          status.innerHTML = '<span class="success">🎉 WhatsApp Connected & Synced to Firebase! You are all set!</span>';
          btn.innerText = 'Connected!';
          evt.close();
        }

        if (data.error) {
          alert('Error: ' + data.error);
          status.innerText = 'Failed: ' + data.error;
          btn.disabled = false;
          btn.innerText = 'Try Again';
          evt.close();
        }
      };

      evt.onerror = function() {
        status.innerText = 'Connection timed out or closed. Please try again.';
        btn.disabled = false;
        btn.innerText = 'Get Pairing Code';
        evt.close();
      };
    }
  </script>
</body>
</html>`);
});

// 2. Realtime Pairing Stream (Notification Fix)
app.get('/pair-stream', async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: 'Phone number required' });

  const cleanNumber = number.replace(/[^0-9]/g, '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sessionPath = path.join('/tmp', 'session_' + Date.now());

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      DisconnectReason
    } = await import('@whiskeysockets/baileys');

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '124.0.0.0'], // WhatsApp notification trigger කරන standard browser header එක
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Socket handshake එක වෙන්න තත්පර 2.5ක් ඉඳලා request කිරීමෙන් Phone එකට Notification එක trigger වේ!
    setTimeout(async () => {
      try {
        if (!sock.authState?.creds?.registered) {
          const code = await sock.requestPairingCode(cleanNumber);
          res.write(`data: ${JSON.stringify({ code })}\n\n`);
        }
      } catch (err) {
        console.error('Pairing Code Request Error:', err);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      }
    }, 2500);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        if (admin.apps.length) {
          try {
            const files = fs.readdirSync(sessionPath);
            const updates = {};
            for (const file of files) {
              const content = fs.readFileSync(path.join(sessionPath, file), 'utf-8');
              updates[Buffer.from(file).toString('hex')] = content;
            }
            await admin.database().ref('whatsapp_session').set(updates);
            console.log('Session synced to Firebase successfully!');
          } catch (e) {
            console.error('Firebase save error:', e);
          }
        }

        res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);
        res.end();
      }

      if (connection === 'close') {
        const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        if (isLoggedOut) {
          res.write(`data: ${JSON.stringify({ error: 'Logged out' })}\n\n`);
          res.end();
        }
      }
    });

    setTimeout(() => res.end(), 55000);

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

module.exports = app;
