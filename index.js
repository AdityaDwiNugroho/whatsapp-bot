import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, RemoteAuth, MessageMedia } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import express from 'express';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';
import AdmZip from 'adm-zip';
import os from 'os';

// Custom RemoteAuth class to bypass unzipper extraction failures and prune cache safely before zipping
class CustomRemoteAuth extends RemoteAuth {
  async copyByRequiredDirs(from, to) {
    // Copy the required session files to the temp directory first
    await super.copyByRequiredDirs(from, to);

    // Prune cache files from the temporary copy (to) to ensure the backup fits within MongoDB's 16MB limit
    try {
      const targets = [
        path.join(to, 'Cache'),
        path.join(to, 'Code Cache'),
        path.join(to, 'GPUCache'),
        path.join(to, 'Service Worker', 'CacheStorage'),
        path.join(to, 'Service Worker', 'ScriptCache'),
        path.join(to, 'Service Worker', 'ServiceWorkerCache'),
        path.join(to, 'CacheStorage'),
        path.join(to, 'Blob_storage')
      ];

      for (const target of targets) {
        try {
          if (fs.existsSync(target)) {
            await fs.promises.rm(target, { recursive: true, force: true });
          }
        } catch (err) {
          // Silent catch for files currently held
        }
      }
      console.log('[+] Successfully pruned Chromium cache in temp session folder.');
    } catch (err) {
      console.error('[-] Error pruning temp session folder cache:', err.message);
    }
  }

  async unCompressSession(compressedSessionPath) {
    await new Promise((resolve, reject) => {
      try {
        const zip = new AdmZip(compressedSessionPath);
        zip.extractAllToAsync(this.userDataDir, true, false, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
    try {
      await fs.promises.unlink(compressedSessionPath);
    } catch (err) {
      console.error('[-] Error removing temporary session zip file:', err.message);
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Decorate console.log and console.error to prepend timestamps in the terminal
const originalLog = console.log;
console.log = (...args) => {
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  originalLog(`[${time}]`, ...args);
};

const originalError = console.error;
console.error = (...args) => {
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  originalError(`[${time}]`, ...args);
};

// Load local .env file if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[key] = value;
      }
    }
    console.log('[+] Loaded environment variables from .env file.');
  }
} catch (envErr) {
  console.error('[-] Failed to read .env file:', envErr.message);
}

// Save PID for local stopping script
try {
  fs.writeFileSync(path.join(__dirname, 'bot.pid'), process.pid.toString());
} catch (pidErr) {
  console.error('[-] Failed to write PID file:', pidErr.message);
}

// Graceful shutdown helpers
const cleanupAndExit = async () => {
  console.log('[+] Shutting down gracefully...');
  if (typeof client !== 'undefined' && client) {
    try {
      await client.destroy();
    } catch (err) {}
  }
  try {
    const pidFile = path.join(__dirname, 'bot.pid');
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch (err) {}
  process.exit(0);
};

process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

const app = express();
const PORT = process.env.PORT || 7860;

// Setup Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File paths for local persistence
const messagesPath = path.join(__dirname, 'messages_history.json');
const repliesPath = path.join(__dirname, 'auto_replies.json');
const settingsPath = path.join(__dirname, 'bot_settings.json');
const contactsPath = path.join(__dirname, 'saved_contacts.json');
const statusesPath = path.join(__dirname, 'statuses_history.json');
const statusMediaDir = path.join(__dirname, 'public', 'status_media');

// Ensure public/status_media directory exists
if (!fs.existsSync(statusMediaDir)) {
  fs.mkdirSync(statusMediaDir, { recursive: true });
}

// Memory storage
let botStatus = 'Initializing...';
let latestQrCode = null;
let messagesHistory = [];
let statusesHistory = [];
let autoReplies = [];
let botSettings = {
  aiEnabled: false,
  systemPrompt: "You are the account owner chatting casually on WhatsApp. You must NEVER act like an AI, bot, or virtual assistant. NEVER say phrases like 'How can I help you?' or 'I am an assistant'. Chat naturally like a human friend: use typing abbreviations ('gw' instead of 'gue', 'yg', 'gk', 'kalo'), use natural reactions/emotions ('wkwk', 'lah', 'deh', 'sih', 'dih'), match the sender's language and energy, and keep responses short and direct. Do not use emojis.",
  ignoredContacts: ["Joy", "Momskuy"]
};

// Tracking AI-generated response texts for dashboard flags
const recentAiReplies = new Set();

// Command Queue for PC remote control
let pendingCommands = [];
let pcLastSeen = null;
// Cooldown tracker for general away message (per phone number)
const awayCooldowns = new Map();
const COOLDOWN_TIME = 24 * 60 * 60 * 1000; // 24 Hours in milliseconds

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

// Load status updates history from disk
function loadStatuses() {
  if (fs.existsSync(statusesPath)) {
    try {
      statusesHistory = JSON.parse(fs.readFileSync(statusesPath, 'utf8'));
      console.log(`[+] Loaded ${statusesHistory.length} status updates from local history.`);
    } catch (err) {
      console.error('[-] Error loading status history:', err.message);
      statusesHistory = [];
    }
  }
}

// Save status updates history to disk
function saveStatuses() {
  try {
    fs.writeFileSync(statusesPath, JSON.stringify(statusesHistory, null, 2));
  } catch (err) {
    console.error('[-] Error saving status history:', err.message);
  }
}

// Prune statuses older than 24 hours
async function pruneExpiredStatuses() {
  const now = Math.floor(Date.now() / 1000);
  const twentyFourHours = 24 * 60 * 60;
  const activeStatuses = [];
  const expiredStatuses = [];

  for (const status of statusesHistory) {
    if (now - status.timestamp < twentyFourHours) {
      activeStatuses.push(status);
    } else {
      expiredStatuses.push(status);
    }
  }

  if (expiredStatuses.length > 0) {
    console.log(`[+] Pruning ${expiredStatuses.length} expired status updates.`);
    for (const status of expiredStatuses) {
      if (status.mediaPath) {
        const fullPath = path.join(__dirname, 'public', status.mediaPath);
        try {
          if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
            console.log(`[+] Deleted expired status media file: ${status.mediaPath}`);
          }
        } catch (err) {
          console.error(`[-] Error deleting expired status media ${status.mediaPath}:`, err.message);
        }
      }
    }
    statusesHistory = activeStatuses;
    saveStatuses();
  }
}

// Clean up orphan media files on server startup
async function cleanupOrphanStatusMedia() {
  try {
    if (!fs.existsSync(statusMediaDir)) {
      fs.mkdirSync(statusMediaDir, { recursive: true });
      return;
    }
    const files = await fs.promises.readdir(statusMediaDir);
    const activeMediaPaths = new Set(statusesHistory.map(s => s.mediaPath ? path.basename(s.mediaPath) : null).filter(Boolean));
    for (const file of files) {
      if (!activeMediaPaths.has(file)) {
        const fullPath = path.join(statusMediaDir, file);
        try {
          await fs.promises.unlink(fullPath);
          console.log(`[+] Deleted orphan status media file: ${file}`);
        } catch (err) {
          // Ignore deletion error
        }
      }
    }
  } catch (err) {
    console.error('[-] Error cleaning up orphan status media:', err.message);
  }
}

// Handle status updates broadcast to status@broadcast JID
async function handleStatusUpdate(msg) {
  try {
    let authorJid = msg.author;
    if (!authorJid) {
      if (msg.fromMe) {
        authorJid = client.info && client.info.wid ? client.info.wid._serialized : 'me@c.us';
      } else {
        authorJid = msg.from;
      }
    }

    const authorNumber = authorJid.split('@')[0];
    
    // Check if the author is ignored
    const isIgnored = botSettings.ignoredContacts && botSettings.ignoredContacts.some(ignored => {
      const cleanIgnored = ignored.toLowerCase().trim();
      return authorNumber.includes(cleanIgnored);
    });
    if (isIgnored) return;

    // Avoid duplicate status entries
    const isDuplicate = statusesHistory.some(s => s.id === msg.id.id);
    if (isDuplicate) return;

    // Resolve author display name
    let authorName = authorNumber;
    const saved = savedContacts.find(c => c.phone === authorNumber);
    if (saved) {
      authorName = saved.name;
    } else {
      try {
        const contact = await msg.getContact();
        authorName = contact.name || contact.pushname || authorNumber;
      } catch (err) {
        // Fallback to number
      }
    }

    let mediaPath = null;
    let mediaType = null;
    
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          let ext = 'bin';
          const mime = media.mimetype.toLowerCase();
          if (mime.includes('image/jpeg') || mime.includes('image/jpg')) ext = 'jpg';
          else if (mime.includes('image/png')) ext = 'png';
          else if (mime.includes('image/gif')) ext = 'gif';
          else if (mime.includes('video/mp4')) ext = 'mp4';
          else if (mime.includes('audio/ogg') || mime.includes('audio/mpeg')) ext = 'ogg';

          const filename = `${msg.id.id}.${ext}`;
          const destPath = path.join(statusMediaDir, filename);

          await fs.promises.writeFile(destPath, Buffer.from(media.data, 'base64'));
          mediaPath = `status_media/${filename}`;
          
          if (mime.includes('image')) mediaType = 'image';
          else if (mime.includes('video')) mediaType = 'video';
          else if (mime.includes('audio')) mediaType = 'audio';
          console.log(`[+] Saved status media to: ${mediaPath}`);
        }
      } catch (mediaErr) {
        console.error('[-] Error downloading status media:', mediaErr.message);
      }
    }

    const timestampStr = formatLocalTimestamp(msg.timestamp);

    const statusObj = {
      id: msg.id.id,
      timestamp: msg.timestamp,
      timestampStr: timestampStr,
      author: authorJid,
      authorName: authorName,
      message: msg.body || '',
      mediaPath: mediaPath,
      mediaType: mediaType
    };

    statusesHistory.push(statusObj);
    statusesHistory.sort((a, b) => a.timestamp - b.timestamp);
    if (statusesHistory.length > 200) {
      const removed = statusesHistory.splice(0, statusesHistory.length - 200);
      for (const r of removed) {
        if (r.mediaPath) {
          const fullPath = path.join(__dirname, 'public', r.mediaPath);
          try {
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
          } catch (e) {}
        }
      }
    }
    saveStatuses();
    console.log(`[STATUS] Captured status update from ${authorName}: "${msg.body || '[Media]'}"`);
  } catch (err) {
    console.error('[-] Error handling status update:', err.message);
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

// Load/Save Bot Settings
function loadSettings() {
  if (fs.existsSync(settingsPath)) {
    try {
      botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
      console.log('[+] Loaded bot configuration settings.');
    } catch (err) {
      console.error('[-] Error loading settings:', err.message);
    }
  } else {
    saveSettings();
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(botSettings, null, 2));
  } catch (err) {
    console.error('[-] Error saving settings:', err.message);
  }
}

// Memory-backed Contacts Database
let savedContacts = [];

function loadContacts() {
  if (fs.existsSync(contactsPath)) {
    try {
      savedContacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
      console.log(`[+] Loaded ${savedContacts.length} saved contacts.`);
    } catch (err) {
      console.error('[-] Error loading saved contacts:', err.message);
      savedContacts = [];
    }
  }
}

function saveContacts() {
  try {
    fs.writeFileSync(contactsPath, JSON.stringify(savedContacts, null, 2));
  } catch (err) {
    console.error('[-] Error saving saved contacts:', err.message);
  }
}

async function saveContactDb(name, phone) {
  const cleanPhone = phone.replace(/[^\d]/g, '');
  const existingIndex = savedContacts.findIndex(c => c.phone === cleanPhone);
  if (existingIndex > -1) {
    savedContacts[existingIndex].name = name;
  } else {
    savedContacts.push({ name, phone: cleanPhone });
  }
  saveContacts();
  
  if (mongoose.connection.readyState === 1) {
    try {
      const col = mongoose.connection.db.collection('custom_contacts');
      await col.updateOne(
        { phone: cleanPhone },
        { $set: { name: name, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`[+] Saved contact ${name} (${cleanPhone}) to MongoDB.`);
    } catch (err) {
      console.error('[-] Failed saving contact to MongoDB:', err.message);
    }
  }
}

async function loadContactsFromDb() {
  if (mongoose.connection.readyState === 1) {
    try {
      const col = mongoose.connection.db.collection('custom_contacts');
      const dbContacts = await col.find({}).toArray();
      if (dbContacts.length > 0) {
        savedContacts = dbContacts.map(c => ({ name: c.name, phone: c.phone }));
        saveContacts();
        console.log(`[+] Loaded ${savedContacts.length} custom contacts from MongoDB.`);
      }
    } catch (err) {
      console.error('[-] Failed loading custom contacts from MongoDB:', err.message);
    }
  }
}

// Initialize persistence
loadMessages();
loadReplies();
loadSettings();
loadContacts();
loadStatuses();

// Basic Authorization Middleware for Cloud Deployments & PC Connector
const checkPassword = (req, res, next) => {
  const passwordEnv = process.env.DASHBOARD_PASSWORD;
  if (!passwordEnv) {
    return next(); // Security disabled if no env var
  }
  const clientPass = req.headers['x-password'] || req.query.password;
  if (clientPass === passwordEnv) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please check your Password.' });
};

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

// Helper: Formats timestamp to machine's local timezone format (YYYY-MM-DD HH:MM:SS)
function formatLocalTimestamp(timestampEpoch) {
  const d = new Date(timestampEpoch * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Helper: Auto-locates Google Chrome on Windows or falls back to env variable
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === 'win32') {
    const standardPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of standardPaths) {
      if (fs.existsSync(p)) {
        console.log(`[+] Auto-detected Google Chrome at: ${p}`);
        return p;
      }
    }
  }
  return null;
}

// Puppeteer configuration (custom User Agent to bypass bot detection and optimize memory)
function getPuppeteerConfig() {
  return {
    headless: true,
    executablePath: getChromeExecutablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--disable-features=site-per-process',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--mute-audio',
      '--no-default-browser-check',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ]
  };
}

// Stable Web Version Cache Configuration to avoid scanning loops
function getWebVersionCacheConfig() {
  return {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  };
}

// Call Gemini API to generate dynamic response
// Call Gemini API to generate dynamic response with chat history context
async function generateGeminiResponse(chatId, senderName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Filter messages history for this specific conversation thread
  const rawHistory = messagesHistory.filter(m => m.chatId === chatId);
  
  // Format history to Gemini format (user = contact, model = bot)
  const contents = [];
  rawHistory.slice(-10).forEach(m => {
    const role = m.fromMe ? 'model' : 'user';
    let text = m.message;
    
    // Strip the [AI] tag from previous assistant responses to give clean text context
    if (m.fromMe && text.startsWith('[AI] ')) {
      text = text.slice(5);
    }
    
    contents.push({
      role: role,
      parts: [{ text: text }]
    });
  });

  // Consolidate consecutive turns with the same role to strictly alternate user/model turns
  const alternatingContents = [];
  contents.forEach(item => {
    if (alternatingContents.length > 0 && alternatingContents[alternatingContents.length - 1].role === item.role) {
      alternatingContents[alternatingContents.length - 1].parts[0].text += '\n' + item.parts[0].text;
    } else {
      alternatingContents.push(item);
    }
  });

  // If the conversation history is empty (should not happen since incoming message is already recorded),
  // fallback to a single-turn payload.
  if (alternatingContents.length === 0) {
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;
  
  // Inject context helper in system instruction
  const systemInstructionText = `${botSettings.systemPrompt}

You also have the capability to save new contacts or update contact names in the database. 
If a contact asks you to save their number, change/update their name, or remember them by a name:
You MUST append the following tag to the very end of your message response:
[SAVE_CONTACT: name="Desired Name", phone="whatsapp_number_or_JID_digits"]

Replace 'Desired Name' with the name they requested.
Replace 'whatsapp_number_or_JID_digits' with their phone number digits (e.g. "628123456789"). You can use the active contact's phone number JID digits provided below if they say "save my number".
Do not output this tag unless name saving/updating was explicitly requested.

Additional Context:
- Current Date/Time: ${new Date().toLocaleString('id-ID')}
- Active Chat Contact Name: ${senderName}
- Active Chat Contact Phone/JID: ${chatId.split('@')[0]}`;

  const payload = {
    contents: alternatingContents,
    systemInstruction: {
      parts: [
        {
          text: systemInstructionText
        }
      ]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[-] Gemini API error:', errText);
      return null;
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text.trim();
    }
  } catch (err) {
    console.error('[-] Error calling Gemini API:', err.message);
  }
  return null;
}

// Centralized WhatsApp Client Events Binder
function initializeClient() {
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
  client.on('ready', async () => {
    botStatus = 'Connected & Running!';
    latestQrCode = null;
    console.log('\n=========================================');
    console.log('   WHATSAPP AUTOMATION BOT IS READY!     ');
    console.log('=========================================');

    // Load active chats on startup to pre-populate the dashboard sidebar
    try {
      console.log('[+] Fetching active chats from WhatsApp to pre-populate sidebar...');
      const chats = await client.getChats();
      let populatedCount = 0;
      for (const chat of chats) {
        if (chat.isGroup || chat.id._serialized === 'status@broadcast') continue; // skip group chats and status broadcasts
        
        const chatId = chat.id._serialized;
        const hasMessages = messagesHistory.some(m => m.chatId === chatId);
        if (!hasMessages) {
          const msgs = await chat.fetchMessages({ limit: 1 });
          if (msgs.length > 0) {
            const lastMsg = msgs[0];
            const senderNumber = lastMsg.from.split('@')[0];
            const ownerNumber = client.info && client.info.wid ? client.info.wid.user : '';
            const isOwner = lastMsg.fromMe || (senderNumber === ownerNumber);
            
            let senderName = chat.name || senderNumber;
            const saved = savedContacts.find(c => c.phone === senderNumber);
            if (saved) {
              senderName = saved.name;
            } else {
              const contact = await lastMsg.getContact();
              senderName = contact.name || contact.pushname || senderName;
            }
            
            const timestampStr = formatLocalTimestamp(lastMsg.timestamp);
            let bodyText = lastMsg.body || '';
            if (lastMsg.hasMedia) {
              bodyText = '[Attachment File]';
            }
            
            // Detect if it was an auto-reply
            const isAutoReply = lastMsg.fromMe && (
              autoReplies.some(r => r.response === lastMsg.body) ||
              (botSettings.aiEnabled && lastMsg.body.includes('[AI]'))
            );

            messagesHistory.push({
              id: lastMsg.id.id,
              timestamp: timestampStr,
              fromMe: lastMsg.fromMe,
              sender: isOwner ? 'Me' : senderName,
              message: bodyText,
              chatId: chatId,
              chatName: chat.name || senderName,
              isAutoReply: isAutoReply
            });
            populatedCount++;
          }
        }
      }
      if (populatedCount > 0) {
        // Sort history by timestamp to keep chronological logs
        messagesHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        saveMessages();
        console.log(`[+] Pre-populated dashboard with ${populatedCount} active chats.`);
      }
    } catch (chatErr) {
      console.error('[-] Error fetching initial chats on startup:', chatErr.message);
    }

    // Trigger an immediate remote session backup in 30 seconds to ensure the session is saved to MongoDB
    if (client.authStrategy instanceof RemoteAuth) {
      console.log('[+] Triggering immediate session backup to MongoDB in 30 seconds...');
      setTimeout(async () => {
        try {
          await client.authStrategy.storeRemoteSession({ emit: true });
          console.log('[+] Session successfully saved to MongoDB database (immediate trigger).');
        } catch (err) {
          console.error('[-] Error during immediate session backup:', err.message);
        }
      }, 30000);
    }
  });

  // Event: Remote Session Saved (MongoDB Specific)
  client.on('remote_session_saved', () => {
    console.log('[+] Session successfully saved to MongoDB database.');
    botStatus = 'Connected & Session Backed Up!';
  });

  // Event: Handling incoming and outgoing messages in real-time
  client.on('message_create', async (msg) => {
    try {
      // Handle WhatsApp Status/Broadcast updates
      if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') {
        await handleStatusUpdate(msg);
        return;
      }

      const chat = await msg.getChat();
      if (chat.isGroup || chat.id._serialized === 'status@broadcast') return; // Skip group chats and status broadcasts

      // Extract sender details
      let senderName = '';
      const ownerNumber = client.info && client.info.wid ? client.info.wid.user : '';
      const senderNumber = msg.from.split('@')[0];
      
      // Strict Owner Verification check
      const isOwner = msg.fromMe || (senderNumber === ownerNumber);

      if (msg.fromMe) {
        senderName = 'Me';
      } else {
        const saved = savedContacts.find(c => c.phone === senderNumber);
        if (saved) {
          senderName = saved.name;
        } else {
          const contact = await msg.getContact();
          senderName = contact.name || contact.pushname || senderNumber;
        }
      }

      // Check if contact is blacklisted or chat is archived
      const isIgnored = chat.archived || (botSettings.ignoredContacts && botSettings.ignoredContacts.some(ignored => {
        const cleanIgnored = ignored.toLowerCase().trim();
        return senderName.toLowerCase().includes(cleanIgnored) || 
               senderNumber.includes(cleanIgnored);
      }));

      const timestampStr = formatLocalTimestamp(msg.timestamp);

      // Detect if this outgoing message is an auto-reply response
      const isAutoReply = msg.fromMe && (
        autoReplies.some(r => r.response === msg.body) ||
        recentAiReplies.has(msg.body)
      );

      // Filter media body text
      let bodyText = msg.body || '';
      if (msg.hasMedia) {
        bodyText = '[Attachment File]';
      }

      const messageObj = {
        id: msg.id.id,
        timestamp: timestampStr,
        fromMe: msg.fromMe,
        sender: senderName,
        message: bodyText,
        chatId: msg.fromMe ? msg.to : msg.from,
        chatName: chat.name || senderName,
        isAutoReply: isAutoReply
      };

      // Check for duplicate messages (Puppeteer sometimes fires double events)
      const isDuplicate = messagesHistory.some(m => m.id === messageObj.id);
      if (!isDuplicate) {
        messagesHistory.push(messageObj);
        saveMessages();
        console.log(`[MSG] ${msg.fromMe ? 'Out' : 'In'} - ${senderName}: "${bodyText}"`);
      }

      // --- Strict Administrative PC Commands ---
      // Only process /pc command if it strictly originates from the owner's WhatsApp number
      if (isOwner && bodyText.startsWith('/pc ')) {
        const commandText = bodyText.slice(4).trim();
        const commandId = Math.random().toString(36).substring(2, 9);
        
        pendingCommands.push({
          id: commandId,
          command: commandText,
          chatId: msg.fromMe ? msg.to : msg.from // Send response back to the active thread
        });
        
        await msg.reply(`Command received. Forwarding to PC (ID: ${commandId})...`);
        return; // Stop processing further auto-replies
      }

      // Auto-reply logic (only for incoming messages, not from self, and not media)
      if (!msg.fromMe && !msg.hasMedia) {
        // Skip ignored or archived contacts from auto-responses
        if (isIgnored) {
          return;
        }

        const text = bodyText.toLowerCase().trim();
        
        // 1. Match static keywords using Word Boundaries to avoid substring matches
        const matchedRule = autoReplies.find(rule => {
          const trigger = rule.trigger.toLowerCase().trim();
          const escapedTrigger = trigger.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); // escape regex specials
          const boundaryRegex = new RegExp(`\\b${escapedTrigger}\\b`, 'i');
          return boundaryRegex.test(text);
        });
        
        if (matchedRule) {
          // Replace placeholders dynamically
          let responseText = matchedRule.response;
          responseText = responseText.replace(/{sender}/g, senderName);
          responseText = responseText.replace(/{time}/g, new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
          responseText = responseText.replace(/{date}/g, new Date().toLocaleDateString('id-ID'));

          // Delay reply slightly to simulate human response times
          setTimeout(async () => {
            try {
              await msg.reply(responseText);
              console.log(`[AUTO-REPLY] Sent response for keyword "${matchedRule.trigger}" to ${senderName}`);
            } catch (replyErr) {
              console.error('[-] Failed sending auto reply:', replyErr.message);
            }
          }, 1500);
          return;
        }

        // 2. If no static keyword matched, fallback to Gemini AI Assistant if enabled
        if (botSettings.aiEnabled && process.env.GEMINI_API_KEY) {
          setTimeout(async () => {
            try {
              const aiText = await generateGeminiResponse(messageObj.chatId, senderName);
              if (aiText) {
                let cleanText = aiText;
                
                // Parse for [SAVE_CONTACT: name="...", phone="..."]
                const saveRegex = /\[SAVE_CONTACT:\s*name=["']([^"']+)["']\s*,\s*phone=["']([^"']+)["']\]/i;
                const match = cleanText.match(saveRegex);
                
                if (match) {
                  const contactName = match[1].trim();
                  const rawPhone = match[2].trim();
                  let cleanPhone = rawPhone.replace(/[^\d]/g, '');
                  if (cleanPhone.startsWith('0')) {
                    cleanPhone = '62' + cleanPhone.slice(1);
                  }
                  
                  if (cleanPhone) {
                    await saveContactDb(contactName, cleanPhone);
                  }
                  
                  // Strip the tag from the text response
                  cleanText = cleanText.replace(saveRegex, '').trim();
                }

                // Add to temporary tracking set to mark as auto-reply in dashboard logs without prepending text
                recentAiReplies.add(cleanText);
                setTimeout(() => recentAiReplies.delete(cleanText), 10000);

                await msg.reply(cleanText);
                console.log(`[AI-RESPONSE] Sent Gemini auto-reply to ${senderName}`);
              }
            } catch (err) {
              console.error('[-] Failed generating/sending Gemini response:', err.message);
            }
          }, 2000);
          return;
        }

        // 3. Fallback Away Message (triggers only if rule for "away" exists in auto-reply rules database and AI is off)
        const awayRule = autoReplies.find(rule => rule.trigger.toLowerCase().trim() === 'away-message');
        if (awayRule) {
          const lastTriggered = awayCooldowns.get(senderNumber);
          const now = Date.now();
          
          if (!lastTriggered || (now - lastTriggered > COOLDOWN_TIME)) {
            awayCooldowns.set(senderNumber, now);
            
            let responseText = awayRule.response;
            responseText = responseText.replace(/{sender}/g, senderName);
            responseText = responseText.replace(/{time}/g, new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
            responseText = responseText.replace(/{date}/g, new Date().toLocaleDateString('id-ID'));

            setTimeout(async () => {
              try {
                await msg.reply(responseText);
                console.log(`[AWAY-MESSAGE] Sent fallback offline response to ${senderName}`);
              } catch (err) {
                console.error('[-] Failed sending away message:', err.message);
              }
            }, 2000);
          }
        }
      }
    } catch (err) {
      console.error('[-] Error handling message_create event:', err.message);
    }
  });

  console.log('[+] Initializing WhatsApp client...');
  client.initialize();
}

// --- Dynamic Client Auth Strategy Selector ---
let client;
const mongoUri = process.env.MONGODB_URI;

if (mongoUri) {
  console.log('[+] Connecting to MongoDB for remote session backup...');
  botStatus = 'Connecting to Database...';
  
  mongoose.connect(mongoUri)
      .then(() => {
        console.log('[+] Connected to MongoDB successfully.');
        loadContactsFromDb().catch(err => console.error('[-] Error loading custom contacts:', err.message));
        const store = new MongoStore({ mongoose: mongoose });
      client = new Client({
        authStrategy: new CustomRemoteAuth({
          store: store,
          backupSyncIntervalMs: 60000 // Sync backup session to database every minute
        }),
        puppeteer: getPuppeteerConfig(),
        webVersionCache: getWebVersionCacheConfig(),
        authTimeoutMs: 60000 // Increase connection timeout for slower servers
      });
      initializeClient();
    })
    .catch(err => {
      console.error('[-] MongoDB connection failed. Falling back to local authentication:', err.message);
      setupLocalClient();
    });
} else {
  console.log('[+] No MONGODB_URI detected. Using local authentication.');
  setupLocalClient();
}

function setupLocalClient() {
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: getPuppeteerConfig(),
    webVersionCache: getWebVersionCacheConfig(),
    authTimeoutMs: 60000
  });
  initializeClient();
}

// REST API: Get Bot Status
app.get('/api/status', (req, res) => {
  if (!client) {
    return res.json({
      status: 'Connecting to Database...',
      authenticated: false,
      phone: null,
      pushname: null,
      qrPending: false
    });
  }
  res.json({
    status: botStatus,
    authenticated: client.info ? true : false,
    phone: client.info && client.info.wid ? client.info.wid.user : null,
    pushname: client.info ? client.info.pushname : null,
    qrPending: latestQrCode ? true : false,
    pcOnline: pcLastSeen ? (Date.now() - pcLastSeen < 15000) : false
  });
});

// REST API: Get QR Code base64 image
app.get('/api/qr', async (qrReq, qrRes) => {
  if (!latestQrCode) {
    return qrRes.status(404).json({ error: 'No QR code pending. Bot is already logged in or initializing.' });
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQrCode);
    qrRes.json({ qr: qrImage });
  } catch (err) {
    qrRes.status(500).json({ error: 'Error generating QR code image' });
  }
});

// REST API: Get messages history (requires auth if DASHBOARD_PASSWORD set)
app.get('/api/messages', checkPassword, (req, res) => {
  res.json(messagesHistory);
});

// REST API: Get status updates timeline (requires auth if DASHBOARD_PASSWORD set)
app.get('/api/statuses', checkPassword, async (req, res) => {
  await pruneExpiredStatuses();
  res.json(statusesHistory);
});

// REST API: Send WhatsApp message (with optional file attachment support) (requires auth if DASHBOARD_PASSWORD set)
app.post('/api/send', checkPassword, async (req, res) => {
  const { contact, message, filename, fileData } = req.body;
  
  if (!contact) {
    return res.status(400).json({ error: 'Contact JID is required' });
  }

  if (!message && !fileData) {
    return res.status(400).json({ error: 'Message content or file attachment is required' });
  }

  try {
    const formattedId = formatPhoneNumber(contact);
    
    if (fileData && filename) {
      const base64Parts = fileData.split(';base64,');
      const mimetype = base64Parts[0].split(':')[1];
      const rawBase64 = base64Parts[1];
      
      const media = new MessageMedia(mimetype, rawBase64, filename);
      console.log(`[+] Sending file attachment ${filename} to ${formattedId}`);
      await client.sendMessage(formattedId, media, { caption: message || undefined });
    } else {
      console.log(`[+] Sending message to ${formattedId}: "${message}"`);
      await client.sendMessage(formattedId, message);
    }
    
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

// --- REST API: PC Remote Control Queue (secured via DASHBOARD_PASSWORD) ---

// PC Client polls this endpoint to fetch commands
app.get('/api/pc/commands', checkPassword, (req, res) => {
  pcLastSeen = Date.now();
  res.json(pendingCommands);
});

// PC Client posts execution output back here
app.post('/api/pc/respond', checkPassword, async (req, res) => {
  const { id, response, fileData, filename } = req.body;
  
  const cmdIndex = pendingCommands.findIndex(c => c.id === id);
  if (cmdIndex === -1) {
    return res.status(404).json({ error: 'Command not found or already processed' });
  }
  
  const cmd = pendingCommands[cmdIndex];
  pendingCommands.splice(cmdIndex, 1); // remove command from queue

  try {
    if (fileData && filename) {
      const base64Parts = fileData.split(';base64,');
      const mimetype = base64Parts[0].split(':')[1];
      const rawBase64 = base64Parts[1];
      
      const media = new MessageMedia(mimetype, rawBase64, filename);
      await client.sendMessage(cmd.chatId, media, { caption: response || undefined });
    } else if (response) {
      await client.sendMessage(cmd.chatId, response);
    } else {
      await client.sendMessage(cmd.chatId, '[System] PC command executed with empty response.');
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('[-] Error sending PC response back to WhatsApp:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- REST API: Settings (secured via DASHBOARD_PASSWORD) ---
app.get('/api/settings', checkPassword, (req, res) => {
  res.json({
    aiEnabled: botSettings.aiEnabled,
    systemPrompt: botSettings.systemPrompt,
    ignoredContacts: botSettings.ignoredContacts || ["Joy"],
    hasGeminiKey: process.env.GEMINI_API_KEY ? true : false
  });
});

app.post('/api/settings', checkPassword, (req, res) => {
  const { aiEnabled, systemPrompt, ignoredContacts } = req.body;
  
  if (aiEnabled !== undefined) {
    botSettings.aiEnabled = !!aiEnabled;
  }
  if (systemPrompt !== undefined) {
    botSettings.systemPrompt = systemPrompt.trim();
  }
  if (ignoredContacts !== undefined) {
    if (Array.isArray(ignoredContacts)) {
      botSettings.ignoredContacts = ignoredContacts.map(c => c.trim());
    } else if (typeof ignoredContacts === 'string') {
      botSettings.ignoredContacts = ignoredContacts.split(',').map(c => c.trim()).filter(c => c !== '');
    }
  }
  
  saveSettings();
  res.json({ success: true, message: 'Settings saved successfully!' });
});

// --- REST API: Contacts Management (secured via DASHBOARD_PASSWORD) ---
app.get('/api/contacts', checkPassword, (req, res) => {
  res.json(savedContacts);
});

app.post('/api/contacts', checkPassword, async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }
  let cleanPhone = phone.replace(/[^\d]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.slice(1);
  }
  await saveContactDb(name.trim(), cleanPhone);
  res.json({ success: true, message: 'Contact saved successfully!' });
});

app.delete('/api/contacts', checkPassword, async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone is required' });
  }
  
  let cleanPhone = phone.replace(/[^\d]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.slice(1);
  }

  savedContacts = savedContacts.filter(c => c.phone !== cleanPhone);
  saveContacts();

  if (mongoose.connection.readyState === 1) {
    try {
      const col = mongoose.connection.db.collection('custom_contacts');
      await col.deleteOne({ phone: cleanPhone });
      console.log(`[+] Deleted contact ${cleanPhone} from MongoDB.`);
    } catch (err) {
      console.error('[-] Failed deleting contact from MongoDB:', err.message);
    }
  }

  res.json({ success: true, message: 'Contact deleted successfully!' });
});

// Start Express Web Server
app.listen(PORT, () => {
  console.log(`[+] Web control panel and API running at http://localhost:${PORT}`);
  console.log(`[+] Dashboard security: ${process.env.DASHBOARD_PASSWORD ? 'ENABLED' : 'DISABLED (Set DASHBOARD_PASSWORD env variable to secure)'}`);
  
  // Clean up orphan status media and run status pruner on startup
  cleanupOrphanStatusMedia();
  pruneExpiredStatuses();
  // Register an hourly status pruning interval
  setInterval(pruneExpiredStatuses, 60 * 60 * 1000);
});
