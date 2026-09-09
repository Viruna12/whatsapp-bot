const express = require('express');
const path = require('path');
const pino = require('pino');
const os = require('os');
const fs = require('fs');
const { restoreSession, saveSessionToFirebase } = require('./firebase-session');

const app = express();
const PORT = process.env.PORT || 3000;
const PREFIX = '.';
const startTime = Date.now();

// Vercel හිදී /tmp/session, Local/Actions හිදී ./session
const SESSION_PATH = process.env.VERCEL ? '/tmp/session' : './session';

let settings = {
  alwaysOnline: true,
  autoStatusSeen: true,
  autoTyping: false,
  autoRecording: true,
  antiDelete: true
};

const messageCache = new Map();
let sock = null;

// Home Page එක කෙලින්ම Serve කිරීම (Path Errors නැත)
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

// Bot Engine Initialization (Dynamic Import - ERR_REQUIRE_ESM Fix)
async function initBot() {
  await restoreSession(SESSION_PATH);

  // Dynamic Baileys Import
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveSessionToFirebase(SESSION_PATH);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(initBot, 3000);
      }
    } else if (connection === 'open') {
      console.log('🚀 WhatsApp Bot Connected & Online!');
      if (settings.alwaysOnline) {
        await sock.sendPresenceUpdate('available');
      }
    }
  });

  // Message Events
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;

    // Auto Status Seen
    if (from === 'status@broadcast' && settings.autoStatusSeen) {
      await sock.readMessages([msg.key]);
      return;
    }

    messageCache.set(msg.key.id, msg);
    if (messageCache.size > 1500) {
      const oldest = messageCache.keys().next().value;
      messageCache.delete(oldest);
    }

    // Anti-Delete Recovery
    if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
      if (settings.antiDelete) {
        const deletedKey = msg.message.protocolMessage.key;
        const saved = messageCache.get(deletedKey.id);
        if (saved) {
          const sender = deletedKey.participant || deletedKey.remoteJid;
          const text = saved.message.conversation || saved.message.extendedTextMessage?.text || '[Media]';
          await sock.sendMessage(from, {
            text: `⚠️ *Deleted Message Detected!*\n\n👤 *Sender:* @${sender.split('@')[0]}\n💬 *Text:* ${text}`,
            mentions: [sender]
          });
        }
      }
      return;
    }

    if (msg.key.fromMe) return;

    if (settings.autoTyping) await sock.sendPresenceUpdate('composing', from);
    else if (settings.autoRecording) await sock.sendPresenceUpdate('recording', from);

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    switch (cmd) {
      case 'menu':
      case 'help': {
        const text = `🤖 *MINI BOT MENU*\n\n` +
          `🔹 *${PREFIX}ping* - Speed test\n` +
          `🔹 *${PREFIX}alive* - Status\n` +
          `🔹 *${PREFIX}runtime* - Uptime\n` +
          `🔹 *${PREFIX}system* - System stats\n` +
          `🔹 *${PREFIX}settings* - Toggle features\n` +
          `🔹 *${PREFIX}vv* - Recover View Once\n` +
          `🔹 *${PREFIX}calc <math>* - Calculator\n` +
          `🔹 *${PREFIX}say <text>* - Echo text\n` +
          `🔹 *${PREFIX}quote* - Motivation\n` +
          `🔹 *${PREFIX}joke* - Random joke`;
        await sock.sendMessage(from, { text }, { quoted: msg });
        break;
      }
      case 'ping': {
        const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
        await sock.sendMessage(from, { text: `⚡ Speed: ${Math.abs(latency)}ms` }, { quoted: msg });
        break;
      }
      case 'alive': {
        await sock.sendMessage(from, { text: '🟢 *Bot is Active!*' }, { quoted: msg });
        break;
      }
      case 'runtime': {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        await sock.sendMessage(from, { text: `⏱️ Uptime: ${Math.floor(sec / 60)} mins` }, { quoted: msg });
        break;
      }
      case 'system': {
        const free = (os.freemem() / (1024 * 1024)).toFixed(0);
        await sock.sendMessage(from, { text: `💻 Free RAM: ${free}MB` }, { quoted: msg });
        break;
      }
      case 'vv': {
        const q = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const vo = q?.viewOnceMessageV2?.message || q?.viewOnceMessage?.message;
        if (!vo) return sock.sendMessage(from, { text: 'Reply to a View Once with .vv' }, { quoted: msg });
        const type = Object.keys(vo)[0];
        const stream = await downloadContentFromMessage(vo[type], type.replace('Message', ''));
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        if (type === 'imageMessage') await sock.sendMessage(from, { image: buf, caption: '🔓 *Recovered*' }, { quoted: msg });
        else if (type === 'videoMessage') await sock.sendMessage(from, { video: buf, caption: '🔓 *Recovered*' }, { quoted: msg });
        break;
      }
      case 'settings': {
        const opt = args[0]?.toLowerCase();
        if (opt === 'online') settings.alwaysOnline = !settings.alwaysOnline;
        else if (opt === 'status') settings.autoStatusSeen = !settings.autoStatusSeen;
        else if (opt === 'antidelete') settings.antiDelete = !settings.antiDelete;
        else if (opt === 'typing') { settings.autoTyping = !settings.autoTyping; settings.autoRecording = false; }
        else if (opt === 'recording') { settings.autoRecording = !settings.autoRecording; settings.autoTyping = false; }
        const panel = `⚙️ *SETTINGS*\n\nOnline: ${settings.alwaysOnline ? '✅' : '❌'}\nStatus Seen: ${settings.autoStatusSeen ? '✅' : '❌'}\nAnti Delete: ${settings.antiDelete ? '✅' : '❌'}\nTyping: ${settings.autoTyping ? '✅' : '❌'}\nRecording: ${settings.autoRecording ? '✅' : '❌'}`;
        await sock.sendMessage(from, { text: panel }, { quoted: msg });
        break;
      }
      case 'calc': {
        try {
          const res = Function(`'use strict'; return (${args.join(' ')})`)();
          await sock.sendMessage(from, { text: `🧮 Result: ${res}` });
        } catch {
          await sock.sendMessage(from, { text: '❌ Invalid Math' });
        }
        break;
      }
      case 'say': {
        await sock.sendMessage(from, { text: args.join(' ') });
        break;
      }
      case 'quote': {
        await sock.sendMessage(from, { text: '💬 "Never give up on your dreams."' });
        break;
      }
      case 'joke': {
        await sock.sendMessage(from, { text: '😄 Why do programmers prefer dark mode? Because light attracts bugs!' });
        break;
      }
    }
  });

  return sock;
}

// Live Streaming Pair Endpoint (Dynamic Import)
app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: 'Number required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');

    const sessionPath = '/tmp/session_' + Date.now();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const pairSock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    pairSock.ev.on('creds.update', saveCreds);

    const code = await pairSock.requestPairingCode(number);
    res.write(`data: ${JSON.stringify({ code })}\n\n`);

    const checkConnect = setInterval(async () => {
      if (pairSock?.authState?.creds?.registered) {
        clearInterval(checkConnect);
        await saveSessionToFirebase(sessionPath);
        res.write(`data: ${JSON.stringify({ status: 'connected' })}\n\n`);
        res.end();
      }
    }, 2000);

    setTimeout(() => {
      clearInterval(checkConnect);
      res.end();
    }, 55000);

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// GitHub Actions වලදී Bot එක run කරයි
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await initBot();
  });
}

module.exports = app;
