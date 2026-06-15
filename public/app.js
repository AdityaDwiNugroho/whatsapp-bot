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
let waContacts = []; // Cache for WhatsApp phonebook contacts
let isAuthInitialized = false;

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
const contactsView = document.getElementById('contactsView');
const timelineView = document.getElementById('timelineView');
const navDashboardBtn = document.getElementById('navDashboardBtn');
const navTimelineBtn = document.getElementById('navTimelineBtn');
const navAutoReplyBtn = document.getElementById('navAutoReplyBtn');
const navContactsBtn = document.getElementById('navContactsBtn');
const timelineFeedContainer = document.getElementById('timelineFeedContainer');

const statTotalMessages = document.getElementById('statTotalMessages');
const statAutoReplies = document.getElementById('statAutoReplies');
const statStatus = document.getElementById('statStatus');
const statPcStatus = document.getElementById('statPcStatus');

const rulesListContainer = document.getElementById('rulesListContainer');
const addRuleForm = document.getElementById('addRuleForm');
const ruleTriggerInput = document.getElementById('ruleTriggerInput');
const ruleResponseInput = document.getElementById('ruleResponseInput');

const contactsListContainer = document.getElementById('contactsListContainer');
const addContactForm = document.getElementById('addContactForm');
const contactPhoneInput = document.getElementById('contactPhoneInput');
const contactNameInput = document.getElementById('contactNameInput');
let savedContacts = [];
const alertSound = document.getElementById('alertSound');

// Gemini AI DOM Elements
const aiEnabledCheckbox = document.getElementById('aiEnabledCheckbox');
const aiKeyBadge = document.getElementById('aiKeyBadge');
const aiSystemPromptInput = document.getElementById('aiSystemPromptInput');
const saveAiSettingsBtn = document.getElementById('saveAiSettingsBtn');

// Google Classroom DOM Elements
const classroomStatusBadge = document.getElementById('classroomStatusBadge');
const classroomSetupAlert = document.getElementById('classroomSetupAlert');
const classroomConnectedContainer = document.getElementById('classroomConnectedContainer');
const classroomDisconnectedContainer = document.getElementById('classroomDisconnectedContainer');
const connectClassroomBtn = document.getElementById('connectClassroomBtn');
const disconnectClassroomBtn = document.getElementById('disconnectClassroomBtn');

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

// Navigation logic between overview/timeline/auto-replies/contacts
navDashboardBtn.addEventListener('click', () => {
  navDashboardBtn.classList.add('active');
  navTimelineBtn.classList.remove('active');
  navAutoReplyBtn.classList.remove('active');
  navContactsBtn.classList.remove('active');
  overviewView.classList.remove('hidden');
  timelineView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
  // Close chat thread when going back to dashboard overview
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
});

navTimelineBtn.addEventListener('click', () => {
  navTimelineBtn.classList.add('active');
  navDashboardBtn.classList.remove('active');
  navAutoReplyBtn.classList.remove('active');
  navContactsBtn.classList.remove('active');
  timelineView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
  // Close chat thread when going to timeline
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
  fetchStatuses();
});

navAutoReplyBtn.addEventListener('click', () => {
  navAutoReplyBtn.classList.add('active');
  navDashboardBtn.classList.remove('active');
  navTimelineBtn.classList.remove('active');
  navContactsBtn.classList.remove('active');
  autoRepliesView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  timelineView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
  // Close chat thread when going to auto reply settings
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
  fetchReplies();
  fetchSettings();
});

navContactsBtn.addEventListener('click', () => {
  navContactsBtn.classList.add('active');
  navDashboardBtn.classList.remove('active');
  navTimelineBtn.classList.remove('active');
  navAutoReplyBtn.classList.remove('active');
  contactsView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  timelineView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  
  // Close chat thread when going to contacts directory
  selectedChatId = null;
  resetStagedFile();
  chatThreadView.classList.add('hidden');
  renderChatList();
  fetchContacts();
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
  timelineView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
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
  
  // Fallback to active view panel depending on active navigation tab
  if (navDashboardBtn.classList.contains('active')) {
    overviewView.classList.remove('hidden');
  } else if (navTimelineBtn.classList.contains('active')) {
    timelineView.classList.remove('hidden');
  } else if (navAutoReplyBtn.classList.contains('active')) {
    autoRepliesView.classList.remove('hidden');
  } else if (navContactsBtn.classList.contains('active')) {
    contactsView.classList.remove('hidden');
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
  
  const filteredChats = groupedChats.filter(chat => {
    if (!query) return true;
    return chat.chatName.toLowerCase().includes(query) || 
           chat.chatId.includes(query) || 
           chat.messages.some(m => m.message.toLowerCase().includes(query));
  });
  
  let contactsHtml = '';
  if (query) {
    const activeChatIds = new Set(groupedChats.map(c => c.chatId));
    const filteredContacts = waContacts.filter(c => {
      if (activeChatIds.has(c.id)) return false;
      return c.name.toLowerCase().includes(query) || c.phone.includes(query);
    });
    
    if (filteredContacts.length > 0) {
      contactsHtml = `
        <div class="sidebar-section-title">WhatsApp Contacts</div>
        ${filteredContacts.slice(0, 15).map(c => {
          const initials = getInitials(c.name);
          const bgGradient = getAvatarGradient(c.name);
          return `
            <div class="chat-item" onclick="selectContact('${c.id}', '${escapeHtml(c.name).replace(/'/g, "\\'")}')">
              <div class="chat-item-avatar" style="background: ${bgGradient}">${initials}</div>
              <div class="chat-item-details">
                <div class="chat-item-row">
                  <span class="chat-item-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
                </div>
                <div class="chat-item-preview">
                  +${c.phone} (Address Book)
                </div>
              </div>
            </div>
          `;
        }).join('')}
      `;
    }
  }
  
  if (filteredChats.length === 0 && !contactsHtml) {
    chatsListContainer.innerHTML = '<div class="empty-state-sidebar">No active chats</div>';
    return;
  }
  
  let chatsHtml = filteredChats.map(chat => {
    const initials = getInitials(chat.chatName);
    const bgGradient = getAvatarGradient(chat.chatName);
    const activeClass = selectedChatId === chat.chatId ? 'active' : '';
    const displayTime = formatTime(chat.latestTimestamp);
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
  
  chatsListContainer.innerHTML = chatsHtml + contactsHtml;
}

window.selectChat = function(chatId) {
  selectedChatId = chatId;
  resetStagedFile();
  
  // Swap UI panes
  chatThreadView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  timelineView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
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

window.selectContact = function(contactId, contactName) {
  selectedChatId = contactId;
  resetStagedFile();
  
  // Swap UI panes
  chatThreadView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  timelineView.classList.add('hidden');
  autoRepliesView.classList.add('hidden');
  contactsView.classList.add('hidden');
  
  activeChatName.textContent = contactName;
  activeChatNumber.textContent = contactId;
  activeChatAvatar.textContent = getInitials(contactName);
  activeChatAvatar.style.background = getAvatarGradient(contactName);
  
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
    const deletedHtml = msg.isDeleted ? '<span class="deleted-tag">Dihapus</span>' : '';
    const formattedBody = msg.message.replace(/\n/g, '<br>');
    const bubbleClass = msg.isDeleted ? 'message-bubble deleted-message' : 'message-bubble';
    
    return `
      <div class="bubble-row ${directionClass}">
        <div class="${bubbleClass}">
          <div class="bubble-text">${formattedBody}</div>
          <div class="bubble-footer">
            <span class="bubble-time">${formatTime(msg.timestamp)}</span>
            ${tagHtml}
            ${deletedHtml}
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

chatSearchInput.addEventListener('input', () => {
  if (waContacts.length === 0 && isAuthenticated) {
    fetchWaContacts().then(() => renderChatList());
  }
  renderChatList();
});

// Fetch messages history
async function fetchMessages() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/messages');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const messages = await response.json();
    if (!Array.isArray(messages)) {
      throw new Error('Expected array of messages');
    }
    
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
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (Array.isArray(data)) {
      autoReplies = data;
    } else {
      autoReplies = [];
    }
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

// --- Custom Contacts Directory API integrations ---

async function fetchContacts() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/contacts');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (Array.isArray(data)) {
      savedContacts = data;
    } else {
      savedContacts = [];
    }
    renderContactsList();
  } catch (err) {
    console.error('Fetch contacts error:', err);
  }
}

function renderContactsList() {
  if (savedContacts.length === 0) {
    contactsListContainer.innerHTML = '<p class="empty-state-sidebar">No custom contacts saved.</p>';
    return;
  }
  
  contactsListContainer.innerHTML = savedContacts.map(contact => {
    return `
      <div class="rule-item">
        <div class="rule-item-content">
          <span class="rule-trigger">${escapeHtml(contact.name)}</span>
          <span class="rule-response">+${escapeHtml(contact.phone)}</span>
        </div>
        <button class="delete-rule-btn" onclick="deleteContact('${escapeHtml(contact.phone)}')" title="Delete Contact">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        </button>
      </div>
    `;
  }).join('');
}

addContactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = contactPhoneInput.value.trim();
  const name = contactNameInput.value.trim();
  
  if (!phone || !name) return;
  
  try {
    const res = await apiRequest('/api/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone, name })
    });
    
    const data = await res.json();
    if (data.success) {
      contactPhoneInput.value = '';
      contactNameInput.value = '';
      fetchContacts();
      fetchMessages(); // refresh sidebar list names
    } else {
      alert('Failed to save contact: ' + data.error);
    }
  } catch (err) {
    console.error('Save contact error:', err);
  }
});

window.deleteContact = async function(phone) {
  if (!confirm(`Are you sure you want to delete this custom contact?`)) return;
  
  try {
    const res = await apiRequest('/api/contacts', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone })
    });
    
    const data = await res.json();
    if (data.success) {
      fetchContacts();
      fetchMessages(); // refresh sidebar list names
    } else {
      alert('Delete failed: ' + data.error);
    }
  } catch (err) {
    console.error('Delete contact error:', err);
  }
};

// --- Gemini AI Settings Fetch & Save ---
async function fetchSettings() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/settings');
    const data = await response.json();
    
    aiEnabledCheckbox.checked = data.aiEnabled;
    aiSystemPromptInput.value = data.systemPrompt;
    
    if (data.hasGeminiKey) {
      aiKeyBadge.textContent = "Secret Key Active";
      aiKeyBadge.style.background = "rgba(37, 211, 102, 0.2)";
      aiKeyBadge.style.color = "var(--wa-green)";
      aiKeyBadge.style.borderColor = "rgba(37, 211, 102, 0.3)";
    } else {
      aiKeyBadge.textContent = "Secret Key Missing";
      aiKeyBadge.style.background = "rgba(239, 68, 110, 0.15)";
      aiKeyBadge.style.color = "#ef4444";
      aiKeyBadge.style.borderColor = "rgba(239, 68, 110, 0.25)";
    }
  } catch (err) {
    console.error('Fetch settings error:', err);
  }
}

async function saveSettings() {
  try {
    saveAiSettingsBtn.disabled = true;
    saveAiSettingsBtn.textContent = "Saving...";
    
    const response = await apiRequest('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        aiEnabled: aiEnabledCheckbox.checked,
        systemPrompt: aiSystemPromptInput.value.trim()
      })
    });
    
    const data = await response.json();
    if (data.success) {
      alert('AI Assistant settings saved successfully!');
    } else {
      alert('Failed to save settings: ' + data.error);
    }
  } catch (err) {
    console.error('Save settings error:', err);
    alert('Failed to save settings: ' + err.message);
  } finally {
    saveAiSettingsBtn.disabled = false;
    saveAiSettingsBtn.textContent = "Save AI Assistant Settings";
  }
}

saveAiSettingsBtn.addEventListener('click', saveSettings);

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
    
    // Update PC Status Indicator
    if (statPcStatus) {
      if (data.pcOnline) {
        statPcStatus.textContent = 'Online';
        statPcStatus.style.color = 'var(--wa-green)';
      } else {
        statPcStatus.textContent = 'Offline';
        statPcStatus.style.color = 'var(--text-muted)';
      }
    }

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

      if (!isAuthInitialized) {
        isAuthInitialized = true;
        fetchReplies();
        fetchSettings();
        fetchContacts();
        fetchWaContacts();
      }
    } else if (qrPending) {
      botStatusDot.className = 'status-dot pulse-orange';
      statStatus.textContent = 'Authentication Pending';
      loggedInUserInfo.classList.add('hidden');
      isAuthInitialized = false;
      
      // Force display QR Code screen
      qrPanel.classList.remove('hidden');
      chatThreadView.classList.add('hidden');
      
      // Load current QR image
      fetchQrCode();
    } else {
      botStatusDot.className = 'status-dot pulse-red';
      statStatus.textContent = 'Disconnected';
      loggedInUserInfo.classList.add('hidden');
      isAuthInitialized = false;
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

// Parse and format status relative publication time
function formatRelativeTime(timestampStr) {
  try {
    const parts = timestampStr.split(' ');
    const dateParts = parts[0].split('-');
    const timeParts = parts[1].split(':');
    
    const date = new Date(
      parseInt(dateParts[0]),
      parseInt(dateParts[1]) - 1,
      parseInt(dateParts[2]),
      parseInt(timeParts[0]),
      parseInt(timeParts[1]),
      parseInt(timeParts[2] || '0')
    );
    
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / (60 * 1000));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hours ago`;
    
    return 'Yesterday';
  } catch (err) {
    return timestampStr;
  }
}

// Fetch active statuses from server
async function fetchStatuses() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/statuses');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const statuses = await response.json();
    if (Array.isArray(statuses)) {
      renderStatuses(statuses);
    } else {
      throw new Error('Expected array of statuses');
    }
  } catch (err) {
    console.error('Fetch statuses error:', err);
  }
}

// Render status cards in Timeline feed
function renderStatuses(statuses) {
  if (statuses.length === 0) {
    timelineFeedContainer.innerHTML = '<div class="empty-state-timeline">No status updates yet.</div>';
    return;
  }
  
  // Sort status timeline chronologically: newest updates first
  const sorted = [...statuses].sort((a, b) => b.timestamp - a.timestamp);
  
  timelineFeedContainer.innerHTML = sorted.map(status => {
    const initials = getInitials(status.authorName);
    const bgGradient = getAvatarGradient(status.authorName);
    const relativeTime = formatRelativeTime(status.timestampStr);
    
    let contentHtml = '';
    if (status.mediaPath) {
      let mediaTag = '';
      if (status.mediaType === 'image') {
        mediaTag = `<img src="${status.mediaPath}" alt="Status Image">`;
      } else if (status.mediaType === 'video') {
        mediaTag = `<video src="${status.mediaPath}" controls preload="metadata"></video>`;
      } else if (status.mediaType === 'audio') {
        mediaTag = `<audio src="${status.mediaPath}" controls preload="metadata"></audio>`;
      } else {
        mediaTag = `<a href="${status.mediaPath}" target="_blank">View Status Media</a>`;
      }
      
      contentHtml = `
        <div class="status-media">${mediaTag}</div>
        ${status.message ? `<div class="status-caption">${escapeHtml(status.message)}</div>` : ''}
      `;
    } else {
      contentHtml = `
        <div class="status-text-only">${escapeHtml(status.message).replace(/\n/g, '<br>')}</div>
      `;
    }
    
    return `
      <div class="status-card" id="status-${status.id}">
        <div class="status-header">
          <div class="status-avatar" style="background: ${bgGradient}">${initials}</div>
          <div class="status-meta">
            <span class="status-author">${escapeHtml(status.authorName)}</span>
            <span class="status-time">${relativeTime}</span>
          </div>
        </div>
        <div class="status-content">
          ${contentHtml}
        </div>
      </div>
    `;
  }).join('');
}

// Fetch all WhatsApp address book contacts
async function fetchWaContacts() {
  if (!isAuthenticated) return;
  try {
    const response = await apiRequest('/api/wa/contacts');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (Array.isArray(data)) {
      waContacts = data;
    } else {
      console.error('Fetch WA contacts error: expected array, got', data);
      waContacts = [];
    }
  } catch (err) {
    console.error('Fetch WA contacts error:', err);
    waContacts = [];
  }
}

// Check Google Classroom status and update UI
async function checkClassroomStatus() {
  try {
    const response = await apiRequest('/api/classroom/status');
    const status = await response.json();

    if (status.error === 'CREDENTIALS_MISSING') {
      classroomStatusBadge.textContent = 'Setup Required';
      classroomStatusBadge.style.background = 'rgba(224, 86, 86, 0.2)';
      classroomStatusBadge.style.color = '#f28b82';
      classroomSetupAlert.style.display = 'block';
      classroomConnectedContainer.style.display = 'none';
      classroomDisconnectedContainer.style.display = 'none';
      return;
    }

    classroomSetupAlert.style.display = 'none';
    if (status.connected) {
      classroomStatusBadge.textContent = 'Connected';
      classroomStatusBadge.style.background = 'rgba(129, 199, 132, 0.2)';
      classroomStatusBadge.style.color = '#81c784';
      classroomConnectedContainer.style.display = 'flex';
      classroomDisconnectedContainer.style.display = 'none';
    } else {
      classroomStatusBadge.textContent = 'Disconnected';
      classroomStatusBadge.style.background = 'rgba(255, 255, 255, 0.05)';
      classroomStatusBadge.style.color = 'var(--text-muted)';
      classroomConnectedContainer.style.display = 'none';
      classroomDisconnectedContainer.style.display = 'block';
    }
  } catch (err) {
    console.error('Error checking Google Classroom status:', err);
  }
}

// Connect Google Classroom click handler
connectClassroomBtn.addEventListener('click', () => {
  const authUrl = `/api/classroom/auth`;
  window.open(authUrl, '_blank');
  
  const pollInterval = setInterval(async () => {
    await checkClassroomStatus();
    try {
      const response = await fetch('/api/classroom/status');
      const status = await response.json();
      if (status.connected) {
        clearInterval(pollInterval);
      }
    } catch (e) {
      clearInterval(pollInterval);
    }
  }, 2000);
});

// Disconnect Google Classroom click handler
disconnectClassroomBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to disconnect Google Classroom?')) {
    try {
      const response = await apiRequest('/api/classroom/disconnect');
      const result = await response.json();
      if (result.success) {
        checkClassroomStatus();
      }
    } catch (err) {
      console.error('Error disconnecting Classroom:', err);
    }
  }
});

// Initialize Loop
async function init() {
  await checkStatus();
  await checkClassroomStatus();
  
  if (isAuthenticated) {
    if (navTimelineBtn.classList.contains('active')) {
      await fetchStatuses();
    }
  }
}

// Initial start
init();

// Interval loops
setInterval(checkStatus, 3000);   // Poll connectivity and active messages every 3s
setInterval(fetchReplies, 10000); // Sync auto replies every 10s
setInterval(checkClassroomStatus, 30000); // Poll Classroom status every 30s
setInterval(() => {
  if (isAuthenticated && navTimelineBtn.classList.contains('active')) {
    fetchStatuses();
  }
}, 5000);                         // Poll statuses every 5s if on Timeline tab
