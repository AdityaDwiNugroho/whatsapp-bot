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
import { execSync, exec } from 'child_process';
import { google } from 'googleapis';

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
const stickersDir = path.join(__dirname, 'stickers');
const classroomTokensPath = path.join(__dirname, 'classroom_tokens.json');

// Ensure directories exist
if (!fs.existsSync(statusMediaDir)) {
  fs.mkdirSync(statusMediaDir, { recursive: true });
}
if (!fs.existsSync(stickersDir)) {
  fs.mkdirSync(stickersDir, { recursive: true });
}

function getStickerNames() {
  try {
    const files = fs.readdirSync(stickersDir);
    return files
      .filter(f => f.endsWith('.webp') || f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
      .map(f => path.parse(f).name);
  } catch (e) {
    return [];
  }
}

// Memory storage
let botStatus = 'Initializing...';
let latestQrCode = null;
let messagesHistory = [];
let statusesHistory = [];
let autoReplies = [];
let botSettings = {
  aiEnabled: false,
  systemPrompt: "You are the account owner (Adit) chatting on WhatsApp. You must NEVER act like an AI, bot, or virtual assistant. NEVER say phrases like 'How can I help you?', 'I am an assistant', or ask open-ended questions like a customer support bot. Do not use emojis. You must dynamically adapt your tone based on who is texting:\n\n1. If the contact is a lecturer, professor, or authority figure (e.g., their name contains 'Pak', 'Bu', 'Prof', 'Dosen', or their message is formal, polite, or relates to assignments/exams/classes):\n- Respond formally, politely, and respectfully in standard Indonesian.\n- Use polite greetings (e.g., 'Selamat siang Pak/Bu', 'Baik, terima kasih Pak/Bu').\n- Avoid all slang/abbreviations (no 'gw', 'lu', 'wkwk', etc.).\n- Keep the communication brief and respectful.\n\n2. If the contact is a friend, peer, or classmate (even if they are a group admin):\n- Respond casually, emotionally maturely, and match their energy.\n- Mirror their texting style dynamically. Do not force texting abbreviations ('gw', 'lu', 'yg', etc.) or conversational particles ('wkwk', 'lah', 'deh') if they do not use them or are texting more seriously/differently. Adapt based on whether the contact is a guy or woman, matching their conversational vibe, response length, vocabulary, and general tone (e.g. if they write short, keep your replies short; if they laugh with 'wkwk', you can too, otherwise do not).\n- Keep responses short, direct, and conversational. Do not write paragraph-long responses unless asked to explain a topic/code.\n- Handle choices or fragmented messages (e.g., 'kerupuk', 'ato bayam') by choosing one naturally (e.g., 'bayam lah' or 'bayam sih') rather than analyzing both options formally.\n- Handle attention grabs or name spam (e.g., 'dit', 'dit', 'dit') with a single, simple casual response (e.g., 'oi', 'apa?', 'paan', 'ya?'). Never repeat yourself or respond to each call.\n- Show emotional intelligence: be cool, supportive, or lighthearted; never be preachy, condescending, or defensive.",
  ignoredContacts: ["Joy", "Momskuy"]
};

// Tracking AI-generated response texts for dashboard flags
const recentAiReplies = new Set();

// Map to keep track of debounced messages per chat JID
const debouncedChats = new Map();

// Map to track manual auto-pause timestamps per chat JID
const activePauseMap = new Map();

// In-memory cache for audio base64 data to avoid ballooning messages_history.json
const audioDataCache = new Map();

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
    // Disable protocol timeout to prevent Runtime.callFunctionOn timeouts
    protocolTimeout: 0,
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
    type: 'local'
  };
}

// Helper: Get MIME type of file
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/vnd.rar',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Helper: List files and folders
function handleListFiles(dirPath) {
  const homeDir = os.homedir();
  let targetPath = dirPath || path.join(homeDir, 'Documents');
  
  if (targetPath.startsWith('~')) {
    targetPath = path.join(homeDir, targetPath.slice(1));
  } else if (!path.isAbsolute(targetPath)) {
    targetPath = path.join(homeDir, targetPath);
  }
  
  try {
    if (!fs.existsSync(targetPath)) {
      return { error: `Directory does not exist: ${targetPath}` };
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return { error: `Path is not a directory: ${targetPath}` };
    }
    
    const items = fs.readdirSync(targetPath);
    const result = items.map(name => {
      try {
        const full = path.join(targetPath, name);
        const s = fs.statSync(full);
        return {
          name,
          type: s.isDirectory() ? 'directory' : 'file',
          size: s.isFile() ? s.size : undefined,
          modified: s.mtime
        };
      } catch (e) {
        return { name, error: 'Access denied' };
      }
    });
    
    return { path: targetPath, items: result.slice(0, 100), totalItems: result.length };
  } catch (err) {
    return { error: err.message };
  }
}

// Helper: Search for files/folders using PowerShell Get-ChildItem
function handleSearchFiles(query, rootDir) {
  const homeDir = os.homedir();
  let targetRoot = rootDir || path.join(homeDir, 'Documents');
  
  if (targetRoot.startsWith('~')) {
    targetRoot = path.join(homeDir, targetRoot.slice(1));
  } else if (!path.isAbsolute(targetRoot)) {
    targetRoot = path.join(homeDir, targetRoot);
  }
  
  let filter = query;
  if (!filter.includes('*')) {
    filter = `*${filter}*`;
  }
  
  try {
    const cmd = "powershell -Command \"Get-ChildItem -Path '" + targetRoot.replace(/'/g, "''") + "' -Filter '" + filter.replace(/'/g, "''") + "' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike '*\\node_modules\\*' -and $_.FullName -notlike '*\\AppData\\*' -and $_.FullName -notlike '*\\.git\\*' -and $_.FullName -notlike '*\\.cache\\*' } | Select-Object -First 50 | ForEach-Object { $_.FullName + ' (' + (if ($_.PSIsContainer) { 'Dir' } else { 'File' }) + ')' }\"";
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const results = output.split('\r\n').map(l => l.trim()).filter(l => l.length > 0);
    return { rootDir: targetRoot, query, results };
  } catch (err) {
    return { error: err.message };
  }
}

// Helper: Load and send file over WhatsApp JID
async function handleSendFile(filePath, chatId, caption) {
  const homeDir = os.homedir();
  let targetPath = filePath;
  if (targetPath.startsWith('~')) {
    targetPath = path.join(homeDir, targetPath.slice(1));
  } else if (!path.isAbsolute(targetPath)) {
    targetPath = path.join(homeDir, targetPath);
  }

  try {
    if (!fs.existsSync(targetPath)) {
      return { error: `File not found: ${targetPath}` };
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { error: `Path is a directory, not a file: ${targetPath}` };
    }

    const data = fs.readFileSync(targetPath);
    const base64 = data.toString('base64');
    const filename = path.basename(targetPath);
    const mimeType = getMimeType(targetPath);

    const media = new MessageMedia(mimeType, base64, filename);
    await client.sendMessage(chatId, media, { caption: caption || undefined });
    
    return { success: true, message: `Successfully sent file: ${filename}` };
  } catch (err) {
    return { error: err.message };
  }
}

// Helper: Delete/revoke last N messages sent by the bot in a chat
async function handleDeleteLastMessage(chatId, count = 1) {
  try {
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    // Filter messages where fromMe is true, and reverse them to get the most recent first
    const myMessages = messages.filter(m => m.fromMe).reverse();
    
    let deletedCount = 0;
    for (let i = 0; i < Math.min(count, myMessages.length); i++) {
      try {
        await myMessages[i].delete(true);
        deletedCount++;
      } catch (err) {
        console.error(`[-] Failed to delete message ${myMessages[i].id.id}:`, err.message);
      }
    }
    return { success: true, message: `Successfully deleted ${deletedCount} messages for everyone.` };
  } catch (err) {
    return { error: err.message };
  }
}

// Helper: Add a task/reminder and show native Windows notification balloon
function handleAddReminder(title, dueDate, description) {
  const remindersPath = path.join(__dirname, 'reminders.json');
  let reminders = [];
  
  try {
    if (fs.existsSync(remindersPath)) {
      reminders = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    }
  } catch (err) {
    console.error('[-] Error reading reminders.json:', err.message);
  }
  
  const newReminder = {
    id: Math.random().toString(36).substring(2, 9),
    title: title.trim(),
    dueDate: dueDate.trim(),
    description: description ? description.trim() : "",
    createdAt: new Date().toISOString()
  };
  
  reminders.push(newReminder);
  
  try {
    fs.writeFileSync(remindersPath, JSON.stringify(reminders, null, 2));
    console.log(`[REMINDER] Logged new reminder: "${newReminder.title}" due "${newReminder.dueDate}"`);
    
    // Spawn native Windows notification balloon/toast
    const cleanTitle = newReminder.title.replace(/'/g, "''");
    const cleanDue = newReminder.dueDate.replace(/'/g, "''");
    const cleanDesc = newReminder.description ? newReminder.description.replace(/'/g, "''") : "";
    
    const psCommand = `powershell -Command "[void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $notification = New-Object System.Windows.Forms.NotifyIcon; $notification.Icon = [System.Drawing.SystemIcons]::Information; $notification.BalloonTipTitle = 'WhatsApp Task Logged'; $notification.BalloonTipText = 'Task: ${cleanTitle}\\nDue: ${cleanDue}\\n${cleanDesc}'; $notification.Visible = $true; $notification.ShowBalloonTip(7000); Start-Sleep -Seconds 2"`;
    
    // Execute powershell asynchronously so it doesn't block Node
    exec(psCommand, (error) => {
      if (error) {
        console.error('[-] Failed to show Windows reminder notification:', error.message);
      }
    });
    
    return { success: true, message: `Successfully logged reminder: "${newReminder.title}"` };
  } catch (err) {
    console.error('[-] Error saving reminder:', err.message);
    return { error: err.message };
  }
}

// Define Google Classroom tools for the Gemini model
const classroomTools = [
  {
    name: 'getClassroomCourses',
    description: 'Lists the active courses/classes the user (Adit) is currently enrolled in on Google Classroom. Use this when the user or contact asks about active classes or courses.'
  },
  {
    name: 'getClassroomAssignments',
    description: 'Lists the upcoming/pending coursework and school assignments across all active Google Classroom courses. Use this when the user or a contact asks about homework, tasks, upcoming assignments, or due dates (e.g. "Besok ada tugas apa?" / "What assignments are due tomorrow?").'
  },
  {
    name: 'getClassroomAnnouncements',
    description: 'Lists the recent class announcements or updates across all active Google Classroom courses. Use this when the user or a contact asks about updates, notifications, or announcements from their teachers.'
  }
];

// Define the file system tools for the Gemini model
const fileTools = [
  {
    functionDeclarations: [
      {
        name: 'listFiles',
        description: 'Lists the files and folders in a specified directory path on the user\'s local computer.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: {
              type: 'STRING',
              description: 'The absolute or relative directory path to list (e.g., "C:\\Users\\itsYurtzy\\Documents").'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'searchFiles',
        description: 'Recursively searches for files/folders matching a query (partial name or wildcard) starting from a specific root directory on the user\'s local computer.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The search query or filename pattern (e.g., "pertemuan ke 8" or "*.pdf").'
            },
            rootDir: {
              type: 'STRING',
              description: 'Optional root directory to start searching from. Defaults to the user\'s Documents folder.'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'sendFile',
        description: 'Sends a file (image, document, PDF, etc.) from the user\'s local PC to the current WhatsApp chat.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: {
              type: 'STRING',
              description: 'The absolute path to the file on the local PC.'
            },
            caption: {
              type: 'STRING',
              description: 'Optional caption/message to send with the file.'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'deleteLastMessage',
        description: 'Deletes or revokes the most recent message(s) sent by the bot/owner in this chat (delete for everyone). Call this when the user explicitly asks you to delete, unsend, recall, or cancel a message.',
        parameters: {
          type: 'OBJECT',
          properties: {
            count: {
              type: 'INTEGER',
              description: 'The number of recent messages to delete. Defaults to 1.'
            }
          }
        }
      },
      {
        name: 'addReminder',
        description: 'Saves a task, assignment, meeting, homework, or general reminder mentioned in the chat to the owner\'s local calendar database, and displays a Windows notification on their PC. Use this whenever the contact or owner mentions a task to remember or a deadline.',
        parameters: {
          type: 'OBJECT',
          properties: {
            title: {
              type: 'STRING',
              description: 'The title/name of the reminder or task (e.g. "Kumpul Praktikum 8" or "Pertemuan Dosen").'
            },
            dueDate: {
              type: 'STRING',
              description: 'The deadline or time of the task (e.g. "Besok jam 8 pagi" or "Senin depan").'
            },
            description: {
              type: 'STRING',
              description: 'Any extra details, context, or notes for the task.'
            }
          },
          required: ['title', 'dueDate']
        }
      }
    ]
  }
];

// Call Gemini API to generate dynamic response with chat history context
async function generateGeminiResponse(chatId, senderName, isOwner) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  let timeContext = "";
  
  if (hour >= 23 || hour < 6) {
    timeContext = "\n- Current time is late night/sleeping hours. The owner (Adit) is likely asleep. Respond briefly and match a sleeping/resting vibe if appropriate.";
  } else if (day >= 1 && day <= 5 && hour >= 8 && hour <= 16) {
    timeContext = "\n- Current time is standard weekday class hours. The owner (Adit) is likely attending college lectures. Keep responses brief.";
  } else {
    timeContext = "\n- Current time is free/weekend time.";
  }

  // Filter and sort messages history chronologically for this specific conversation thread
  const rawHistory = messagesHistory
    .filter(m => m.chatId === chatId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  // Format history to Gemini format (user = contact, model = bot)
  const contents = [];
  rawHistory.slice(-10).forEach(m => {
    const role = m.fromMe ? 'model' : 'user';
    let text = m.message;
    
    // Strip the [AI] tag from previous assistant responses to give clean text context
    if (m.fromMe && text.startsWith('[AI] ')) {
      text = text.slice(5);
    }
    
    // Check if we have audioData cached in audioDataCache
    const cachedAudio = audioDataCache.get(m.id);
    if (cachedAudio) {
      contents.push({
        role: role,
        parts: [
          {
            inlineData: {
              mimeType: cachedAudio.mimeType,
              data: cachedAudio.data
            }
          },
          { text: text }
        ]
      });
    } else {
      contents.push({
        role: role,
        parts: [{ text: text }]
      });
    }
  });

  // Consolidate consecutive turns with the same role to strictly alternate user/model turns
  const alternatingContents = [];
  contents.forEach(item => {
    if (alternatingContents.length > 0 && alternatingContents[alternatingContents.length - 1].role === item.role) {
      alternatingContents[alternatingContents.length - 1].parts.push(...item.parts);
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
  
  const stickerNames = getStickerNames();
  let stickerContext = "";
  if (stickerNames.length > 0) {
    stickerContext = `\n\nYou also have the capability to reply with a sticker as a reaction. The available stickers you can send are: ${stickerNames.map(s => `'${s}'`).join(', ')}. If you want to send a sticker, you MUST append the following tag to your response: [SEND_STICKER: name="sticker_name"] (replace 'sticker_name' with one of the available stickers). Do not output this tag unless you want to send a sticker. CRITICAL RULES: 1. Only send stickers in casual conversations with friends. 2. NEVER send stickers to lecturers, professors, or in formal chats. 3. Use stickers sparingly (at most 10-20% of the time when a reaction fits perfectly). DO NOT spam stickers or send them in consecutive messages.`;
  }

  // Inject context helper in system instruction
  let systemInstructionText = `${botSettings.systemPrompt}

You also have the capability to save new contacts or update contact names in the database. 
If a contact asks you to save their number, change/update their name, or remember them by a name:
You MUST append the following tag to the very end of your message response:
[SAVE_CONTACT: name="Desired Name", phone="whatsapp_number_or_JID_digits"]

Replace 'Desired Name' with the name they requested.
Replace 'whatsapp_number_or_JID_digits' with their phone number digits (e.g. "628123456789"). You can use the active contact's phone number JID digits provided below if they say "save my number".
Do not output this tag unless name saving/updating was explicitly requested.${stickerContext}`;

  if (isOwner) {
    systemInstructionText += `\n\nAdditionally, you have access to tools that can interact with the local PC's filesystem. You can search for files/directories, list directory contents, or send files (images, documents, PDFs, etc.) directly to the active chat. Use these tools whenever the user asks about their files/folders, asks you to locate something on the PC, or asks you to send them a file/image/doc.`;
  }

  systemInstructionText += `\n\nAdditional Context:
- Current Date/Time: ${new Date().toLocaleString('id-ID')}
- Active Chat Contact Name: ${senderName}
- Active Chat Contact Phone/JID: ${chatId.split('@')[0]}${timeContext}`;

  let requestBody = {
    contents: alternatingContents,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    }
  };

  const activeDeclarations = [];
  const isClassroomConnected = fs.existsSync(classroomTokensPath);
  if (isClassroomConnected) {
    activeDeclarations.push(...classroomTools);
  }
  if (isOwner) {
    if (fileTools && fileTools[0] && fileTools[0].functionDeclarations) {
      activeDeclarations.push(...fileTools[0].functionDeclarations);
    }
  }

  if (activeDeclarations.length > 0) {
    requestBody.tools = [{ functionDeclarations: activeDeclarations }];
  }

  let maxIterations = 5;
  while (maxIterations > 0) {
    maxIterations--;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[-] Gemini API error in function loop:', errText);
        return null;
      }

      const data = await response.json();
      if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        return null;
      }

      const candidate = data.candidates[0];
      const parts = candidate.content.parts;
      
      // Check for function calls
      const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
      if (functionCalls.length > 0) {
        // Add the model's message (which contains the function calls) to history
        requestBody.contents.push(candidate.content);
        
        const toolResponses = [];
        
        for (const call of functionCalls) {
          const { name, args, id } = call;
          console.log(`[AI-TOOL] Model requested to run function: ${name} with args:`, args);
          
          let result;
          if (name === 'getClassroomCourses') {
            result = await handleGetClassroomCourses();
          } else if (name === 'getClassroomAssignments') {
            result = await handleGetClassroomAssignments();
          } else if (name === 'getClassroomAnnouncements') {
            result = await handleGetClassroomAnnouncements();
          } else if (!isOwner) {
            result = { error: "Permission denied: Only the owner of the bot is authorized to use these tools." };
          } else if (name === 'listFiles') {
            result = handleListFiles(args.path);
          } else if (name === 'searchFiles') {
            result = handleSearchFiles(args.query, args.rootDir);
          } else if (name === 'sendFile') {
            result = await handleSendFile(args.path, chatId, args.caption);
          } else if (name === 'deleteLastMessage') {
            result = await handleDeleteLastMessage(chatId, args.count || 1);
          } else if (name === 'addReminder') {
            result = await handleAddReminder(args.title, args.dueDate, args.description);
          } else {
            result = { error: `Function ${name} not found.` };
          }
          
          toolResponses.push({
            functionResponse: {
              name,
              id,
              response: { result }
            }
          });
        }
        
        // Append the tool responses to history
        requestBody.contents.push({
          role: 'tool',
          parts: toolResponses
        });
        
        // Continue the loop to let the model generate the text using the tool output
        continue;
      }

      // If no function call, return the text
      if (parts[0] && parts[0].text) {
        return parts[0].text.trim();
      }
      
      return null;
    } catch (err) {
      console.error('[-] Error in Gemini function loop:', err.message);
      return null;
    }
  }
  
  return null;
}

// Helper: Queue incoming messages for debounced reply processing
function enqueueIncomingMessage(msg, messageObj, senderName, isOwner, isIgnored, bodyText) {
  const chatId = messageObj.chatId;

  if (!debouncedChats.has(chatId)) {
    debouncedChats.set(chatId, {
      messages: [],
      timeoutId: null,
      senderName,
      isOwner,
      isIgnored,
      chatName: messageObj.chatName
    });
  }

  const chatData = debouncedChats.get(chatId);
  chatData.messages.push({ msg, bodyText });

  if (chatData.timeoutId) {
    clearTimeout(chatData.timeoutId);
  }

  chatData.timeoutId = setTimeout(() => {
    processDebouncedChat(chatId);
  }, 5000); // 5 seconds debounce window
}

// Helper: Process combined incoming messages and trigger a single reply
async function processDebouncedChat(chatId) {
  const chatData = debouncedChats.get(chatId);
  if (!chatData) return;

  // Remove from Map so new messages start a new queue window
  debouncedChats.delete(chatId);

  const { messages, senderName, isOwner, isIgnored } = chatData;
  if (messages.length === 0) return;

  // Check if the user (or the bot) has already replied to this chat since these messages were received
  const chatHistory = messagesHistory
    .filter(m => m.chatId === chatId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (chatHistory.length > 0) {
    const actualLatestMsg = chatHistory[chatHistory.length - 1];
    // If the actual latest message in this chat is from me, it means the user manually replied
    // (or the bot already answered) while this burst was debouncing or offline. Skip sending another auto-reply.
    if (actualLatestMsg.fromMe) {
      console.log(`[DEBOUNCE] User has already replied to chat ${chatId} (Latest msg: "${actualLatestMsg.message}"). Skipping auto-reply.`);
      return;
    }
  }

  // Use the most recent message in the burst to reply to
  const latestMsgData = messages[messages.length - 1];
  const lastMsg = latestMsgData.msg;

  // Consolidate the message bodies
  const consolidatedText = messages.map(m => m.bodyText).join('\n');
  const text = consolidatedText.toLowerCase().trim();

  console.log(`[DEBOUNCE] Processing consolidated incoming message(s) from ${senderName}: "${consolidatedText.replace(/\n/g, ' | ')}"`);

  // 1. Match static keywords using Word Boundaries on the consolidated text
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
        await lastMsg.reply(responseText);
        console.log(`[AUTO-REPLY] Sent response for keyword "${matchedRule.trigger}" to ${senderName}`);
      } catch (replyErr) {
        console.error('[-] Failed sending auto reply:', replyErr.message);
      }
    }, 1500);
    return;
  }

  // 2. If no static keyword matched, fallback to Gemini AI Assistant if enabled
  if (botSettings.aiEnabled && process.env.GEMINI_API_KEY) {
    try {
      const aiText = await generateGeminiResponse(chatId, senderName, isOwner);
      if (aiText) {
        let cleanText = aiText;

        // Parse for [SAVE_CONTACT: name="...", phone="..."]
        const saveRegex = /\[SAVE_CONTACT:\s*name=["']([^"']+)["']\s*,\s*phone=["']([^"']+)["']\]/i;
        const saveMatch = cleanText.match(saveRegex);

        if (saveMatch) {
          const contactName = saveMatch[1].trim();
          const rawPhone = saveMatch[2].trim();
          let cleanPhone = rawPhone.replace(/[^\d]/g, '');
          if (cleanPhone.startsWith('0')) {
            cleanPhone = '62' + cleanPhone.slice(1);
          }

          if (cleanPhone) {
            await saveContactDb(contactName, cleanPhone);
          }

          cleanText = cleanText.replace(saveRegex, '').trim();
        }

        // Parse for [SEND_STICKER: name="..."]
        const stickerRegex = /\[SEND_STICKER:\s*name=["']([^"']+)["']\]/i;
        const stickerMatch = cleanText.match(stickerRegex);
        let stickerToMessage = null;

        if (stickerMatch) {
          const stickerName = stickerMatch[1].trim().toLowerCase();
          const extensions = ['webp', 'png', 'jpg', 'jpeg'];
          let foundPath = null;
          for (const ext of extensions) {
            const p = path.join(stickersDir, `${stickerName}.${ext}`);
            if (fs.existsSync(p)) {
              foundPath = p;
              break;
            }
          }

          if (foundPath) {
            try {
              stickerToMessage = MessageMedia.fromFilePath(foundPath);
              console.log(`[+] Loaded sticker "${stickerName}" from: ${foundPath}`);
            } catch (mediaErr) {
              console.error('[-] Failed loading sticker media:', mediaErr.message);
            }
          } else {
            console.log(`[-] Sticker "${stickerName}" not found in stickers folder.`);
          }

          cleanText = cleanText.replace(stickerRegex, '').trim();
        }

        if (cleanText) {
          recentAiReplies.add(cleanText);
          setTimeout(() => recentAiReplies.delete(cleanText), 10000);
          await lastMsg.reply(cleanText);
          console.log(`[AI-RESPONSE] Sent Gemini auto-reply to ${senderName}`);
        }

        if (stickerToMessage) {
          const cleanSenderName = senderName.toLowerCase();
          const isFormalContact = cleanSenderName.includes('pak') || 
                                  cleanSenderName.includes('bu') || 
                                  cleanSenderName.includes('prof') || 
                                  cleanSenderName.includes('dosen');

          if (isFormalContact) {
            console.log(`[SAFEGUARD] Blocked sticker sending to formal contact: ${senderName}`);
          } else {
            setTimeout(async () => {
              try {
                await client.sendMessage(lastMsg.from, stickerToMessage, { sendMediaAsSticker: true });
                console.log(`[AI-RESPONSE] Sent sticker reaction to ${senderName}`);
              } catch (stickErr) {
                console.error('[-] Failed sending sticker:', stickErr.message);
              }
            }, cleanText ? 1000 : 0);
          }
        }
      }
    } catch (err) {
      console.error('[-] Failed generating/sending Gemini response:', err.message);
    }
    return;
  }

  // 3. Fallback Away Message (triggers only if rule for "away" exists in auto-reply rules database and AI is off)
  const awayRule = autoReplies.find(rule => rule.trigger.toLowerCase().trim() === 'away-message');
  if (awayRule) {
    const senderNumber = lastMsg.from.split('@')[0];
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
          await lastMsg.reply(responseText);
          console.log(`[AWAY-MESSAGE] Sent fallback offline response to ${senderName}`);
        } catch (err) {
          console.error('[-] Failed sending away message:', err.message);
        }
      }, 1500);
    }
  }
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
      // Limit startup prepopulation to prevent timeouts
      const maxPrepopulate = 25;
      for (const chat of chats) {
        if (populatedCount >= maxPrepopulate) break;
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

  // Event: Handling message deletion/revocation
  client.on('message_revoke_everyone', async (after, before) => {
    try {
      const msgId = after.id.id;
      const index = messagesHistory.findIndex(m => m.id === msgId);
      if (index > -1) {
        messagesHistory[index].isDeleted = true;
        if (before && before.body) {
          let bodyText = before.body || '';
          if (before.hasMedia) {
            bodyText = '[Attachment File]';
          }
          messagesHistory[index].message = bodyText;
        }
        saveMessages();
        console.log(`[REVOKE] Preserved deleted message ${msgId} content: "${messagesHistory[index].message}"`);
      } else if (before) {
        let bodyText = before.body || '';
        if (before.hasMedia) {
          bodyText = '[Attachment File]';
        }
        const senderNumber = before.from.split('@')[0];
        let senderName = senderNumber;
        const saved = savedContacts.find(c => c.phone === senderNumber);
        if (saved) {
          senderName = saved.name;
        } else {
          try {
            const contact = await before.getContact();
            senderName = contact.name || contact.pushname || senderNumber;
          } catch (e) {}
        }
        const timestampStr = formatLocalTimestamp(before.timestamp);
        messagesHistory.push({
          id: before.id.id,
          timestamp: timestampStr,
          fromMe: before.fromMe,
          sender: before.fromMe ? 'Me' : senderName,
          message: bodyText,
          chatId: before.fromMe ? before.to : before.from,
          chatName: senderName,
          isAutoReply: false,
          isDeleted: true
        });
        saveMessages();
        console.log(`[REVOKE] Preserved uncached deleted message ${before.id.id} content: "${bodyText}"`);
      }
    } catch (err) {
      console.error('[-] Error handling message_revoke_everyone event:', err.message);
    }
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
        if (msg.type === 'audio' || msg.type === 'voice' || (msg.mimetype && msg.mimetype.includes('audio'))) {
          bodyText = '[Voice Note Audio]';
          try {
            const media = await msg.downloadMedia();
            if (media) {
              audioDataCache.set(msg.id.id, { data: media.data, mimeType: media.mimetype });
              // Prune cache to keep it under 50 items
              if (audioDataCache.size > 50) {
                const oldestKey = audioDataCache.keys().next().value;
                audioDataCache.delete(oldestKey);
              }
              console.log(`[AUDIO] Downloaded voice note from ${senderName} (${media.data.length} bytes base64)`);
            }
          } catch (audioErr) {
            console.error('[-] Failed downloading voice note media:', audioErr.message);
          }
        } else {
          bodyText = '[Attachment File]';
        }
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

      // Active Chat Override: Pause bot in this chat for 1 minute if owner manually typed a message
      if (msg.fromMe && !isAutoReply) {
        activePauseMap.set(messageObj.chatId, Date.now());
        console.log(`[PAUSE] Owner manual message detected. Auto-pausing bot for chat ${messageObj.chatId} for 1 minute.`);
        
        const chatIdForLog = messageObj.chatId;
        setTimeout(() => {
          const lastTime = activePauseMap.get(chatIdForLog);
          // Only log if the pause has not been overwritten/reset by a newer manual message
          if (lastTime && (Date.now() - lastTime >= 60000 - 100)) {
            console.log(`[PAUSE] 1 minute cooldown expired. Bot is now active again for chat ${chatIdForLog}.`);
          }
        }, 60000);
      }

      // --- Administrative Delete/Unsend Commands ---
      // If the owner sends /delete or /unsend or /cancel, delete the last N messages they sent in this chat for everyone.
      const commandBody = (msg.body || '').trim();
      const lowerBody = commandBody.toLowerCase();
      if (isOwner && (
        lowerBody.startsWith('/delete') || 
        lowerBody.startsWith('/unsend') || 
        lowerBody.startsWith('/cancel') || 
        lowerBody === 'delete' || 
        lowerBody === 'unsend' || 
        lowerBody === 'batal'
      )) {
        let count = 1;
        const parts = commandBody.split(' ');
        if (parts.length > 1) {
          const parsedCount = parseInt(parts[1], 10);
          if (!isNaN(parsedCount) && parsedCount > 0) {
            count = parsedCount;
          }
        }
        try {
          const chatMessages = await chat.fetchMessages({ limit: 100 });
          // Get our own messages (fromMe === true), newest first, excluding the command message itself
          const myMessages = chatMessages.filter(m => m.fromMe && m.id.id !== msg.id.id).reverse();
          
          let deletedCount = 0;
          for (let i = 0; i < Math.min(count, myMessages.length); i++) {
            try {
              await myMessages[i].delete(true);
              deletedCount++;
            } catch (err) {
              console.error(`[-] Failed to delete message ${myMessages[i].id.id}:`, err.message);
            }
          }
          // Also delete the command message itself
          try {
            await msg.delete(true);
          } catch (err) {
            console.error(`[-] Failed to delete command message:`, err.message);
          }
          console.log(`[DELETE] Deleted ${deletedCount} messages for everyone in chat ${chat.name || senderNumber}`);
        } catch (err) {
          console.error('[-] Error executing delete command:', err.message);
        }
        return;
      }

      // --- Google Classroom Manual Commands (Owner Only) ---
      if (isOwner && bodyText.startsWith('/classroom')) {
        const cmdParts = bodyText.split(' ');
        const subCommand = cmdParts[1] ? cmdParts[1].toLowerCase().trim() : '';

        if (!fs.existsSync(classroomTokensPath)) {
          await msg.reply('Google Classroom is not connected. Please connect it via the web control panel first.');
          return;
        }

        if (subCommand === 'courses' || subCommand === 'kelas') {
          const courses = await getClassroomCourses();
          if (courses.length === 0) {
            await msg.reply('Tidak ada kelas aktif yang ditemukan di Google Classroom.');
          } else {
            let replyText = '*📚 DAFTAR KELAS GOOGLE CLASSROOM:*\n\n';
            courses.forEach((c, idx) => {
              replyText += `${idx + 1}. *${c.name}*\n`;
              if (c.section) replyText += `   Seksi: ${c.section}\n`;
              replyText += `   Link: ${c.alternateLink}\n\n`;
            });
            await msg.reply(replyText.trim());
          }
          return;
        }

        if (subCommand === 'assignments' || subCommand === 'tugas') {
          const assignments = await getClassroomAssignments();
          if (assignments.length === 0) {
            await msg.reply('Hore! Tidak ada tugas atau assignment aktif/mendatang di Google Classroom.');
          } else {
            let replyText = '*📝 DAFTAR TUGAS GOOGLE CLASSROOM (PENDING):*\n\n';
            assignments.forEach((a, idx) => {
              let dueStr = 'Tidak ada tenggat';
              if (a.dueDate) {
                const day = String(a.dueDate.day).padStart(2, '0');
                const month = String(a.dueDate.month).padStart(2, '0');
                const year = a.dueDate.year;
                dueStr = `${day}/${month}/${year}`;
                if (a.dueTime) {
                  const hour = String(a.dueTime.hours || 0).padStart(2, '0');
                  const minute = String(a.dueTime.minutes || 0).padStart(2, '0');
                  dueStr += ` jam ${hour}:${minute}`;
                }
              }
              replyText += `${idx + 1}. *${a.title}*\n`;
              replyText += `   📖 Kelas: ${a.courseName}\n`;
              replyText += `   ⏰ Deadline: ${dueStr}\n`;
              replyText += `   🔗 Link: ${a.alternateLink}\n\n`;
            });
            await msg.reply(replyText.trim());
          }
          return;
        }

        if (subCommand === 'announcements' || subCommand === 'pengumuman') {
          const announcements = await getClassroomAnnouncements();
          if (announcements.length === 0) {
            await msg.reply('Tidak ada pengumuman kelas terbaru di Google Classroom.');
          } else {
            let replyText = '*📢 PENGUMUMAN KELAS TERBARU:*\n\n';
            announcements.slice(0, 5).forEach((a, idx) => {
              const date = new Date(a.creationTime).toLocaleString('id-ID');
              replyText += `${idx + 1}. *${a.courseName}* (${date})\n`;
              replyText += `   "${a.text.trim().substring(0, 300)}${a.text.trim().length > 300 ? '...' : ''}"\n`;
              if (a.alternateLink) replyText += `   Link: ${a.alternateLink}\n`;
              replyText += '\n';
            });
            await msg.reply(replyText.trim());
          }
          return;
        }

        await msg.reply('Gunakan perintah berikut:\n- `/classroom courses` : Daftar kelas aktif\n- `/classroom assignments` : Daftar tugas mendatang\n- `/classroom announcements` : Daftar pengumuman terbaru');
        return;
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

      // Auto-reply logic (only for incoming messages, not from self, and not non-audio media)
      const isVoiceNote = msg.hasMedia && (msg.type === 'audio' || msg.type === 'voice' || (msg.mimetype && msg.mimetype.includes('audio')));
      if (!msg.fromMe && (!msg.hasMedia || isVoiceNote)) {
        // Skip ignored or archived contacts from auto-responses
        if (isIgnored) {
          return;
        }

        // Check if chat is auto-paused by owner's recent manual messaging (1 minute cooldown)
        const lastManualTime = activePauseMap.get(messageObj.chatId);
        if (lastManualTime && (Date.now() - lastManualTime < 1 * 60 * 1000)) {
          const secsRemaining = Math.ceil((1 * 60 * 1000 - (Date.now() - lastManualTime)) / 1000);
          console.log(`[PAUSE] Bot is paused in chat ${messageObj.chatId} (${secsRemaining}s remaining). Ignoring incoming message.`);
          return;
        }

        enqueueIncomingMessage(msg, messageObj, senderName, isOwner, isIgnored, bodyText);
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

// ==========================================
// GOOGLE CLASSROOM INTEGRATION
// ==========================================

function getClassroomOAuth2Client() {
  const clientId = process.env.CLASSROOM_CLIENT_ID;
  const clientSecret = process.env.CLASSROOM_CLIENT_SECRET;
  const redirectUri = process.env.CLASSROOM_REDIRECT_URI || 'http://localhost:7860/api/classroom/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  if (fs.existsSync(classroomTokensPath)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(classroomTokensPath, 'utf8'));
      oauth.setCredentials(tokens);
    } catch (err) {
      console.error('[-] Error reading classroom tokens:', err.message);
    }
  }

  return oauth;
}

async function getClassroomCourses() {
  const oauth = getClassroomOAuth2Client();
  if (!oauth) return [];

  const classroom = google.classroom({ version: 'v1', auth: oauth });
  try {
    const response = await classroom.courses.list({
      courseStates: ['ACTIVE']
    });
    return response.data.courses || [];
  } catch (err) {
    console.error('[-] Error fetching Classroom courses:', err.message);
    return [];
  }
}

async function getClassroomAssignments() {
  const oauth = getClassroomOAuth2Client();
  if (!oauth) return [];

  const classroom = google.classroom({ version: 'v1', auth: oauth });
  try {
    const courses = await getClassroomCourses();
    if (courses.length === 0) return [];

    let allCourseWork = [];
    const promises = courses.map(async (course) => {
      try {
        const response = await classroom.courses.courseWork.list({
          courseId: course.id,
          orderBy: 'dueDate asc'
        });
        const coursework = response.data.courseWork || [];
        return coursework.map(work => ({
          ...work,
          courseName: course.name
        }));
      } catch (e) {
        return [];
      }
    });

    const results = await Promise.all(promises);
    allCourseWork = results.flat();

    const now = new Date();
    const pending = allCourseWork.filter(work => {
      if (!work.dueDate) return false;
      
      const dueYear = work.dueDate.year;
      const dueMonth = work.dueDate.month - 1;
      const dueDay = work.dueDate.day;
      
      let dueHours = 23;
      let dueMinutes = 59;
      if (work.dueTime) {
        dueHours = work.dueTime.hours || 0;
        dueMinutes = work.dueTime.minutes || 0;
      }
      
      const dueDateObj = new Date(dueYear, dueMonth, dueDay, dueHours, dueMinutes);
      work.dueDateObj = dueDateObj;
      
      return dueDateObj >= now;
    });

    pending.sort((a, b) => a.dueDateObj - b.dueDateObj);
    return pending;
  } catch (err) {
    console.error('[-] Error fetching Classroom assignments:', err.message);
    return [];
  }
}

async function getClassroomAnnouncements() {
  const oauth = getClassroomOAuth2Client();
  if (!oauth) return [];

  const classroom = google.classroom({ version: 'v1', auth: oauth });
  try {
    const courses = await getClassroomCourses();
    if (courses.length === 0) return [];

    const promises = courses.map(async (course) => {
      try {
        const response = await classroom.courses.announcements.list({
          courseId: course.id,
          pageSize: 2
        });
        const announcements = response.data.announcements || [];
        return announcements.map(ann => ({
          ...ann,
          courseName: course.name
        }));
      } catch (e) {
        return [];
      }
    });

    const results = await Promise.all(promises);
    const allAnnouncements = results.flat();

    allAnnouncements.sort((a, b) => new Date(b.creationTime) - new Date(a.creationTime));
    return allAnnouncements;
  } catch (err) {
    console.error('[-] Error fetching Classroom announcements:', err.message);
    return [];
  }
}

async function handleGetClassroomCourses() {
  try {
    const courses = await getClassroomCourses();
    if (courses.length === 0) return { message: "No active Google Classroom courses found." };
    return courses.map(c => ({
      id: c.id,
      name: c.name,
      section: c.section,
      alternateLink: c.alternateLink
    }));
  } catch (err) {
    return { error: err.message };
  }
}

async function handleGetClassroomAssignments() {
  try {
    const assignments = await getClassroomAssignments();
    if (assignments.length === 0) return { message: "No pending or upcoming Google Classroom assignments found." };
    return assignments.map(a => {
      let dueStr = 'No due date';
      if (a.dueDate) {
        dueStr = `${a.dueDate.day}/${a.dueDate.month}/${a.dueDate.year}`;
        if (a.dueTime) {
          dueStr += ` at ${a.dueTime.hours || 0}:${a.dueTime.minutes || 0}`;
        }
      }
      return {
        course: a.courseName,
        title: a.title,
        description: a.description,
        dueDate: dueStr,
        alternateLink: a.alternateLink
      };
    });
  } catch (err) {
    return { error: err.message };
  }
}

async function handleGetClassroomAnnouncements() {
  try {
    const announcements = await getClassroomAnnouncements();
    if (announcements.length === 0) return { message: "No recent Google Classroom announcements found." };
    return announcements.map(a => ({
      course: a.courseName,
      text: a.text,
      creationTime: a.creationTime,
      alternateLink: a.alternateLink
    }));
  } catch (err) {
    return { error: err.message };
  }
}

// Classroom REST API routes
app.get('/api/classroom/status', (req, res) => {
  const clientId = process.env.CLASSROOM_CLIENT_ID;
  const clientSecret = process.env.CLASSROOM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({ connected: false, error: 'CREDENTIALS_MISSING' });
  }
  const hasTokens = fs.existsSync(classroomTokensPath);
  res.json({ connected: hasTokens });
});

app.get('/api/classroom/auth', (req, res) => {
  const oauth = getClassroomOAuth2Client();
  if (!oauth) {
    return res.status(400).send('Google Classroom credentials not configured in .env file.');
  }
  const scopes = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.announcements.readonly'
  ];
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
  res.redirect(authUrl);
});

app.get('/api/classroom/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No authorization code provided.');
  }
  const oauth = getClassroomOAuth2Client();
  if (!oauth) {
    return res.status(400).send('Google Classroom credentials not configured in .env.');
  }
  try {
    const { tokens } = await oauth.getToken(code);
    fs.writeFileSync(classroomTokensPath, JSON.stringify(tokens, null, 2));
    console.log('[+] Google Classroom authenticated successfully!');
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #121212; color: #ffffff;">
          <h2 style="color: #4caf50;">Authentication Successful!</h2>
          <p>Google Classroom has been connected to your WhatsApp Bot.</p>
          <p>You can close this window now.</p>
          <script>
            setTimeout(() => { window.close(); }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[-] Error during Google Classroom OAuth callback:', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/api/classroom/courses', checkPassword, async (req, res) => {
  try {
    const courses = await getClassroomCourses();
    res.json(courses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classroom/assignments', checkPassword, async (req, res) => {
  try {
    const assignments = await getClassroomAssignments();
    res.json(assignments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classroom/disconnect', checkPassword, async (req, res) => {
  try {
    if (fs.existsSync(classroomTokensPath)) {
      fs.unlinkSync(classroomTokensPath);
    }
    console.log('[+] Google Classroom disconnected successfully.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// REST API: Get all WhatsApp address book contacts (requires auth if DASHBOARD_PASSWORD set)
app.get('/api/wa/contacts', checkPassword, async (req, res) => {
  try {
    if (!client) {
      return res.status(503).json({ error: 'WhatsApp client not initialized' });
    }
    const contacts = await client.getContacts();
    const filtered = contacts
      .filter(c => !c.isGroup && c.id._serialized !== 'status@broadcast')
      .map(c => ({
        id: c.id._serialized,
        name: c.name || c.pushname || c.number,
        phone: c.number
      }));
    res.json(filtered);
  } catch (err) {
    console.error('[-] Error fetching WhatsApp contacts:', err.message);
    res.status(500).json({ error: err.message });
  }
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
