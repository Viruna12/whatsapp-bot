const pino = require('pino');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { restoreSession, saveSessionToFirebase } = require('./firebase-session');

const PREFIX = '.';
const startTime = Date.now();
const SESSION_PATH = './session';

let settings = {
  alwaysOnline: true,
  autoStatusSeen: true,
  autoTyping: false,
  autoRecording: true,
  antiDelete: true
};

const messageCache = new Map();
let sock = null;

async function startBot() {
  console.log('⏳ Restoring session from Firebase...');
  await restoreSession(SESSION_PATH);

  // Dynamic Baileys Import (ERR_REQUIRE_ESM Fix)
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
        console.log('🔄 Reconnecting Bot...');
        setTimeout(startBot, 3000);
      }
    } else if (connection === 'open') {
      console.log('🚀 WhatsApp Bot is Online and Active!');
      if (settings.alwaysOnline) {
        await sock.sendPresenceUpdate('available');
      }
    }
  });

  // Message Events (Features + Anti-delete + 10 Commands)
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
            text: `⚠️ *Deleted Message Detected!*\n\n👤 *Sender:* @${sender.split('@')[0]}\n💬 *Text:* ${text}`,
            mentions: [sender]
          });
        }
      }
      return;
    }

    if (msg.key.fromMe) return;

    // 3. Auto Typing / Recording Presence
    if (settings.autoTyping) await sock.sendPresenceUpdate('composing', from);
    else if (settings.autoRecording) await sock.sendPresenceUpdate('recording', from);

    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // 10 Core Commands
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
        await sock.sendMessage(from, { text: '🟢 *Bot is Active and Connected!*' }, { quoted: msg });
        break;
      }
      case 'runtime': {
        const sec = Math.floor((Date.now() - startTime) / 1000);
        await sock.sendMessage(from, { text: `⏱️ Uptime: ${Math.floor(sec / 60)} minutes` }, { quoted: msg });
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
        if (type === 'imageMessage') await sock.sendMessage(from, { image: buf, caption: '🔓 *View Once Recovered*' }, { quoted: msg });
        else if (type === 'videoMessage') await sock.sendMessage(from, { video: buf, caption: '🔓 *View Once Recovered*' }, { quoted: msg });
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
}

// GitHub Actions මඟින් `npm start` කළ විට bot run වේ
startBot();
