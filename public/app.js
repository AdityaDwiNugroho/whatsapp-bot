// Global Frontend State
let botStatus = 'Initializing...';
let isAuthenticated = false;
let qrPending = false;
let selectedChatId = null;
let messagesCache = [];
let groupedChats = [];
let autoReplies = [];
let totalMessageCount = 0;
let dashboardPassword = localStorage.getItem('dashboard_password') || '';
let selectedFile = null; // Staged file attachment

// DOM Elements
const passwordModal = document.getElementById('passwordModal');
const dashboardPasswordInput = document.getElementById('dashboardPasswordInput');
const submitPasswordBtn = document.getElementById('submitPasswordBtn');
const passwordError = document.getElementById('passwordError');

const newChatModal = document.getElementById('newChatModal');
const newChatNumberInput = document.getElementById('newChatNumberInput');
const startChatBtn = document.getElementById('startChatBtn');
const openNewChatBtn = document.getElementById('openNewChatBtn');
const closeNewChatBtn = document.getElementById('closeNewChatBtn');

const botStatusDot = document.getElementById('botStatusDot');
const botStatusText = document.getElementById('botStatusText');
const loggedInUserInfo = document.getElementById('loggedInUserInfo');
const userPushname = document.getElementById('userPushname');
const userPhone = document.getElementById('userPhone');

const chatSearchInput = document.getElementById('chatSearchInput');
const chatsListContainer = document.getElementById('chatsListContainer');

const qrPanel = document.getElementById('qrPanel');
const qrCodeImg = document.getElementById('qrCodeImg');
const qrLoadingSpinner = document.getElementById('qrLoadingSpinner');

const chatThreadView = document.getElementById('chatThreadView');
const activeChatAvatar = document.getElementById('activeChatAvatar');
const activeChatName = document.getElementById('activeChatName');
const activeChatNumber = document.getElementById('activeChatNumber');
const closeChatBtn = document.getElementById('closeChatBtn');
const messagesScroller = document.getElementById('messagesScroller');
const messageTextInput = document.getElementById('messageTextInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');

// Staged file attachment elements
const attachFileBtn = document.getElementById('attachFileBtn');
const fileAttachmentInput = document.getElementById('fileAttachmentInput');
const attachmentBadge = document.getElementById('attachmentBadge');
const attachmentName = document.getElementById('attachmentName');
const cancelAttachmentBtn = document.getElementById('cancelAttachmentBtn');

const overviewView = document.getElementById('overviewView');
const autoRepliesView = document.getElementById('autoRepliesView');
const navDashboardBtn = document.getElementById('navDashboardBtn');
const navAutoReplyBtn = document.getElementById('navAutoReplyBtn');

const statTotalMessages = document.getElementById('statTotalMessages');
const statAutoReplies = document.getElementById('statAutoReplies');
const statStatus = document.getElementById('statStatus');

const rulesListContainer = document.getElementById('rulesListContainer');
const addRuleForm = document.getElementById('addRuleForm');
const ruleTriggerInput = document.getElementById('ruleTriggerInput');
const ruleResponseInput = document.getElementById('ruleResponseInput');
const alertSound = document.getElementById('alertSound');

// --- Helper functions ---

// Safe fetch wrapper that automatically appends x-password header
async function apiRequest(url, options = {}) {
  options.headers = options.headers || {};
  if (dashboardPassword) {
    options.headers['x-password'] = dashboardPassword;
  }
  
  const response = await fetch(url, options);
  
  if (response.status === 401) {
    showPasswordModal();
    throw new Error('Unauthorized');
  }
  
  return response;
}

// Show/Hide Password Modal
function showPasswordModal() {
  passwordModal.classList.remove('hidden');
}

submitPasswordBtn.addEventListener('click', () => {
  const pwd = dashboardPasswordInput.value.trim();
  if (pwd) {
    dashboardPassword = pwd;
    localStorage.setItem('dashboard_password', pwd);
    passwordModal.classList.add('hidden');
    passwordError.classList.add('hidden');
    // Reload state after entering password
    init();
  }
});

// Show/Hide New Chat modal
openNewChatBtn.addEventListener('click', () => {
  newChatModal.classList.remove('hidden');
  newChatNumberInput.focus();
});

closeNewChatBtn.addEventListener('click', () => {
  newChatModal.classList.add('hidden');
  newChatNumberInput.value = '';
});

// Navigation logic between overview/auto-replies
navDashboardBtn.addEventListener('click', () => {
  navDashboardBtn.classList.add('active');
  navAutoReplyBtn.classList.remove('active');
  overviewView.classList.remove('hidden');
  autoRepliesView.classList.add('hidden');
  
  // Close chat thread when going back to dashboard overview
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
});

navAutoReplyBtn.addEventListener('click', () => {
  navAutoReplyBtn.classList.add('active');
  navDashboardBtn.classList.remove('active');
  autoRepliesView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  
  // Close chat thread when going to auto reply settings
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
  fetchReplies();
});

// Format initials for avatar display
function getInitials(name) {
  if (!name) return 'WA';
  const cleanName = name.replace(/[^\w\s]/gi, '').trim();
  const parts = cleanName.split(/\s+/);
  if (parts.length === 1 || parts[0] === '') {
    return name.substring(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Consistent background gradient based on name hash
function getAvatarGradient(name) {
  const hues = [140, 165, 195, 215, 235, 275, 305, 335];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash % hues.length);
  const hue = hues[index];
  return `linear-gradient(135deg, hsl(${hue}, 70%, 42%), hsl(${hue + 35}, 75%, 52%))`;
}

// Format message timestamp display (HH:MM)
function formatTime(timestampStr) {
  if (!timestampStr) return '';
  const parts = timestampStr.split(' ');
  return parts.length > 1 ? parts[1].substring(0, 5) : timestampStr;
}

// --- Attachment Handlers ---

// Click trigger for file input
attachFileBtn.addEventListener('click', () => {
  fileAttachmentInput.click();
});

// Handle staging selected file
fileAttachmentInput.addEventListener('change', () => {
  const file = fileAttachmentInput.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    selectedFile = {
      name: file.name,
      data: e.target.result // base64 Data URL
    };
    attachmentName.textContent = file.name;
    attachmentBadge.classList.remove('hidden');
    messageTextInput.focus();
  };
  reader.readAsDataURL(file);
});

// Cancel staged file
function resetStagedFile() {
  selectedFile = null;
  fileAttachmentInput.value = '';
  attachmentBadge.classList.add('hidden');
}

cancelAttachmentBtn.addEventListener('click', resetStagedFile);

// --- Main API integrations ---

// Start new chat session
startChatBtn.addEventListener('click', () => {
  let num = newChatNumberInput.value.trim();
  if (!num) return;
  
  // Basic formatting on frontend
  num = num.replace(/[^\d+]/g, ''); // strip spaces/chars except digits and +
  if (num.startsWith('+')) {
    num = num.slice(1);
  }
  if (num.startsWith('0')) {
    num = '62' + num.slice(1); // Default country code 62 (Indonesian) if starting with 0
  }
  
  const formattedId = num.endsWith('@c.us') ? num : num + '@c.us';
  
  // Set active chat JID
  selectedChatId = formattedId;
  newChatModal.classList.add('hidden');
  newChatNumberInput.value = '';
  resetStagedFile();
  
  // Show chat thread area
  chatThreadView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  
  // Populate blank layout or history if exists
  activeChatName.textContent = num;
  activeChatNumber.textContent = formattedId;
  activeChatAvatar.textContent = getInitials(num);
  activeChatAvatar.style.background = getAvatarGradient(num);
  
  renderChatThread();
  renderChatList();
});

// Close chat thread
closeChatBtn.addEventListener('click', () => {
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  
  // Fallback to overview or auto reply depending on active navigation tab
  if (navDashboardBtn.classList.contains('active')) {
    overviewView.classList.remove('hidden');
  } else {
    autoRepliesView.classList.remove('hidden');
  }
  renderChatList();
});

// Send message click / keyboard
async function sendMessage() {
  const text = messageTextInput.value.trim();
  if (!text && !selectedFile) return;
  if (!selectedChatId) return;
  
  try {
    messageTextInput.disabled = true;
    sendMessageBtn.disabled = true;
    attachFileBtn.disabled = true;
    
    const payload = {
      contact: selectedChatId,
      message: text
    };
    
    if (selectedFile) {
      payload.filename = selectedFile.name;
      payload.fileData = selectedFile.data;
    }
    
    const response = await apiRequest('/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    if (data.success) {
      messageTextInput.value = '';
      resetStagedFile();
      // Quick fetch to update chat logs
      fetchMessages();
    } else {
      alert('Failed to send: ' + data.error);
    }
  } catch (err) {
    console.error('Send error:', err);
  } finally {
    messageTextInput.disabled = false;
    sendMessageBtn.disabled = false;
    attachFileBtn.disabled = false;
    messageTextInput.focus();
  }
}

sendMessageBtn.addEventListener('click', sendMessage);
messageTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

// Group messages by contact threads
function processMessages(messages) {
  const groups = {};
  messages.forEach(msg => {
    const cid = msg.chatId;
    if (!groups[cid]) {
      groups[cid] = {
        chatId: cid,
        chatName: msg.chatName || cid.split('@')[0],
        messages: [],
        latestMessage: msg.message,
        latestTimestamp: msg.timestamp,
        latestFromMe: msg.fromMe
      };
    }
    groups[cid].messages.push(msg);
    if (msg.timestamp > groups[cid].latestTimestamp) {
      groups[cid].latestMessage = msg.message;
      groups[cid].latestTimestamp = msg.timestamp;
      groups[cid].latestFromMe = msg.fromMe;
    }
  });
  
  // Sort threads (newest message first)
  return Object.values(groups).sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp));
}

// Render the sidebar chat list
function renderChatList() {
  const query = chatSearchInput.value.toLowerCase().trim();
  
  const filtered = groupedChats.filter(chat => {
    if (!query) return true;
    return chat.chatName.toLowerCase().includes(query) || 
           chat.chatId.includes(query) || 
           chat.messages.some(m => m.message.toLowerCase().includes(query));
  });
  
  if (filtered.length === 0) {
    chatsListContainer.innerHTML = '<div class="empty-state-sidebar">No active chats</div>';
    return;
  }
  
  chatsListContainer.innerHTML = filtered.map(chat => {
    const initials = getInitials(chat.chatName);
    const bgGradient = getAvatarGradient(chat.chatName);
    const activeClass = selectedChatId === chat.chatId ? 'active' : '';
    const displayTime = formatTime(chat.latestTimestamp);
    
    // Prefix if sent by me
    const previewPrefix = chat.latestFromMe ? 'Anda: ' : '';
    
    return `
      <div class="chat-item ${activeClass}" onclick="selectChat('${chat.chatId}')">
        <div class="chat-item-avatar" style="background: ${bgGradient}">${initials}</div>
        <div class="chat-item-details">
          <div class="chat-item-row">
            <span class="chat-item-name" title="${chat.chatName}">${chat.chatName}</span>
            <span class="chat-item-time">${displayTime}</span>
          </div>
          <div class="chat-item-preview" title="${chat.latestMessage}">
            ${previewPrefix}${chat.latestMessage}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.selectChat = function(chatId) {
  selectedChatId = chatId;
  resetStagedFile();
  
  // Swap UI panes
  chatThreadView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  
  const chatObj = groupedChats.find(c => c.chatId === chatId);
  if (chatObj) {
    activeChatName.textContent = chatObj.chatName;
    activeChatNumber.textContent = chatId;
    activeChatAvatar.textContent = getInitials(chatObj.chatName);
    activeChatAvatar.style.background = getAvatarGradient(chatObj.chatName);
  }
  
  renderChatThread();
  renderChatList();
};

// Render message log bubbles chronologically
function renderChatThread() {
  if (!selectedChatId) return;
  
  const chatObj = groupedChats.find(c => c.chatId === selectedChatId);
  if (!chatObj) {
    messagesScroller.innerHTML = '<div class="empty-state-sidebar">No messages in thread. Send a message to start!</div>';
    return;
  }
  
  // Sort oldest message first (read top-to-bottom)
  const sorted = [...chatObj.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  const isAtBottom = messagesScroller.scrollHeight - messagesScroller.scrollTop - messagesScroller.clientHeight < 50;
  
  messagesScroller.innerHTML = sorted.map(msg => {
    const directionClass = msg.fromMe ? 'outgoing' : 'incoming';
    const tagHtml = msg.isAutoReply ? '<span class="autoreply-tag">Auto Reply</span>' : '';
    const formattedBody = msg.message.replace(/\n/g, '<br>');
    
    return `
      <div class="bubble-row ${directionClass}">
        <div class="message-bubble">
          <div class="bubble-text">${formattedBody}</div>
          <div class="bubble-footer">
            <span class="bubble-time">${formatTime(msg.timestamp)}</span>
            ${tagHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Auto scroll to bottom on new messages
  if (isAtBottom || sorted.length > 0) {
    setTimeout(() => {
      messagesScroller.scrollTop = messagesScroller.scrollHeight;
    }, 50);
  }
}

chatSearchInput.addEventListener('input', renderChatList);

// Fetch messages history
async function fetchMessages() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/messages');
    const messages = await response.json();
    
    // Play sound chiming on new incoming message if count changes
    const newIncMessagesCount = messages.filter(m => !m.fromMe).length;
    const oldIncMessagesCount = messagesCache.filter(m => !m.fromMe).length;
    if (newIncMessagesCount > oldIncMessagesCount && messagesCache.length > 0) {
      alertSound.play().catch(() => {});
    }
    
    messagesCache = messages;
    groupedChats = processMessages(messagesCache);
    
    // Stats Update
    statTotalMessages.textContent = messages.length;
    
    renderChatList();
    renderChatThread();
  } catch (err) {
    console.error('Fetch messages error:', err);
  }
}

// Fetch Auto Replies
async function fetchReplies() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/replies');
    autoReplies = await response.json();
    statAutoReplies.textContent = autoReplies.length;
    renderRepliesList();
  } catch (err) {
    console.error('Fetch replies error:', err);
  }
}

// Render active rules list
function renderRepliesList() {
  if (autoReplies.length === 0) {
    rulesListContainer.innerHTML = '<p class="empty-state-sidebar">No custom auto replies saved.</p>';
    return;
  }
  
  rulesListContainer.innerHTML = autoReplies.map(rule => {
    return `
      <div class="rule-item">
        <div class="rule-item-content">
          <span class="rule-trigger">${escapeHtml(rule.trigger)}</span>
          <span class="rule-response" title="${escapeHtml(rule.response)}">${escapeHtml(rule.response)}</span>
        </div>
        <button class="delete-rule-btn" onclick="deleteRule('${escapeHtml(rule.trigger).replace(/'/g, "\\'")}')" title="Delete Rule">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </div>
    `;
  }).join('');
}

// Escape html tags helper
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Add Auto reply submit handler
addRuleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const trigger = ruleTriggerInput.value.trim();
  const response = ruleResponseInput.value.trim();
  
  if (!trigger || !response) return;
  
  try {
    const res = await apiRequest('/api/replies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trigger, response })
    });
    
    const data = await res.json();
    if (data.success) {
      ruleTriggerInput.value = '';
      ruleResponseInput.value = '';
      fetchReplies();
    } else {
      alert('Failed to save rule: ' + data.error);
    }
  } catch (err) {
    console.error('Save rule error:', err);
  }
});

// Delete Auto Reply Rule
window.deleteRule = async function(trigger) {
  if (!confirm(`Are you sure you want to delete the auto-reply for "${trigger}"?`)) return;
  
  try {
    const res = await apiRequest('/api/replies', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trigger })
    });
    
    const data = await res.json();
    if (data.success) {
      fetchReplies();
    } else {
      alert('Delete failed: ' + data.error);
    }
  } catch (err) {
    console.error('Delete rule error:', err);
  }
};

// Check client connectivity status
async function checkStatus() {
  try {
    const response = await apiRequest('/api/status');
    const data = await response.json();
    
    botStatus = data.status;
    isAuthenticated = data.authenticated;
    qrPending = data.qrPending;
    
    // Update top header status indicator
    botStatusText.textContent = botStatus;
    
    if (isAuthenticated) {
      botStatusDot.className = 'status-dot pulse-green';
      statStatus.textContent = 'Online';
      
      // User data show
      if (data.phone) {
        loggedInUserInfo.classList.remove('hidden');
        userPushname.textContent = data.pushname || 'Connected';
        userPhone.textContent = `+${data.phone}`;
      } else {
        loggedInUserInfo.classList.add('hidden');
      }
      
      // Ensure QR Code panel is closed
      qrPanel.classList.add('hidden');
      
      // Load list history
      fetchMessages();
    } else if (qrPending) {
      botStatusDot.className = 'status-dot pulse-orange';
      statStatus.textContent = 'Authentication Pending';
      loggedInUserInfo.classList.add('hidden');
      
      // Force display QR Code screen
      qrPanel.classList.remove('hidden');
      chatThreadView.classList.add('hidden');
      
      // Load current QR image
      fetchQrCode();
    } else {
      botStatusDot.className = 'status-dot pulse-red';
      statStatus.textContent = 'Disconnected';
      loggedInUserInfo.classList.add('hidden');
    }
  } catch (err) {
    console.error('Check status error:', err);
    botStatusDot.className = 'status-dot pulse-red';
    botStatusText.textContent = 'Network Disconnect';
  }
}

// Fetch QR Code image URL
let isQrLoading = false;
async function fetchQrCode() {
  if (isQrLoading) return;
  try {
    isQrLoading = true;
    qrLoadingSpinner.classList.remove('hidden');
    
    const response = await apiRequest('/api/qr');
    const data = await response.json();
    
    if (data.qr) {
      qrCodeImg.src = data.qr;
      qrCodeImg.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Fetch QR error:', err);
  } finally {
    qrLoadingSpinner.classList.add('hidden');
    isQrLoading = false;
  }
}

// Initialize Loop
async function init() {
  await checkStatus();
  
  if (isAuthenticated) {
    await fetchReplies();
  }
}

// Initial start
init();

// Interval loops
setInterval(checkStatus, 3000);   // Poll connectivity and active messages every 3s
setInterval(fetchReplies, 10000); // Sync auto replies every 10s
