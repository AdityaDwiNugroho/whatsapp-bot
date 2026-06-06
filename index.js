import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcodeTerminal from 'qrcode-terminal';
import express from 'express';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 7860;

let botStatus = 'Initializing...';
let latestQrCode = null;

// Initialize WhatsApp Client with specific flags for containerized cloud deployment
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth' // Stores session locally in the persistent directory
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || null, // Render container will provide Chromium path here
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
  
  console.log('\n[+] QR Code generated! You can scan it in the terminal or open the Web URL to view it:');
  qrcodeTerminal.generate(qr, { small: true });
});

// Event: Authenticated successfully
client.on('authenticated', () => {
  botStatus = 'Authenticated!';
  latestQrCode = null;
  console.log('[+] Authenticated successfully!');
});

// Event: Ready (connected to WhatsApp Web)
client.on('ready', () => {
  botStatus = 'Connected & Running!';
  latestQrCode = null;
  console.log('\n=========================================');
  console.log('   🤖 WHATSAPP AUTOMATION BOT IS READY!   ');
  console.log('=========================================');
});

// Event: Handling incoming messages in real-time
client.on('message', async (msg) => {
  const chat = await msg.getChat();
  if (chat.isGroup) return; // Skip groups

  console.log(`📬 [NEW MESSAGE] from ${chat.name}: "${msg.body}"`);

  // Example automated replies
  if (msg.body.toLowerCase() === 'ping') {
    await msg.reply('pong 🏓');
  }

  const greetings = ['halo', 'hi', 'hey', 'p', 'tes', 'test'];
  if (greetings.includes(msg.body.toLowerCase())) {
    await msg.reply('Halo! Saya adalah asisten bot WhatsApp yang sedang aktif. Silakan tinggalkan pesan Anda! 🤖');
  }
});

// Express Endpoint: Home page showing bot connection status
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp Bot Status</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding-top: 50px; background-color: #f4f7f6; }
          .status { font-size: 24px; font-weight: bold; margin-bottom: 20px; }
          .connected { color: #2ecc71; }
          .pending { color: #f39c12; }
          .btn { display: inline-block; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>WhatsApp Bot Control Center</h1>
        <div class="status">Status: 
          <span class="${botStatus.includes('Connected') ? 'connected' : 'pending'}">${botStatus}</span>
        </div>
        ${latestQrCode ? '<a href="/qr" class="btn">View QR Code</a>' : '<p>Bot is linked. No QR code needed.</p>'}
      </body>
    </html>
  `);
});

// Express Endpoint: Renders the active QR code as an image
app.get('/qr', async (req, res) => {
  if (!latestQrCode) {
    return res.send('<h3>No QR code available. Bot is already logged in or initializing.</h3><a href="/">Go Home</a>');
  }

  try {
    const qrImage = await QRCode.toDataURL(latestQrCode);
    res.send(`
      <html>
        <head>
          <title>Scan WhatsApp QR Code</title>
          <meta http-equiv="refresh" content="15"> <!-- Refresh every 15 seconds to fetch new QR updates -->
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding-top: 40px; background-color: #f4f7f6; }
            img { border: 2px solid #ddd; padding: 10px; background: white; border-radius: 10px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>Scan QR Code with your Phone</h1>
          <p>Settings > Linked Devices > Link a Device</p>
          <img src="${qrImage}" alt="WhatsApp QR Code" />
          <p><i>This page will auto-refresh to update the QR code.</i></p>
          <br><a href="/">Go Back Home</a>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR code');
  }
});

// Start Express Web Server
app.listen(PORT, () => {
  console.log(`[+] Web status panel is running at http://localhost:${PORT}`);
});

// Start WhatsApp Client
console.log('[+] Initializing WhatsApp client...');
client.initialize();
