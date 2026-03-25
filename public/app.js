/* ─── app.js - 完整前端逻辑 ─── */
'use strict';

// ═══════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════
const state = {
  token: null, userId: null, username: null, color: null, avatar: null,
  currentRoomId: null,
  authReady: false,        // socket已通过认证
  rooms: new Map(),        // roomId -> roomData
  users: new Map(),        // userId -> userData
  typingTimers: new Map(), // roomId -> timer
  unread: new Map(),       // roomId -> count
  selectedGroupMembers: new Set(),
  isMobile: window.innerWidth <= 768
};

// 表情列表
const EMOJIS = ['😀','😂','🥰','😎','🤔','😢','😡','🤣','😍','🥳','👍','👎','❤️','🔥','✨','🎉','🙏','💪','🤝','👏','😄','🤗','😴','🤯','🥺','😤','🫡','🫶','💯','🚀','⚡','🌟','🎊','🎁','🍕','🎮','🏆','💎','🌈','🦋'];

let socket = null;

// ═══════════════════════════════════════════
// Socket.IO 初始化
// ═══════════════════════════════════════════
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => { if (state.token) socket.emit('auth', { token: state.token }); });

  socket.on('auth_ok', (data) => {
    state.userId = data.userId;
    state.username = data.username;
    state.color = data.color;
    state.avatar = data.avatar;
    state.authReady = true;
    updateMyHeader();
    loadRooms();
    // 预加载用户列表到 state
    socket.emit('get_users');
  });

  socket.on('auth_error', (msg) => showToast('认证失败: ' + msg));

  socket.on('message', (msg) => {
    const room = state.rooms.get(msg.roomId);
    if (!room) state.rooms.set(msg.roomId, { id: msg.roomId, name: msg.roomId, messages: [] });
    state.rooms.get(msg.roomId).messages = state.rooms.get(msg.roomId).messages || [];
    state.rooms.get(msg.roomId).messages.push(msg);

    if (msg.roomId === state.currentRoomId) {
      renderMessage(msg, true);
      scrollToBottom();
    } else {
      const count = (state.unread.get(msg.roomId) || 0) + 1;
      state.unread.set(msg.roomId, count);
      updateRoomPreview(msg.roomId, msg);
    }
    // 更新房间预览
    updateRoomPreview(msg.roomId, msg);
  });

  socket.on('history', ({ roomId, messages }) => {
    const room = state.rooms.get(roomId) || { id: roomId, messages: [] };
    room.messages = messages;
    state.rooms.set(roomId, room);
    if (roomId === state.currentRoomId) renderHistory(messages);
  });

  socket.on('online_users', (users) => {
    users.forEach(u => state.users.set(u.id, u));
    renderOnlineStatus();
  });

  socket.on('typing', ({ userId, username, isTyping, roomId }) => {
    if (roomId !== state.currentRoomId) return;
    const el = document.getElementById('typing-indicator');
    if (isTyping) {
      el.innerHTML = `<span>${username} 正在输入</span> <span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
      el.classList.remove('hidden');
      clearTimeout(state.typingTimers.get(roomId));
      state.typingTimers.set(roomId, setTimeout(() => el.classList.add('hidden'), 3000));
    } else {
      el.classList.add('hidden');
    }
  });

  socket.on('reaction_updated', ({ messageId, reactions }) => {
    const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!wrapper) return;
    renderReactions(wrapper, messageId, reactions);
  });

  socket.on('private_room_ready', ({ roomId, history, target }) => {
    const existRoom = state.rooms.get(roomId);
    const room = existRoom || { id: roomId, type: 'private', name: target.username, messages: [] };
    room.messages = history;
    state.rooms.set(roomId, room);
    closeModal('user-list-modal');
    openRoom(roomId, target.username, 'private');
    renderRoomList();
  });

  socket.on('new_private_room', ({ roomId, with: user }) => {
    if (!state.rooms.has(roomId)) {
      state.rooms.set(roomId, { id: roomId, type: 'private', name: user.username, messages: [] });
    }
    renderRoomList();
  });

  socket.on('group_created', ({ roomId, name }) => {
    if (!state.rooms.has(roomId)) {
      state.rooms.set(roomId, { id: roomId, type: 'group', name, messages: [] });
    }
    renderRoomList();
  });

  socket.on('users_list', (users) => {
    users.forEach(u => state.users.set(u.id, u));
    // 如果用户列表弹窗开着就刷新
    if (!document.getElementById('user-list-modal').classList.contains('hidden')) {
      renderUserModal([...state.users.values()].filter(u => u.id !== state.userId));
    }
    // 如果创建群组弹窗开着就刷新
    if (!document.getElementById('create-group-modal').classList.contains('hidden')) {
      renderGroupUserList([...state.users.values()].filter(u => u.id !== state.userId));
    }
  });
}

// ═══════════════════════════════════════════
// 认证
// ═══════════════════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', (i === 0) === (tab === 'login')));
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.getElementById('auth-error').classList.add('hidden');
}

async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { showAuthError('请输入用户名和密码'); return; }

  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError(data.error); return; }
    saveSession(data);
    enterChat();
  } catch (e) { showAuthError('网络错误，请重试'); }
}

async function register() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !password) { showAuthError('请填写所有字段'); return; }

  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError(data.error); return; }
    saveSession(data);
    enterChat();
    showToast('注册成功，欢迎 ' + username + '！');
  } catch (e) { showAuthError('网络错误，请重试'); }
}

function saveSession(data) {
  state.token = data.token; state.userId = data.userId;
  state.username = data.username; state.color = data.color; state.avatar = data.avatar;
  localStorage.setItem('chat_token', data.token);
  localStorage.setItem('chat_userId', data.userId);
  localStorage.setItem('chat_username', data.username);
  localStorage.setItem('chat_color', data.color);
  if (data.avatar) localStorage.setItem('chat_avatar', data.avatar);
}

function logout() {
  localStorage.clear();
  Object.assign(state, { token: null, userId: null, currentRoomId: null });
  state.rooms.clear(); state.users.clear();
  if (socket) socket.disconnect();
  showPage('auth-page');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.classList.remove('hidden');
}

// ═══════════════════════════════════════════
// 进入聊天
// ═══════════════════════════════════════════
function enterChat() {
  showPage('chat-page');
  updateMyHeader();
  initSocket();
  buildEmojiPicker();
}

function updateMyHeader() {
  document.getElementById('my-username').textContent = state.username;
  const av = document.getElementById('my-avatar');
  renderAvatarEl(av, state.username, state.color, state.avatar);
}

async function loadRooms() {
  try {
    const res = await fetch('/api/rooms', { headers: { Authorization: state.token } });
    const rooms = await res.json();
    rooms.forEach(r => {
      const existing = state.rooms.get(r.id);
      state.rooms.set(r.id, { ...r, messages: existing?.messages || [] });
    });
  } catch (e) { /* 忽略，使用公共大厅兜底 */ }

  // 确保公共大厅在列表中
  if (!state.rooms.has('public')) {
    state.rooms.set('public', { id: 'public', name: '🌍 公共大厅', type: 'group', messages: [] });
  }

  renderRoomList();
}

// ═══════════════════════════════════════════
// 房间列表渲染
// ═══════════════════════════════════════════
function renderRoomList(filter = '') {
  const container = document.getElementById('room-list');
  const items = [...state.rooms.values()].filter(r =>
    r.name?.toLowerCase().includes(filter.toLowerCase())
  );

  container.innerHTML = items.map(room => {
    const lastMsg = room.messages?.[room.messages.length - 1];
    const preview = lastMsg ? formatPreview(lastMsg) : '暂无消息';
    const timeStr = lastMsg ? formatTime(lastMsg.timestamp) : '';
    const unread = state.unread.get(room.id) || 0;
    const isActive = room.id === state.currentRoomId;
    const avatarHtml = buildRoomAvatarHtml(room);

    return `
      <div class="room-item ${isActive ? 'active' : ''}" onclick="openRoom('${room.id}', '${escHtml(room.name)}', '${room.type || 'group'}')">
        <div class="room-avatar">${avatarHtml}</div>
        <div class="room-info">
          <div class="room-name">${escHtml(room.name || room.id)}</div>
          <div class="room-preview">${escHtml(preview)}</div>
        </div>
        <div>
          <div class="room-time">${timeStr}</div>
          ${unread > 0 ? `<div class="unread-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function filterRooms(val) { renderRoomList(val); }

function buildRoomAvatarHtml(room) {
  const name = room.name || '?';
  const color = room.type === 'private'
    ? (getUserColor(room) || '#888')
    : '#07C160';
  return `<div class="avatar-wrap"><div class="avatar-circle" style="background:${color}">${name.slice(0,2)}</div></div>`;
}

function getUserColor(room) {
  if (!room.id.startsWith('private_')) return null;
  const parts = room.id.replace('private_', '').split('_');
  const otherId = parts.find(id => id !== state.userId);
  return state.users.get(otherId)?.color || '#888';
}

function formatPreview(msg) {
  if (msg.type === 'image') return '[图片]';
  if (msg.type === 'file') return '[文件] ' + (msg.fileName || '');
  return msg.content || '';
}

// ═══════════════════════════════════════════
// 打开聊天室
// ═══════════════════════════════════════════
function openRoom(roomId, roomName, type) {
  state.currentRoomId = roomId;
  state.unread.set(roomId, 0);

  document.getElementById('chat-room-name').textContent = roomName;

  const headerAvatar = document.getElementById('chat-header-avatar');
  const color = type === 'private' ? (getUserColor(state.rooms.get(roomId)) || '#888') : '#07C160';
  headerAvatar.innerHTML = `<div class="avatar-circle" style="background:${color}">${(roomName || '?').slice(0,2)}</div>`;

  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');

  // 手机端切换视图
  if (state.isMobile) {
    document.getElementById('sidebar').classList.add('hidden-mobile');
    document.getElementById('main-chat').classList.remove('hidden-mobile');
  }

  // 渲染历史消息
  const room = state.rooms.get(roomId);
  document.getElementById('messages-list').innerHTML = '';
  if (room?.messages?.length > 0) {
    renderHistory(room.messages);
  }

  updateRoomStatus(roomId, type);
  renderRoomList();
  renderMembersList(roomId);
}

function updateRoomStatus(roomId, type) {
  const statusEl = document.getElementById('chat-room-status');
  if (type === 'group') {
    const room = state.rooms.get(roomId);
    statusEl.textContent = `${room?.members?.length || '多'} 名成员`;
  } else {
    const parts = roomId.replace('private_', '').split('_');
    const otherId = parts.find(id => id !== state.userId);
    const other = state.users.get(otherId);
    statusEl.textContent = other?.online ? '● 在线' : '○ 离线';
    statusEl.style.color = other?.online ? '#07C160' : '#888';
  }
}

function backToSidebar() {
  if (state.isMobile) {
    document.getElementById('sidebar').classList.remove('hidden-mobile');
    document.getElementById('main-chat').classList.add('hidden-mobile');
  }
}

// ═══════════════════════════════════════════
// 消息渲染
// ═══════════════════════════════════════════
function renderHistory(messages) {
  const list = document.getElementById('messages-list');
  list.innerHTML = '';
  let lastDate = '';
  messages.forEach(msg => {
    const msgDate = new Date(msg.timestamp).toLocaleDateString('zh-CN');
    if (msgDate !== lastDate) {
      list.insertAdjacentHTML('beforeend', `<div class="date-divider"><span>${msgDate}</span></div>`);
      lastDate = msgDate;
    }
    list.insertAdjacentHTML('beforeend', buildMessageHtml(msg));
  });
  scrollToBottom(false);
}

function renderMessage(msg, animate = false) {
  const list = document.getElementById('messages-list');
  list.insertAdjacentHTML('beforeend', buildMessageHtml(msg, animate));
}

function buildMessageHtml(msg, animate = false) {
  const isMe = msg.senderId === state.userId;
  const time = formatTime(msg.timestamp);
  const avatarHtml = buildMsgAvatarHtml(msg);
  const bubbleContent = buildBubbleContent(msg);
  const reactionsHtml = buildReactionsHtml(msg.id, msg.reactions || {});
  const animClass = animate ? ' msg-animate' : '';

  return `
    <div class="msg-wrapper ${isMe ? 'me' : 'other'}${animClass}" data-msg-id="${msg.id}">
      ${!isMe ? `<div class="msg-avatar">${avatarHtml}</div>` : ''}
      <div class="msg-body">
        ${!isMe ? `<div class="msg-sender">${escHtml(msg.senderName)}</div>` : ''}
        <div class="msg-bubble" ondblclick="showReactionPicker('${msg.id}')" oncontextmenu="return false;">
          ${bubbleContent}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="msg-time">${time}</div>
          ${isMe ? '<div class="msg-status">✓✓</div>' : ''}
        </div>
        ${reactionsHtml}
      </div>
      ${isMe ? `<div class="msg-avatar">${avatarHtml}</div>` : ''}
    </div>
  `;
}

function buildMsgAvatarHtml(msg) {
  if (msg.senderAvatar) {
    return `<div class="avatar-circle sm"><img src="${msg.senderAvatar}" alt=""></div>`;
  }
  return `<div class="avatar-circle sm" style="background:${msg.senderColor || '#888'}">${(msg.senderName||'?').slice(0,1)}</div>`;
}

function buildBubbleContent(msg) {
  if (msg.type === 'image') {
    return `<img src="${msg.fileUrl}" alt="图片" class="msg-image" onclick="previewImage('${msg.fileUrl}')">`;
  }
  if (msg.type === 'file') {
    const size = formatFileSize(msg.fileSize);
    const icon = getFileIcon(msg.fileName);
    return `
      <a href="${msg.fileUrl}" download="${escHtml(msg.fileName || 'file')}" class="msg-file">
        <span class="msg-file-icon">${icon}</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${escHtml(msg.fileName || 'file')}</div>
          <div class="msg-file-size">${size}</div>
        </div>
      </a>`;
  }
  // 文本，处理换行和链接
  return escHtml(msg.content || '').replace(/\n/g, '<br>').replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" style="color:inherit;text-decoration:underline;">$1</a>'
  );
}

function buildReactionsHtml(msgId, reactions) {
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);
  if (!entries.length) return '<div class="msg-reactions" data-reactions-for="' + msgId + '"></div>';
  const chips = entries.map(([emoji, users]) => {
    const mine = users.includes(state.userId);
    return `<span class="reaction-chip ${mine ? 'mine' : ''}" onclick="sendReaction('${msgId}','${emoji}')">${emoji} ${users.length}</span>`;
  }).join('');
  return `<div class="msg-reactions" data-reactions-for="${msgId}">${chips}</div>`;
}

function renderReactions(wrapper, msgId, reactions) {
  let el = wrapper.querySelector(`[data-reactions-for="${msgId}"]`);
  if (!el) { el = document.createElement('div'); el.className = 'msg-reactions'; el.dataset.reactionsFor = msgId; wrapper.querySelector('.msg-body').appendChild(el); }
  const entries = Object.entries(reactions).filter(([, u]) => u.length > 0);
  el.innerHTML = entries.map(([emoji, users]) => {
    const mine = users.includes(state.userId);
    return `<span class="reaction-chip ${mine ? 'mine' : ''}" onclick="sendReaction('${msgId}','${emoji}')">${emoji} ${users.length}</span>`;
  }).join('');
}

// ═══════════════════════════════════════════
// 发送消息
// ═══════════════════════════════════════════
function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !state.currentRoomId) return;

  socket.emit('message', { roomId: state.currentRoomId, content, type: 'text' });
  input.value = '';
  input.style.height = '';
  sendTyping(false);
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !state.isMobile) {
    e.preventDefault(); sendMessage();
  }
}

function handleInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

let typingTimeout = null;
function sendTyping(isTyping) {
  if (!state.currentRoomId) return;
  socket.emit('typing', { roomId: state.currentRoomId, isTyping });
  if (isTyping) {
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => sendTyping(false), 3000);
  }
}

// ═══════════════════════════════════════════
// 文件上传
// ═══════════════════════════════════════════
function triggerFileUpload(type) {
  document.getElementById(type === 'image' ? 'file-input-image' : 'file-input-file').click();
}

async function uploadFile(input, type) {
  if (!input.files[0] || !state.currentRoomId) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append('file', file);

  showToast('上传中...');
  try {
    const res = await fetch('/api/upload', {
      method: 'POST', headers: { Authorization: state.token }, body: formData
    });
    const data = await res.json();
    const msgType = (type === 'image' && data.mimetype?.startsWith('image/')) ? 'image' : 'file';
    socket.emit('message', {
      roomId: state.currentRoomId,
      content: file.name,
      type: msgType,
      fileUrl: data.url,
      fileName: file.name,
      fileSize: data.size
    });
  } catch (e) { showToast('上传失败'); }
  input.value = '';
}

// ═══════════════════════════════════════════
// 表情
// ═══════════════════════════════════════════
function buildEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  picker.innerHTML = EMOJIS.map(e =>
    `<span class="emoji-btn" onclick="insertEmoji('${e}')">${e}</span>`
  ).join('');
}

function toggleEmojiPicker() {
  document.getElementById('emoji-picker').classList.toggle('hidden');
}

function insertEmoji(emoji) {
  const input = document.getElementById('msg-input');
  input.value += emoji;
  input.focus();
  document.getElementById('emoji-picker').classList.add('hidden');
}

function showReactionPicker(msgId) {
  // 快速反应面板
  const quickEmojis = ['👍','❤️','😂','😮','😢','🙏'];
  const existing = document.getElementById('quick-reaction-panel');
  if (existing) existing.remove();

  const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!wrapper) return;

  const panel = document.createElement('div');
  panel.id = 'quick-reaction-panel';
  panel.style.cssText = 'position:absolute;background:white;border-radius:20px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:6px 10px;display:flex;gap:6px;z-index:200;';
  quickEmojis.forEach(e => {
    const btn = document.createElement('span');
    btn.textContent = e; btn.style.cssText = 'font-size:22px;cursor:pointer;padding:2px;';
    btn.onclick = () => { sendReaction(msgId, e); panel.remove(); };
    panel.appendChild(btn);
  });

  wrapper.style.position = 'relative';
  wrapper.appendChild(panel);
  setTimeout(() => panel.remove(), 5000);
}

function sendReaction(msgId, emoji) {
  if (!state.currentRoomId) return;
  socket.emit('reaction', { roomId: state.currentRoomId, messageId: msgId, emoji });
}

// ═══════════════════════════════════════════
// 私聊 / 群组
// ═══════════════════════════════════════════
function showUserList() {
  document.getElementById('user-list-modal').classList.remove('hidden');
  document.getElementById('user-search').value = '';
  // 先用已缓存用户渲染，再请求刷新
  const cached = [...state.users.values()].filter(u => u.id !== state.userId);
  renderUserModal(cached);
  if (state.authReady) socket.emit('get_users');
}

function renderUserModal(users) {
  renderUserList('modal-user-list', users, 'startPrivateChat');
}

function filterUsers(val) {
  const allUsers = [...state.users.values()].filter(u => u.id !== state.userId);
  const filtered = allUsers.filter(u => u.username?.toLowerCase().includes(val.toLowerCase()));
  renderUserList('modal-user-list', filtered, 'startPrivateChat');
}

// 全局函数：发起私聊（供 onclick 调用）
function startPrivateChat(userId) {
  if (!userId) return;
  socket.emit('private_chat', { targetUserId: userId });
}

function renderUserList(containerId, users, onClickFn) {
  const container = document.getElementById(containerId);
  if (!users.length) { container.innerHTML = '<p style="text-align:center;color:#888;padding:20px">暂无用户</p>'; return; }
  container.innerHTML = users.map(u => `
    <div class="modal-user-item" onclick="${onClickFn}('${u.id}')">
      <div class="avatar-wrap">
        ${u.avatar
          ? `<div class="avatar-circle sm"><img src="${u.avatar}" alt=""></div>`
          : `<div class="avatar-circle sm" style="background:${u.color||'#888'}">${(u.username||'?').slice(0,1)}</div>`
        }
        <div class="online-ring ${u.online ? 'online' : ''}"></div>
      </div>
      <div class="modal-user-name">${escHtml(u.username || '')}</div>
      <div class="modal-user-status">${u.online ? '在线' : '离线'}</div>
    </div>
  `).join('');
}

function showCreateGroup() {
  state.selectedGroupMembers.clear();
  document.getElementById('create-group-modal').classList.remove('hidden');
  document.getElementById('group-name').value = '';
  const allUsers = [...state.users.values()].filter(u => u.id !== state.userId);
  renderGroupUserList(allUsers);
  if (state.authReady) socket.emit('get_users');
}

function renderGroupUserList(users) {
  const container = document.getElementById('group-user-list');
  container.innerHTML = users.map(u => `
    <div class="modal-user-item" id="gu-${u.id}" onclick="toggleGroupMember('${u.id}', '${escHtml(u.username)}')">
      <div class="avatar-circle sm" style="background:${u.color||'#888'}">${(u.username||'?').slice(0,1)}</div>
      <div class="modal-user-name">${escHtml(u.username||'')}</div>
      <div class="check-icon" id="check-${u.id}" style="display:none">✓</div>
    </div>
  `).join('');
}

function toggleGroupMember(uid, name) {
  if (state.selectedGroupMembers.has(uid)) {
    state.selectedGroupMembers.delete(uid);
    document.getElementById(`gu-${uid}`)?.classList.remove('selected');
    document.getElementById(`check-${uid}`).style.display = 'none';
  } else {
    state.selectedGroupMembers.add(uid);
    document.getElementById(`gu-${uid}`)?.classList.add('selected');
    document.getElementById(`check-${uid}`).style.display = 'block';
  }
}

function createGroup() {
  const name = document.getElementById('group-name').value.trim();
  if (!name) { showToast('请输入群组名称'); return; }
  if (state.selectedGroupMembers.size === 0) { showToast('请至少选择一名成员'); return; }
  socket.emit('create_group', { name, memberIds: [...state.selectedGroupMembers] });
  closeModal('create-group-modal');
  showToast(`群组 "${name}" 创建成功`);
}

// ═══════════════════════════════════════════
// 成员列表面板
// ═══════════════════════════════════════════
function toggleMembersPanel() {
  const panel = document.getElementById('members-panel');
  panel.classList.toggle('hidden');
  panel.classList.toggle('show');
}

function renderMembersList(roomId) {
  const room = state.rooms.get(roomId);
  if (!room) return;
  const list = document.getElementById('members-list');
  const members = (room.members || []).map(id => state.users.get(id)).filter(Boolean);

  list.innerHTML = members.length ? members.map(u => `
    <div class="member-item">
      <div class="avatar-circle xs" style="background:${u.color||'#888'}">${(u.username||'?').slice(0,1)}</div>
      <span style="font-size:14px">${escHtml(u.username||'')}</span>
      <div class="online-dot ${u.online ? 'online' : ''}"></div>
    </div>
  `).join('') : '<p style="padding:10px;color:#888;font-size:13px">成员列表加载中...</p>';
}

function renderOnlineStatus() {
  renderRoomList();
  if (state.currentRoomId) renderMembersList(state.currentRoomId);
}

// ═══════════════════════════════════════════
// 图片预览
// ═══════════════════════════════════════════
function previewImage(url) {
  document.getElementById('preview-img').src = url;
  document.getElementById('image-modal').classList.remove('hidden');
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function getFileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const icons = { pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📋', pptx: '📋', zip: '📦', rar: '📦', mp3: '🎵', mp4: '🎬', txt: '📃' };
  return icons[ext] || '📎';
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollToBottom(smooth = true) {
  const c = document.getElementById('messages-container');
  if (smooth) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  else c.scrollTop = c.scrollHeight;
}

function renderAvatarEl(el, name, color, avatar) {
  el.style.background = color || '#888';
  if (avatar) el.innerHTML = `<img src="${avatar}" alt="">`;
  else el.textContent = (name || '?').slice(0, 2);
}

function updateRoomPreview(roomId, msg) {
  renderRoomList(document.getElementById('room-search').value);
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === id);
    p.classList.toggle('hidden', p.id !== id);
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2600);
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ═══════════════════════════════════════════
// 自动登录 & 初始化
// ═══════════════════════════════════════════
window.addEventListener('resize', () => {
  state.isMobile = window.innerWidth <= 768;
});

// 点击空白处关闭表情
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emoji-picker') && !e.target.closest('.tool-btn')) {
    document.getElementById('emoji-picker')?.classList.add('hidden');
  }
});

// 恢复会话
const savedToken = localStorage.getItem('chat_token');
if (savedToken) {
  state.token = savedToken;
  state.userId = localStorage.getItem('chat_userId');
  state.username = localStorage.getItem('chat_username');
  state.color = localStorage.getItem('chat_color');
  state.avatar = localStorage.getItem('chat_avatar') || null;
  enterChat();
} else {
  showPage('auth-page');
}

// 支持 Enter 提交登录
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');
    if (!loginForm.classList.contains('hidden')) login();
    else if (!regForm.classList.contains('hidden')) register();
  }
});
