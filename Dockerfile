# Use the official lightweight Node.js image
FROM node:20-slim

# Install system dependencies required for Chromium/Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Skip downloading Chrome during npm install and point Puppeteer to the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_PATH=/usr/bin/chromium

# Create and define the application directory
WORKDIR /usr/src/app

# Copy dependency definitions and install packages
COPY package*.json ./
RUN npm install --only=production

# Copy the rest of the application files
COPY . .

# Expose the port defined by Express (default: 7860)
EXPOSE 7860

# Command to execute the bot
CMD ["npm", "start"]
