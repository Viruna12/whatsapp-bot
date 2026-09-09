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

// 1. Web UI (Home Page)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bot Pairing</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .box { background: #111b21; padding: 2rem; border-radius: 16px; width: 90%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #202c33; }
    h2 { color: #00a884; margin-top: 0; }
    p { font-size: 14px; color: #8696a0; margin-bottom: 20px; }
    input { width: 100%; padding: 14px; margin-bottom: 15px; border-radius: 8px; border: 1px solid #2a3942; background: #202c33; color: #fff; box-sizing: border-box; font-size: 16px; outline: none; }
    input:focus { border-color: #00a884; }
    button { width: 100%; padding: 14px; border: none; border-radius: 8px; background: #00a884; color: #111b21; font-weight: bold; cursor: pointer; font-size: 16px; }
    button:disabled { background: #3b4a54; color: #8696a0; cursor: not-allowed; }
    .result { margin-top: 20px; padding: 15px; background: #202c33; border-radius: 8px; border: 1px dashed #00a884; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #25d366; display: none; }
    .status { margin-top: 15px; font-size: 14px; color: #ffd279; }
    .success { color: #25d366; font-weight: bold; }
  </style>
</head>
<body>
  <div class="box">
    <h2>WhatsApp Pair Web</h2>
    <p>Enter phone number with country code without + (e.g. 94712345678)</p>
    <input type="text" id="phone" placeholder="947xxxxxxxx" />
    <button id="btn" onclick="startPairing()">Get Pairing Code</button>
    <div id="code" class="result"></div>
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
      btn.innerText = 'Connecting...';
      codeBox.style.display = 'none';
      status.innerText = 'Requesting code from WhatsApp...';

      const eventSource = new EventSource('/pair?number=' + phone);

      eventSource.onmessage = function(event) {
        const data = JSON.parse(event.data);
        if (data.code) {
          codeBox.innerText = data.code;
          codeBox.style.display = 'block';
          status.innerText = '👉 Enter this code on WhatsApp > Linked Devices > Link with phone number';
          btn.innerText = 'Waiting for phone...';
        }
        if (data.status === 'connected') {
          status.innerHTML = '<span class="success">🎉 WhatsApp Connected & Synced to Firebase! You can close this tab now.</span>';
          btn.innerText = 'Connected!';
          eventSource.close();
        }
        if (data.error) {
          alert(data.error);
          eventSource.close();
          btn.disabled = false;
          btn.innerText = 'Get Pairing Code';
        }
      };

      eventSource.onerror = function() {
        eventSource.close();
        btn.disabled = false;
        btn.innerText = 'Get Pairing Code';
      };
    }
  </script>
</body>
</html>`);
});

// 2. Pair Endpoint (Dynamic Import එකෙන් Baileys load කිරීම)
app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: 'Number required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sessionPath = '/tmp/session_' + Date.now();

  try {
    // Dynamic import - ERR_REQUIRE_ESM Fix!
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    const code = await sock.requestPairingCode(number);
    res.write(`data: ${JSON.stringify({ code })}\n\n`);

    const checkInterval = setInterval(async () => {
      if (sock.authState?.creds?.registered) {
        clearInterval(checkInterval);

        if (admin.apps.length) {
          try {
            const files = fs.readdirSync(sessionPath);
            const updates = {};
            for (const file of files) {
              const content = fs.readFileSync(path.join(sessionPath, file), 'utf-8');
              updates[Buffer.from(file).toString('hex')] = content;
            }
            await admin.database().ref('whatsapp_session').set(updates);
            console.log('Firebase synced from Vercel.');
          } catch (err) {
            console.error('Firebase save error:', err);
          }
        }

        res.write(`data: ${JSON.stringify({ status: 'connected' })}\n\n`);
        res.end();
      }
    }, 2000);

    setTimeout(() => {
      clearInterval(checkInterval);
      res.end();
    }, 55000);

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

module.exports = app;
