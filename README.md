---
title: Cloud Whatsapp Bot
emoji: robot
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Upgraded Cloud-Ready WhatsApp Bot and Dashboard

This is a containerized WhatsApp automation assistant and interactive web client. It combines a headless whatsapp-web.js client with a dark-theme, glassmorphic dashboard. It allows you to check chat history, send messages directly from the browser, and manage automated keywords--running 24/7 in the cloud so you do not have to leave your laptop open.

---

## Features

- **24/7 Headless WhatsApp Client:** Runs in Docker using Chromium/Puppeteer.
- **Glassmorphic Web Dashboard:** Highly responsive, dark-mode styling with status indicators and stats.
- **Persistent Sessions (Scan Once):** All security credentials, authentication keys, and cookies are stored in a persistent directory (.wwebjs_auth). You only need to scan the QR code once.
- **History Logger:** Saves and displays message streams (incoming and outgoing) in a local messages_history.json file.
- **Interactive Messaging:** Send messages directly to new or existing numbers from the web client.
- **Keyword Auto-Replies:** Manage custom keyword match triggers and auto-responses dynamically.
- **Lightweight Security:** Set the DASHBOARD_PASSWORD environment variable to block unauthorized dashboard access.
- **Local Audio Alerts:** Play sound notifications when new messages arrive.

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
