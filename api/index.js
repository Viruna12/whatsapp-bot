const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

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

// 1. Web UI එක (QR Code එක Screen එකේ පෙන්වන පිටුව)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Web QR Scan</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #111b21; padding: 2.5rem; border-radius: 16px; width: 90%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #202c33; }
    h2 { color: #00a884; margin: 0 0 10px 0; }
    p { font-size: 14px; color: #8696a0; margin-bottom: 25px; line-height: 1.4; }
    .qr-box { background: #fff; padding: 15px; border-radius: 12px; display: inline-block; min-width: 240px; min-height: 240px; box-sizing: border-box; }
    #qr-img { width: 230px; height: 230px; display: none; }
    #spinner { color: #111b21; font-weight: bold; margin-top: 100px; font-size: 15px; }
    .status { margin-top: 20px; font-size: 15px; color: #ffd279; }
    .success { color: #25d366; font-size: 18px; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Scan WhatsApp QR</h2>
    <p>Open WhatsApp > Settings > Linked Devices > <b>Link a Device</b> and scan this QR code.</p>
    
    <div class="qr-box">
      <div id="spinner">Loading QR Code...</div>
      <img id="qr-img" src="" alt="QR Code" />
    </div>

    <div id="status" class="status">Connecting to WhatsApp...</div>
  </div>

  <script>
    const qrImg = document.getElementById('qr-img');
    const spinner = document.getElementById('spinner');
    const status = document.getElementById('status');

    // Realtime QR Stream
    const evt = new EventSource('/qr-stream');

    evt.onmessage = function(e) {
      const data = JSON.parse(e.data);

      if (data.qr) {
        qrImg.src = data.qr;
        qrImg.style.display = 'block';
        spinner.style.display = 'none';
        status.innerText = '👉 Scan the QR code now with WhatsApp!';
      }

      if (data.connected) {
        document.querySelector('.qr-box').style.display = 'none';
        status.innerHTML = '<span class="success">🎉 WhatsApp Connected & Synced to Firebase! You can close this window.</span>';
        evt.close();
      }

      if (data.error) {
        status.innerText = 'Error: ' + data.error;
        evt.close();
      }
    };

    evt.onerror = function() {
      status.innerText = 'Connection lost. Please refresh the page.';
      evt.close();
    };
  </script>
</body>
</html>`);
});

// 2. Realtime QR Stream Endpoint (Dynamic Import & Auto-Sync)
app.get('/qr-stream', async (req, res) => {
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

    const QRCode = (await import('qrcode')).default;

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

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      // QR එක Web එකට යැවීම
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          res.write(`data: ${JSON.stringify({ qr: qrDataUrl })}\n\n`);
        } catch (err) {
          console.error('QR to DataURL error:', err);
        }
      }

      // Scan වූ පසු Firebase එකට Auto-Upload කිරීම
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
            console.log('Session successfully synced to Firebase!');
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

    // Timeout (තත්පර 55කින් Vercel crash වීම වළක්වයි)
    setTimeout(() => {
      res.end();
    }, 55000);

  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = app;
