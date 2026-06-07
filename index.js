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

// Custom RemoteAuth class to bypass unzipper extraction failures
class CustomRemoteAuth extends RemoteAuth {
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

// Memory storage
let botStatus = 'Initializing...';
let latestQrCode = null;
let messagesHistory = [];
let autoReplies = [];
let botSettings = {
  aiEnabled: false,
  systemPrompt: "You are a helpful personal assistant representing the account owner. Reply in a friendly, concise, and natural tone. Do not use any emojis under any circumstances."
};

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

// Puppeteer configuration (custom User Agent to bypass bot detection)
function getPuppeteerConfig() {
  return {
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
      '--disable-gpu',
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
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
  client.on('ready', () => {
    botStatus = 'Connected & Running!';
    latestQrCode = null;
    console.log('\n=========================================');
    console.log('   WHATSAPP AUTOMATION BOT IS READY!     ');
    console.log('=========================================');

    // Trigger an immediate remote session backup in 10 seconds to ensure the session is saved to MongoDB
    if (client.authStrategy instanceof RemoteAuth) {
      console.log('[+] Triggering immediate session backup to MongoDB in 10 seconds...');
      setTimeout(async () => {
        try {
          await client.authStrategy.storeRemoteSession({ emit: true });
          console.log('[+] Session successfully saved to MongoDB database (immediate trigger).');
        } catch (err) {
          console.error('[-] Error during immediate session backup:', err.message);
        }
      }, 10000);
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
      const chat = await msg.getChat();
      if (chat.isGroup) return; // Skip group chats

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

      const timestampStr = new Date(msg.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);

      // Detect if this outgoing message is an auto-reply response
      const isAutoReply = msg.fromMe && (
        autoReplies.some(r => r.response === msg.body) ||
        (botSettings.aiEnabled && msg.body.includes('[AI]')) // flag if it was an AI response
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

                // Prepend [AI] tag to distinguish AI responses from manual replies
                const responseText = `[AI] ${cleanText}`;
                await msg.reply(responseText);
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
    hasGeminiKey: process.env.GEMINI_API_KEY ? true : false
  });
});

app.post('/api/settings', checkPassword, (req, res) => {
  const { aiEnabled, systemPrompt } = req.body;
  
  if (aiEnabled !== undefined) {
    botSettings.aiEnabled = !!aiEnabled;
  }
  if (systemPrompt !== undefined) {
    botSettings.systemPrompt = systemPrompt.trim();
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
});
