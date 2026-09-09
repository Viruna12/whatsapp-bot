const pino = require('pino');
const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { restoreSession, saveSessionToFirebase } = require('./firebase-session');

const PREFIX = '.';
const startTime = Date.now();
const SESSION_PATH = './session';

// Global Bot Settings
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
    browser: ['Ubuntu', 'Chrome', '124.0.0.0']
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

      // Always Online Status
      if (settings.alwaysOnline) {
        await sock.sendPresenceUpdate('available');
      }

      // Auto Bot Connected Notification to Owner/Self chat
      try {
        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        await sock.sendMessage(myJid, {
          text: `🤖 *BOT CONNECTED SUCCESSFULLY!*\n\n` +
            `⚡ *Prefix:* \`${PREFIX}\`\n` +
            `🟢 *Status:* Online (24/7 Active)\n` +
            `🛡️ *Anti-Delete:* ${settings.antiDelete ? 'ON' : 'OFF'}\n` +
            `👁️ *Auto Status Seen:* ${settings.autoStatusSeen ? 'ON' : 'OFF'}\n\n` +
            `_Type *${PREFIX}menu* to explore all commands!_`
        });
      } catch (err) {
        console.error('Failed to send connect notification:', err.message);
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

    // 2. Anti-Delete Message Recovery
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

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    // 🚀 SELF & INBOX FIX:
    // Allows commands in "Message Yourself" while avoiding bot infinite loops!
    if (msg.key.fromMe && !body.startsWith(PREFIX)) return;

    // Auto Typing or Recording Presence
    if (settings.autoTyping) await sock.sendPresenceUpdate('composing', from);
    else if (settings.autoRecording) await sock.sendPresenceUpdate('recording', from);

    if (!body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const query = args.join(' ');

    // ----------------------------------------
    // COMMANDS ENGINE
    // ----------------------------------------
    switch (cmd) {
      // 1. Menu
      case 'menu':
      case 'help': {
        const menuText =
          `╭━━━〔 *MINI BOT MENU* 〕━━━╮\n` +
          `┃ 👤 *Owner:* Viruna Randinu\n` +
          `┃ ⚡ *Prefix:* ${PREFIX}\n` +
          `┃ ⏱️ *Runtime:* ${Math.floor((Date.now() - startTime) / 60000)}m\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
          `╭━━〔 📥 *DOWNLOADERS* 〕━━╮\n` +
          `┃ 🔹 *${PREFIX}song <title>* - Download Song\n` +
          `┃ 🔹 *${PREFIX}video <title>* - Download Video\n` +
          `┃ 🔹 *${PREFIX}vv* - Recover View Once\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
          `╭━━〔 🤖 *AI & SEARCH* 〕━━╮\n` +
          `┃ 🔹 *${PREFIX}ai <question>* - Ask Gemini/GPT\n` +
          `┃ 🔹 *${PREFIX}news* - Latest Headlines\n` +
          `┃ 🔹 *${PREFIX}calc <math>* - Calculator\n` +
          `┃ 🔹 *${PREFIX}tts <text>* - Voice message\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
          `╭━━〔 ⚙️ *BOT SETTINGS* 〕━━╮\n` +
          `┃ 🔹 *${PREFIX}settings* - Panel\n` +
          `┃ 🔹 *${PREFIX}ping* - Speed test\n` +
          `┃ 🔹 *${PREFIX}alive* - Status\n` +
          `┃ 🔹 *${PREFIX}system* - RAM & Stats\n` +
          `┃ 🔹 *${PREFIX}owner* - Creator Card\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
          `╭━━〔 🎭 *FUN & MISC* 〕━━╮\n` +
          `┃ 🔹 *${PREFIX}joke* - Random joke\n` +
          `┃ 🔹 *${PREFIX}quote* - Motivation\n` +
          `┃ 🔹 *${PREFIX}say <text>* - Echo text\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`;
        await sock.sendMessage(from, { text: menuText }, { quoted: msg });
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
        await sock.sendMessage(from, {
          text: `🟢 *Bot is Fully Active and Running at Max Speed!*\n\n• Always Online: ${settings.alwaysOnline ? '✅' : '❌'}\n• Status Seen: ${settings.autoStatusSeen ? '✅' : '❌'}`
        }, { quoted: msg });
        break;
      }

      // 4. AI Chatbot
      case 'ai':
      case 'gpt': {
        if (!query) return sock.sendMessage(from, { text: `Please provide a question: *${PREFIX}ai what is quantum computing?*` }, { quoted: msg });
        await sock.sendMessage(from, { react: { text: '🧠', key: msg.key } });
        try {
          const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(query)}?model=openai`);
          await sock.sendMessage(from, { text: `🤖 *AI:* ${res.data}` }, { quoted: msg });
        } catch (e) {
          await sock.sendMessage(from, { text: '❌ AI server is busy, try again.' }, { quoted: msg });
        }
        break;
      }

      // 5. Song Downloader (.song)
      case 'song':
      case 'play': {
        if (!query) return sock.sendMessage(from, { text: `Enter song title: *${PREFIX}song shape of you*` }, { quoted: msg });
        await sock.sendMessage(from, { react: { text: '🎵', key: msg.key } });
        try {
          const apiRes = await axios.get(`https://api.vreden.my.id/api/ytplaymp3?query=${encodeURIComponent(query)}`);
          const data = apiRes.data?.result;
          if (data && data.download?.url) {
            await sock.sendMessage(from, {
              audio: { url: data.download.url },
              mimetype: 'audio/mp4',
              fileName: `${data.title}.mp3`
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, { text: '❌ Song download link not found.' }, { quoted: msg });
          }
        } catch (e) {
          await sock.sendMessage(from, { text: '❌ Failed to fetch song. API may be rate limited.' }, { quoted: msg });
        }
        break;
      }

      // 6. Video Downloader (.video)
      case 'video':
      case 'ytv': {
        if (!query) return sock.sendMessage(from, { text: `Enter video title: *${PREFIX}video funny cats*` }, { quoted: msg });
        await sock.sendMessage(from, { react: { text: '🎬', key: msg.key } });
        try {
          const apiRes = await axios.get(`https://api.vreden.my.id/api/ytplaymp4?query=${encodeURIComponent(query)}`);
          const data = apiRes.data?.result;
          if (data && data.download?.url) {
            await sock.sendMessage(from, {
              video: { url: data.download.url },
              caption: `🎥 *${data.title}*`
            }, { quoted: msg });
          } else {
            await sock.sendMessage(from, { text: '❌ Video download link not found.' }, { quoted: msg });
          }
        } catch (e) {
          await sock.sendMessage(from, { text: '❌ Failed to fetch video.' }, { quoted: msg });
        }
        break;
      }

      // 7. News (.news)
      case 'news': {
        await sock.sendMessage(from, { react: { text: '📰', key: msg.key } });
        try {
          const newsRes = await axios.get('https://inshortsapi.vercel.app/news?category=technology');
          const articles = newsRes.data?.data?.slice(0, 4) || [];
          let text = `📰 *LATEST TECH HEADLINES*\n\n`;
          articles.forEach((a, i) => {
            text += `*${i + 1}. ${a.title}*\n${a.content}\n\n`;
          });
          await sock.sendMessage(from, { text }, { quoted: msg });
        } catch {
          await sock.sendMessage(from, { text: '❌ Could not retrieve news headlines right now.' }, { quoted: msg });
        }
        break;
      }

      // 8. Text to Speech (.tts)
      case 'tts': {
        if (!query) return sock.sendMessage(from, { text: `Provide text: *${PREFIX}tts Hello my friend*` }, { quoted: msg });
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(query)}&tl=si&client=tw-ob`;
        await sock.sendMessage(from, { audio: { url: ttsUrl }, mimetype: 'audio/mp4', ptt: true }, { quoted: msg });
        break;
      }

      // 9. Owner Info (.owner)
      case 'owner': {
        const vcard =
          'BEGIN:VCARD\n' +
          'VERSION:3.0\n' +
          'FN:Viruna Randinu\n' +
          'ORG:Bot Developer\n' +
          'TEL;type=CELL;type=VOICE;waid=94773796358:+94 77 379 6358\n' +
          'END:VCARD';
        await sock.sendMessage(from, {
          contacts: { displayName: 'Viruna Randinu', contacts: [{ vcard }] }
        }, { quoted: msg });
        break;
      }

      // 10. View Once Recovery (.vv)
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

      // 11. Settings Panel (.settings)
      case 'settings':
      case 'setting': {
        const opt = args[0]?.toLowerCase();
        if (opt === 'online') {
          settings.alwaysOnline = !settings.alwaysOnline;
          await sock.sendPresenceUpdate(settings.alwaysOnline ? 'available' : 'unavailable');
          await sock.sendMessage(from, { text: `Always Online: *${settings.alwaysOnline ? 'ON' : 'OFF'}*` });
        } else if (opt === 'status') {
          settings.autoStatusSeen = !settings.autoStatusSeen;
          await sock.sendMessage(from, { text: `Auto Status Seen: *${settings.autoStatusSeen ? 'ON' : 'OFF'}*` });
        } else if (opt === 'antidelete') {
          settings.antiDelete = !settings.antiDelete;
          await sock.sendMessage(from, { text: `Anti-Delete: *${settings.antiDelete ? 'ON' : 'OFF'}*` });
        } else if (opt === 'typing') {
          settings.autoTyping = !settings.autoTyping;
          settings.autoRecording = false;
          await sock.sendMessage(from, { text: `Auto Typing: *${settings.autoTyping ? 'ON' : 'OFF'}*` });
        } else if (opt === 'recording') {
          settings.autoRecording = !settings.autoRecording;
          settings.autoTyping = false;
          await sock.sendMessage(from, { text: `Auto Recording: *${settings.autoRecording ? 'ON' : 'OFF'}*` });
        } else {
          const panel =
            `⚙️ *BOT SETTINGS PANEL*\n\n` +
            `• *Always Online:* ${settings.alwaysOnline ? '✅ ON' : '❌ OFF'} (\`${PREFIX}settings online\`)\n` +
            `• *Status Seen:* ${settings.autoStatusSeen ? '✅ ON' : '❌ OFF'} (\`${PREFIX}settings status\`)\n` +
            `• *Anti Delete:* ${settings.antiDelete ? '✅ ON' : '❌ OFF'} (\`${PREFIX}settings antidelete\`)\n` +
            `• *Auto Typing:* ${settings.autoTyping ? '✅ ON' : '❌ OFF'} (\`${PREFIX}settings typing\`)\n` +
            `• *Auto Recording:* ${settings.autoRecording ? '✅ ON' : '❌ OFF'} (\`${PREFIX}settings recording\`)`;
          await sock.sendMessage(from, { text: panel }, { quoted: msg });
        }
        break;
      }

      // 12. System & Runtime
      case 'system': {
        const free = (os.freemem() / (1024 * 1024)).toFixed(0);
        const total = (os.totalmem() / (1024 * 1024)).toFixed(0);
        await sock.sendMessage(from, {
          text: `💻 *SYSTEM INFO*\n• Platform: ${os.platform()}\n• Free Memory: ${free}MB / ${total}MB`
        }, { quoted: msg });
        break;
      }

      // 13. Calculator
      case 'calc': {
        try {
          const res = Function(`'use strict'; return (${query})`)();
          await sock.sendMessage(from, { text: `🧮 *Result:* ${res}` }, { quoted: msg });
        } catch {
          await sock.sendMessage(from, { text: '❌ Invalid Math expression.' }, { quoted: msg });
        }
        break;
      }

      // 14. Say
      case 'say': {
        if (query) await sock.sendMessage(from, { text: query });
        break;
      }

      // 15. Joke
      case 'joke': {
        const jokes = [
          'Why do programmers prefer dark mode? Because light attracts bugs!',
          'There are 10 types of people: those who understand binary, and those who do not.',
          'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"',
          'Software developers: Turning coffee into code since 1995.'
        ];
        await sock.sendMessage(from, { text: `😄 ${jokes[Math.floor(Math.random() * jokes.length)]}` }, { quoted: msg });
        break;
      }

      // 16. Quote
      case 'quote': {
        const quotes = [
          '“The secret of getting ahead is getting started.” — Mark Twain',
          '“It always seems impossible until it’s done.” — Nelson Mandela',
          '“Don’t let yesterday take up too much of today.” — Will Rogers'
        ];
        await sock.sendMessage(from, { text: `💬 ${quotes[Math.floor(Math.random() * quotes.length)]}` }, { quoted: msg });
        break;
      }
    }
  });
}

startBot();
