---
title: Cloud Whatsapp Bot
emoji: 🤖
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Cloud-Ready WhatsApp Automation Bot & Web Control Panel

This is a containerized WhatsApp automation assistant and interactive web client. It combines a headless whatsapp-web.js client with a dark-theme, glassmorphic dashboard. It allows you to check chat history, send messages directly from the browser, manage automated keywords, and connect with Google Classroom—running 24/7 in the cloud so you do not have to leave your laptop open.

---

## Features

- **24/7 Headless WhatsApp Client:** Runs in Docker using Chromium/Puppeteer.
- **Glassmorphic Web Dashboard:** Highly responsive, dark-mode styling with status indicators, statistics, and a settings console.
- **Gemini 3.5 AI Assistant:** Auto-replies dynamically to messages when enabled. It features a dual-persona system that automatically responds formally to lecturers/teachers and casually to friends.
- **Google Classroom Integration:** Authenticate with your Google account to query active courses, coursework/assignments, and announcements directly via WhatsApp.
- **Smart Reply Filtering:** Automatically checks if you have already replied manually or if the bot has already answered, preventing redundant or out-of-order auto-replies.
- **Persistent Sessions (Scan Once):** All credentials, authentication keys, and cookies are stored in a persistent directory (`.wwebjs_auth`). You only need to scan the QR code once.
- **History Logger:** Saves and displays message streams (incoming and outgoing) in a local JSON database.
- **Interactive Messaging:** Send messages directly to new or existing numbers from the web client.
- **Keyword Auto-Replies:** Manage custom keyword match triggers and auto-responses dynamically.
- **Lightweight Security:** Set the `DASHBOARD_PASSWORD` environment variable to block unauthorized dashboard access.
- **Local Audio Alerts:** Play sound notifications when new messages arrive.
- **PC Remote Control (Secure Connector):** Execute terminal commands on your local PC or take a screenshot directly by texting your bot.

---

## Running Locally

### 1. Install Dependencies
Make sure you have Node.js 18+ installed on your system. Run:
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
Open http://localhost:7860 in your web browser. You will see a QR code. Open WhatsApp on your phone, go to Settings > Linked Devices > Link a Device, and scan the QR code on your screen.

---

## 24/7 Cloud Hosting Guide

To run this bot 24/7 without keeping your laptop open, you can deploy it to the cloud.

### Method A: Hugging Face Spaces (Recommended - Free 24/7)

Hugging Face Spaces allows you to deploy Docker containers for free.

1. **Create Space:** Log in to Hugging Face, click on New Space.
2. **Settings:**
   - Name: my-whatsapp-bot
   - License: mit (or any)
   - SDK: Select Docker (Blank template).
   - Visibility: Select Private (Crucial so other people cannot scan your QR code or read your messages).
3. **Upload Files:** Clone the Space repository locally or upload these files directly via the browser:
   - index.js
   - Dockerfile
   - package.json
   - pc-connector.py
   - public/index.html
   - public/style.css
   - public/app.js
4. **Deploy & Scan:** Once the Space builds, visit the Space app URL. A QR code will display. Scan it with your phone. 
5. **How Session is Persisted:** Because of the LocalAuth setup in index.js, the login credentials are saved in the .wwebjs_auth folder in the container's scratch directory. The container will remain logged in. (Note: Hugging Face Spaces may restart occasionally. Standard free spaces sleep after 48 hours of inactivity. To prevent sleeping, you can set up a free uptime monitor pinging the app or upgrade to a persistent hardware tier).

---

### Method B: Deploying on a VPS (Virtual Private Server)

If you own a cheap Linux VPS (like DigitalOcean, Linode, or Hetzner):

1. **Clone the folder** onto the server.
2. **Install Docker** and run:
   ```bash
   # Build the container
   docker build -t whatsapp-bot .
   
   # Run with volume mapping to persist login session across restarts
   docker run -d -p 7860:7860 -v $(pwd)/.wwebjs_auth:/usr/src/app/.wwebjs_auth --name wa-bot whatsapp-bot
   ```
3. Open http://your-vps-ip:7860, input password (if set), and scan the QR code once. The volume mount (-v) ensures that even if you rebuild or restart the container, the .wwebjs_auth directory persists, keeping the login active.

---

## Securing the Dashboard

If you host this app on a public URL, set the DASHBOARD_PASSWORD environment variable to secure it.

- **On Hugging Face:** Go to your Space Settings, scroll to Variables and secrets, click Add new secret, name it DASHBOARD_PASSWORD and set your password.
- **On a VPS / Docker:** Run with -e DASHBOARD_PASSWORD=my_secure_password.
- **In Local Dev:** Run DASHBOARD_PASSWORD=your_password npm start.

When this variable is set, the dashboard will prompt visitors for the password. The password is saved locally in the browser's localStorage for future requests.

---

## PC Remote Control Connector

You can control your local laptop remotely using WhatsApp by running the python connector script.

### 1. Configure the Script
Open `pc-connector.py` on your laptop and update:
- `HF_SPACE_URL`: Your Hugging Face Space URL (e.g. `https://itsyurtzy-whatsapp-bot.hf.space`).
- `DASHBOARD_PASSWORD`: The secret password you set in your Hugging Face space secrets.

### 2. Run the Script
Make sure Python is installed on your laptop, then run:
```bash
python pc-connector.py
```

### 3. Usage & Commands
From your own phone, open your WhatsApp chat with your bot (or text yourself if using your own number) and type:
- `/pc screenshot` - Takes a screenshot of your laptop screen and sends it back to you as an image.
- `/pc tasklist` - Lists running processes on your laptop.
- `/pc <any command>` - Executes the command in Command Prompt (cmd.exe) on your laptop and returns the console output.

### 4. Security Safeguards
- **Owner Verification:** The bot strictly checks the sender's WhatsApp JID before forwarding commands. Only you (the owner) can execute `/pc` commands. If anyone else sends a command to your bot, it is ignored.
- **Secret Encryption:** The connection between the script and the Space is encrypted and protected by the `DASHBOARD_PASSWORD`.

---

## Google Classroom Integration

You can integrate your Google Classroom account to let the bot fetch coursework/assignments, active courses, and recent announcements.

### 1. Enable Google Classroom API & Create Credentials
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Classroom API**.
3. Create an **OAuth Client ID** credential:
   - Application Type: **Web application**.
   - Authorized Redirect URI: `http://localhost:7860/api/classroom/callback`
4. Copy the generated **Client ID** and **Client Secret**.
5. In the **OAuth consent screen** settings, add your target school Gmail account as a **Test User**.

### 2. Configure Environment
Add your client credentials to your `.env` file:
```env
CLASSROOM_CLIENT_ID=your_client_id_here
CLASSROOM_CLIENT_SECRET=your_client_secret_here
```

### 3. Connect on the Dashboard
1. Run the bot (`npm start`) and visit `http://localhost:7860`.
2. Go to the **Auto Replies** tab.
3. Click **Connect Google Classroom** and authenticate with your school Google account.

### 4. Commands
Once connected, you can query Google Classroom via WhatsApp commands (owner only) or ask Gemini (available for both owner and contacts if enabled):
- `/classroom courses` (or `kelas`) - Lists active classes.
- `/classroom assignments` (or `tugas`) - Lists upcoming assignments.
- `/classroom announcements` (or `pengumuman`) - Lists recent class notifications.

