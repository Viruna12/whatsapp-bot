const express = require('express');
const path = require('path');
const pino = require('pino');
const os = require('os');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { restoreSession, saveSessionToFirebase } = require('./firebase-session');

const app = express();
const PORT = process.env.PORT || 3000;
const PREFIX = '.';
const startTime = Date.now();

app.use(express.static(path.join(__dirname, 'public')));

// Dynamic Settings
let settings = {
  alwaysOnline: true,
  autoStatusSeen: true,
  autoTyping: false,
  autoRecording: true,
  antiDelete: true
};

const messageCache = new Map();
let sock = null;

async function initBot() {
  await restoreSession();

  const { state, saveCreds } = await useMultiFileAuthState('./session');
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
    await saveSessionToFirebase();
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

    // 1. Auto Status Seen
    if (from === 'status@broadcast' && settings.autoStatusSeen) {
      await sock.readMessages([msg.key]);
      return;
    }

    // Message Caching for Anti-Delete
    messageCache.set(msg.key.id, msg);
    if (messageCache.size > 1500) {
      const oldestKey = messageCache.keys().next().value;
      messageCache.delete(oldestKey);
    }

    // 2. Anti-Delete Recovery
    if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
      if (settings.antiDelete) {
        const deletedKey = msg.message.protocolMessage.key;
        const saved = messageCache.get(deletedKey.id);
        if (saved) {
          const sender = deletedKey.participant || deletedKey.remoteJid;
          const text =
            saved.message.conversation ||
            saved.message.extendedTextMessage?.text ||
            '[Media / Sticker]';

          await sock.sendMessage(from, {
            text: `⚠️ *Deleted Message Detected!*\n\n👤 *Sender:* @${sender.split('@')[0]}\n💬 *Message:* ${text}`,
            mentions: [sender]
          });
        }
      }
      return;
    }

    if (msg.key.fromMe) return;

    // 3. Auto Typing / Recording Presence
    if (settings.autoTyping) {
      await sock.sendPresenceUpdate('composing', from);
    } else if (settings.autoRecording) {
      await sock.sendPresenceUpdate('recording', from);
    }

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // 10 Core Commands
    switch (cmd) {
      // 1. Menu
      case 'menu':
      case 'help': {
        const menu =
          `🤖 *WHATSAPP MINI BOT* 🤖\n\n` +
          `🔹 *${PREFIX}ping* - Speed test\n` +
          `🔹 *${PREFIX}alive* - Status check\n` +
          `🔹 *${PREFIX}runtime* - Bot active time\n` +
          `🔹 *${PREFIX}system* - RAM & Server stats\n` +
          `🔹 *${PREFIX}settings* - Toggle bot features\n` +
          `🔹 *${PREFIX}vv* - Recover View Once media\n` +
          `🔹 *${PREFIX}calc <math>* - Calculator\n` +
          `🔹 *${PREFIX}say <text>* - Echo text\n` +
          `🔹 *${PREFIX}quote* - Motivation quote\n` +
          `🔹 *${PREFIX}joke* - Random tech joke`;
        await sock.sendMessage(from, { text: menu }, { quoted: msg });
        break;
      }

      // 2. Ping
      case 'ping': {
        const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
        await sock.sendMessage(from, { text: `⚡ *Speed:* ${Math.abs(latency)}ms` }, { quoted: msg });
        break;
      }

      // 3. Alive
      case 'alive': {
        await sock.sendMessage(from, { text: '🟢 *Bot is active and running at full speed!*' }, { quoted: msg });
        break;
      }

      // 4. Runtime
      case 'runtime': {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        await sock.sendMessage(from, { text: `⏱️ *Uptime:* ${h}h ${m}m ${s}s` }, { quoted: msg });
        break;
      }

      // 5. System Info
      case 'system': {
        const free = (os.freemem() / (1024 * 1024)).toFixed(1);
        const total = (os.totalmem() / (1024 * 1024)).toFixed(1);
        await sock.sendMessage(from, {
          text: `💻 *System Details*\n• OS: ${os.platform()}\n• Free RAM: ${free}MB / ${total}MB`
        }, { quoted: msg });
        break;
      }

      // 6. View Once Recovery (.vv)
      case 'vv': {
        const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const viewOnce = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message;

        if (!viewOnce) {
          return sock.sendMessage(from, { text: '❌ Reply to a View Once image or video with .vv' }, { quoted: msg });
        }

        const type = Object.keys(viewOnce)[0];
        const stream = await downloadContentFromMessage(viewOnce[type], type.replace('Message', ''));
        let buf = Buffer.from([]);
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);

        if (type === 'imageMessage') {
          await sock.sendMessage(from, { image: buf, caption: '🔓 *View Once Recovered*' }, { quoted: msg });
        } else if (type === 'videoMessage') {
          await sock.sendMessage(from, { video: buf, caption: '🔓 *View Once Recovered*' }, { quoted: msg });
        }
        break;
      }

      // 7. Settings
      case 'settings':
      case 'setting': {
        const opt = args[0]?.toLowerCase();
        if (opt === 'online') {
          settings.alwaysOnline = !settings.alwaysOnline;
          await sock.sendPresenceUpdate(settings.alwaysOnline ? 'available' : 'unavailable');
          await sock.sendMessage(from, { text: `Always Online: *${settings.alwaysOnline}*` });
        } else if (opt === 'status') {
          settings.autoStatusSeen = !settings.autoStatusSeen;
          await sock.sendMessage(from, { text: `Auto Status Seen: *${settings.autoStatusSeen}*` });
        } else if (opt === 'antidelete') {
          settings.antiDelete = !settings.antiDelete;
          await sock.sendMessage(from, { text: `Anti-Delete: *${settings.antiDelete}*` });
        } else if (opt === 'typing') {
          settings.autoTyping = !settings.autoTyping;
          settings.autoRecording = false;
          await sock.sendMessage(from, { text: `Auto Typing: *${settings.autoTyping}*` });
        } else if (opt === 'recording') {
          settings.autoRecording = !settings.autoRecording;
          settings.autoTyping = false;
          await sock.sendMessage(from, { text: `Auto Recording: *${settings.autoRecording}*` });
        } else {
          const panel =
            `⚙️ *SETTINGS PANEL*\n\n` +
            `• Always Online: ${settings.alwaysOnline ? '✅' : '❌'} (\`${PREFIX}settings online\`)\n` +
            `• Status Seen: ${settings.autoStatusSeen ? '✅' : '❌'} (\`${PREFIX}settings status\`)\n` +
            `• Anti Delete: ${settings.antiDelete ? '✅' : '❌'} (\`${PREFIX}settings antidelete\`)\n` +
            `• Auto Typing: ${settings.autoTyping ? '✅' : '❌'} (\`${PREFIX}settings typing\`)\n` +
            `• Auto Recording: ${settings.autoRecording ? '✅' : '❌'} (\`${PREFIX}settings recording\`)`;
          await sock.sendMessage(from, { text: panel });
        }
        break;
      }

      // 8. Calculator
      case 'calc': {
        try {
          const exp = args.join(' ');
          if (!exp || /[^0-9+\-*/(). ]/.test(exp)) throw new Error();
          const ans = Function(`'use strict'; return (${exp})`)();
          await sock.sendMessage(from, { text: `🧮 *Answer:* ${ans}` });
        } catch {
          await sock.sendMessage(from, { text: '❌ Invalid expression. Example: .calc 50*2' });
        }
        break;
      }

      // 9. Say (Echo)
      case 'say': {
        const text = args.join(' ');
        if (text) await sock.sendMessage(from, { text });
        break;
      }

      // 10. Quote
      case 'quote': {
        const quotes = [
          'Believe you can and you are halfway there.',
          'Quality is not an act, it is a habit.',
          'Your time is limited, do not waste it living someone else\'s life.'
        ];
        await sock.sendMessage(from, { text: `💬 ${quotes[Math.floor(Math.random() * quotes.length)]}` });
        break;
      }

      // 11. Joke
      case 'joke': {
        const jokes = [
          'Why do programmers prefer dark mode? Because light attracts bugs!',
          'There are 10 types of people: those who understand binary, and those who do not.',
          'A SQL query walks into a bar and asks: "Can I join you?"'
        ];
        await sock.sendMessage(from, { text: `😄 ${jokes[Math.floor(Math.random() * jokes.length)]}` });
        break;
      }
    }
  });

  return sock;
}

// Pair Web API Endpoint
app.get('/pair', async (req, res) => {
  const number = req.query.number;
  if (!number) return res.status(400).json({ error: 'Phone number required' });

  try {
    if (!sock) await initBot();
    if (sock.authState?.creds?.registered) {
      return res.json({ error: 'Already registered! Clear session in Firebase if you want to re-pair.' });
    }
    const code = await sock.requestPairingCode(number);
    return res.json({ code });
  } catch (err) {
    console.error('Pairing error:', err);
    return res.status(500).json({ error: 'Failed to request pairing code' });
  }
});

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);
  await initBot();
});
