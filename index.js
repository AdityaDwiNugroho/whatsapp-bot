import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import express from 'express';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7860;

// Setup Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File paths for local persistence
const messagesPath = path.join(__dirname, 'messages_history.json');
const repliesPath = path.join(__dirname, 'auto_replies.json');

// Memory storage
let botStatus = 'Initializing...';
let latestQrCode = null;
let messagesHistory = [];
let autoReplies = [];

// Load historical messages from disk
function loadMessages() {
  if (fs.existsSync(messagesPath)) {
    try {
      messagesHistory = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
      console.log(`[+] Loaded ${messagesHistory.length} messages from local history.`);
    } catch (err) {
      console.error('[-] Error loading message history:', err.message);
      messagesHistory = [];
    }
  }
}

// Save historical messages to disk (limit to 1000 items)
function saveMessages() {
  try {
    if (messagesHistory.length > 1000) {
      messagesHistory = messagesHistory.slice(messagesHistory.length - 1000);
    }
    fs.writeFileSync(messagesPath, JSON.stringify(messagesHistory, null, 2));
  } catch (err) {
    console.error('[-] Error saving message history:', err.message);
  }
}

// Load auto replies from disk
function loadReplies() {
  if (fs.existsSync(repliesPath)) {
    try {
      autoReplies = JSON.parse(fs.readFileSync(repliesPath, 'utf8'));
      console.log(`[+] Loaded ${autoReplies.length} auto-reply rules.`);
    } catch (err) {
      console.error('[-] Error loading auto-replies:', err.message);
      autoReplies = getDefaultReplies();
    }
  } else {
    autoReplies = getDefaultReplies();
    saveReplies();
  }
}

// Save auto replies to disk
function saveReplies() {
  try {
    fs.writeFileSync(repliesPath, JSON.stringify(autoReplies, null, 2));
  } catch (err) {
    console.error('[-] Error saving auto-replies:', err.message);
  }
}

// Default replies if none exist (no emojis)
function getDefaultReplies() {
  return [
    { trigger: 'ping', response: 'pong' },
    { trigger: 'halo', response: 'Halo! Saya adalah asisten bot WhatsApp yang sedang aktif. Silakan tinggalkan pesan Anda!' },
    { trigger: 'hi', response: 'Halo! Silakan tinggalkan pesan Anda. Saya akan segera membalasnya.' },
    { trigger: 'info', response: 'Bot WhatsApp ini sedang aktif 24/7 di cloud!' },
    { trigger: 'help', response: 'Berikut kata kunci yang didukung:\n- ping: Tes koneksi bot\n- info: Info status bot\n- help: Menampilkan menu bantuan' }
  ];
}

// Initialize persistence
loadMessages();
loadReplies();

// Basic Authorization Middleware for Cloud Deployments
const checkPassword = (req, res, next) => {
  const passwordEnv = process.env.DASHBOARD_PASSWORD;
  if (!passwordEnv) {
    return next(); // Security disabled if no env var
  }
  const clientPass = req.headers['x-password'] || req.query.password;
  if (clientPass === passwordEnv) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please check your Dashboard Password.' });
};

// Initialize WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth' // Stores session locally to keep login (cookies/keys)
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// Event: QR Code generated
client.on('qr', (qr) => {
  latestQrCode = qr;
  botStatus = 'QR Code generated. Scan to login.';
  console.log('\n[+] QR Code generated! Scan it in the terminal or on the web dashboard:');
  qrcodeTerminal.generate(qr, { small: true });
});

// Event: Authenticated successfully
client.on('authenticated', () => {
  botStatus = 'Authenticated!';
  latestQrCode = null;
  console.log('[+] Authenticated successfully!');
});

// Event: Auth Failure
client.on('auth_failure', (msg) => {
  botStatus = 'Authentication Failed!';
  console.error('[-] Auth failure:', msg);
});

// Event: Ready (connected to WhatsApp Web)
client.on('ready', () => {
  botStatus = 'Connected & Running!';
  latestQrCode = null;
  console.log('\n=========================================');
  console.log('   WHATSAPP AUTOMATION BOT IS READY!     ');
  console.log('=========================================');
});

// Helper: Formats phone numbers to WhatsApp JID format
function formatPhoneNumber(num) {
  let clean = num.replace(/[^\d]/g, '');
  if (clean.startsWith('0')) {
    clean = '62' + clean.slice(1); // Default country code Indonesian 62 if starts with 0
  }
  if (!clean.endsWith('@c.us') && !clean.endsWith('@g.us')) {
    clean = clean + '@c.us';
  }
  return clean;
}

// Event: Handling incoming and outgoing messages in real-time
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (chat.isGroup) return; // Skip group chats

    // Extract sender name
    let senderName = '';
    if (msg.fromMe) {
      senderName = 'Me';
    } else {
      const contact = await msg.getContact();
      senderName = contact.name || contact.pushname || msg.from.split('@')[0];
    }

    const timestampStr = new Date(msg.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);

    // Detect if this outgoing message is an auto-reply response
    const isAutoReply = msg.fromMe && autoReplies.some(r => r.response === msg.body);

    const messageObj = {
      id: msg.id.id,
      timestamp: timestampStr,
      fromMe: msg.fromMe,
      sender: senderName,
      message: msg.body || '',
      chatId: msg.fromMe ? msg.to : msg.from,
      chatName: chat.name || senderName,
      isAutoReply: isAutoReply
    };

    // Check for duplicate messages (Puppeteer sometimes fires double events)
    const isDuplicate = messagesHistory.some(m => m.id === messageObj.id);
    if (!isDuplicate) {
      messagesHistory.push(messageObj);
      saveMessages();
      console.log(`[MSG] ${msg.fromMe ? 'Out' : 'In'} - ${senderName}: "${msg.body}"`);
    }

    // Auto-reply logic (only for incoming messages, not from self)
    if (!msg.fromMe) {
      const text = msg.body.toLowerCase().trim();
      const matchedRule = autoReplies.find(rule => text === rule.trigger.toLowerCase().trim());
      
      if (matchedRule) {
        // Delay reply slightly to simulate human response times
        setTimeout(async () => {
          try {
            await msg.reply(matchedRule.response);
            console.log(`[AUTO-REPLY] Sent response for keyword "${matchedRule.trigger}" to ${senderName}`);
          } catch (replyErr) {
            console.error('[-] Failed sending auto reply:', replyErr.message);
          }
        }, 1500);
      }
    }
  } catch (err) {
    console.error('[-] Error handling message_create event:', err.message);
  }
});

// REST API: Get Bot Status
app.get('/api/status', (req, res) => {
  res.json({
    status: botStatus,
    authenticated: client.info ? true : false,
    phone: client.info && client.info.wid ? client.info.wid.user : null,
    pushname: client.info ? client.info.pushname : null,
    qrPending: latestQrCode ? true : false
  });
});

// REST API: Get QR Code base64 image
app.get('/api/qr', async (req, res) => {
  if (!latestQrCode) {
    return res.status(404).json({ error: 'No QR code pending. Bot is already logged in or initializing.' });
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQrCode);
    res.json({ qr: qrImage });
  } catch (err) {
    res.status(500).json({ error: 'Error generating QR code image' });
  }
});

// REST API: Get messages history (requires auth if DASHBOARD_PASSWORD set)
app.get('/api/messages', checkPassword, (req, res) => {
  res.json(messagesHistory);
});

// REST API: Send WhatsApp message (requires auth if DASHBOARD_PASSWORD set)
app.post('/api/send', checkPassword, async (req, res) => {
  const { contact, message } = req.body;
  
  if (!contact || !message) {
    return res.status(400).json({ error: 'Contact and message are required' });
  }

  try {
    const formattedId = formatPhoneNumber(contact);
    console.log(`[+] Sending message to ${formattedId}: "${message}"`);
    await client.sendMessage(formattedId, message);
    res.json({ success: true, message: 'Message sent successfully!' });
  } catch (err) {
    console.error('[-] Send message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// REST API: Get Auto Reply rules (requires auth if DASHBOARD_PASSWORD set)
app.get('/api/replies', checkPassword, (req, res) => {
  res.json(autoReplies);
});

// REST API: Add/Update Auto Reply rule (requires auth if DASHBOARD_PASSWORD set)
app.post('/api/replies', checkPassword, (req, res) => {
  const { trigger, response } = req.body;
  if (!trigger || !response) {
    return res.status(400).json({ error: 'Trigger and response are required' });
  }

  // Remove existing rule with same trigger
  autoReplies = autoReplies.filter(r => r.trigger.toLowerCase() !== trigger.toLowerCase());
  
  // Add new rule
  autoReplies.push({ trigger: trigger.trim(), response: response.trim() });
  saveReplies();
  res.json({ success: true, message: 'Auto-reply rule saved!' });
});

// REST API: Delete Auto Reply rule (requires auth if DASHBOARD_PASSWORD set)
app.delete('/api/replies', checkPassword, (req, res) => {
  const { trigger } = req.body;
  if (!trigger) {
    return res.status(400).json({ error: 'Trigger is required' });
  }

  autoReplies = autoReplies.filter(r => r.trigger.toLowerCase() !== trigger.toLowerCase());
  saveReplies();
  res.json({ success: true, message: 'Auto-reply rule deleted!' });
});

// Start Express Web Server
app.listen(PORT, () => {
  console.log(`[+] Web control panel and API running at http://localhost:${PORT}`);
  console.log(`[+] Dashboard security: ${process.env.DASHBOARD_PASSWORD ? 'ENABLED' : 'DISABLED (Set DASHBOARD_PASSWORD env variable to secure)'}`);
});

// Start WhatsApp Client
console.log('[+] Initializing WhatsApp client...');
client.initialize();
