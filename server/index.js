const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// ─── 文件上传配置 ───────────────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ─── 数据持久化配置 ───────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 加载数据
function loadData() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      usersData.forEach(u => users.set(u.id, u));
      console.log(`✅ 加载 ${usersData.length} 个用户`);
    }
    if (fs.existsSync(ROOMS_FILE)) {
      const roomsData = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      roomsData.forEach(r => {
        // 确保公共大厅始终存在
        if (r.id !== 'public') rooms.set(r.id, r);
      });
      console.log(`✅ 加载 ${roomsData.length} 个房间`);
    }
  } catch (err) {
    console.error('加载数据失败:', err);
  }
}

// 保存数据
function saveData() {
  try {
    // 保存用户（排除敏感信息）
    const usersData = [...users.values()].map(u => ({
      id: u.id,
      username: u.username,
      password: u.password,
      avatar: u.avatar,
      color: u.color,
      createdAt: u.createdAt
    }));
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
    
    // 保存房间（排除临时数据）
    const roomsData = [...rooms.values()].map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      members: r.members,
      messages: r.messages.slice(-200), // 只保留最近200条消息
      createdAt: r.createdAt
    }));
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomsData, null, 2));
  } catch (err) {
    console.error('保存数据失败:', err);
  }
}

// 定期保存数据
setInterval(saveData, 60000); // 每分钟保存一次

// ─── 内存数据库 ─────────────────────────────────────────────────────────────────
const users = new Map();         // userId -> { id, username, avatar, color, online, socketId }
const rooms = new Map();         // roomId -> { id, name, type, members, messages, createdAt }
const sessions = new Map();      // token -> userId

// 默认公共大厅
rooms.set('public', {
  id: 'public',
  name: '🌍 公共大厅',
  type: 'group',
  members: [],
  messages: [],
  createdAt: Date.now()
});

// 启动时加载数据
loadData();

const AVATAR_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#F1948A'];

// ─── REST API ───────────────────────────────────────────────────────────────────
// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if ([...users.values()].find(u => u.username === username))
    return res.status(400).json({ error: '用户名已存在' });

  const userId = uuidv4();
  const token = uuidv4();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const hash = bcrypt.hashSync(password, 8);

  users.set(userId, {
    id: userId, username, password: hash,
    avatar: null, color, online: false, socketId: null
  });
  sessions.set(token, userId);
  res.json({ token, userId, username, color });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = [...users.values()].find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: '用户名或密码错误' });

  const token = uuidv4();
  sessions.set(token, user.id);
  res.json({ token, userId: user.id, username: user.username, color: user.color, avatar: user.avatar });
});

// 上传头像
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const token = req.headers.authorization;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: '未授权' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  user.avatar = `/uploads/${req.file.filename}`;
  res.json({ avatar: user.avatar });
});

// 上传文件/图片
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '无文件' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// 获取房间列表 - 只返回用户有权限的房间
app.get('/api/rooms', (req, res) => {
  const token = req.headers.authorization;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: '未授权' });

  const list = [...rooms.values()].filter(r => {
    // 公共大厅对所有人可见
    if (r.id === 'public') return true;
    // 群组：成员可见
    if (r.type === 'group') return r.members.includes(userId);
    // 私聊：参与者可见
    if (r.type === 'private') return r.members.includes(userId);
    return false;
  }).map(r => ({
    id: r.id, name: r.name, type: r.type,
    lastMessage: r.messages[r.messages.length - 1] || null,
    members: r.members.length,
    unread: 0
  }));
  res.json(list);
});

// 删除/退出房间
app.delete('/api/rooms/:roomId', (req, res) => {
  const token = req.headers.authorization;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: '未授权' });
  
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  
  // 不能删除公共大厅
  if (roomId === 'public') return res.status(403).json({ error: '不能删除公共大厅' });
  
  if (room.type === 'private') {
    // 私聊：从用户列表中移除
    room.members = room.members.filter(id => id !== userId);
    // 如果成员为空，删除房间
    if (room.members.length === 0) {
      rooms.delete(roomId);
    }
  } else if (room.type === 'group') {
    // 群聊：退出群聊
    room.members = room.members.filter(id => id !== userId);
    // 如果成员为空，删除房间
    if (room.members.length === 0) {
      rooms.delete(roomId);
    }
  }
  
  // 通知房间其他成员
  io.to(roomId).emit('member_left', { roomId, userId, username: users.get(userId)?.username });
  
  // 保存数据
  saveData();
  
  res.json({ success: true });
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentUserId = null;
  let currentRooms = new Set();

  // 鉴权加入
  socket.on('auth', ({ token }) => {
    const userId = sessions.get(token);
    if (!userId) { socket.emit('auth_error', '身份验证失败'); return; }

    currentUserId = userId;
    const user = users.get(userId);
    user.online = true;
    user.socketId = socket.id;

    // 自动加入公共大厅
    socket.join('public');
    currentRooms.add('public');
    if (!rooms.get('public').members.includes(userId))
      rooms.get('public').members.push(userId);

    // 加入所有私聊房间
    [...rooms.values()]
      .filter(r => r.type === 'private' && r.members.includes(userId))
      .forEach(r => { socket.join(r.id); currentRooms.add(r.id); });

    socket.emit('auth_ok', {
      userId, username: user.username, color: user.color, avatar: user.avatar
    });

    // 推送公共大厅历史消息 (最近100条)
    const publicRoom = rooms.get('public');
    socket.emit('history', { roomId: 'public', messages: publicRoom.messages.slice(-100) });
    
    // 推送用户所有相关房间的历史消息
    [...rooms.values()].forEach(r => {
      if (r.id !== 'public' && r.members.includes(userId)) {
        socket.emit('history', { roomId: r.id, messages: r.messages.slice(-100) });
      }
    });

    // 推送在线用户
    broadcastOnlineUsers();

    console.log(`✅ ${user.username} 上线`);
  });

  // 发送消息
  socket.on('message', ({ roomId, content, type = 'text', fileUrl, fileName, fileSize }) => {
    if (!currentUserId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = users.get(currentUserId);
    const msg = {
      id: uuidv4(),
      roomId,
      senderId: currentUserId,
      senderName: user.username,
      senderColor: user.color,
      senderAvatar: user.avatar,
      content,
      type,       // text | image | file | emoji
      fileUrl,
      fileName,
      fileSize,
      timestamp: Date.now(),
      reactions: {}
    };

    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);

    io.to(roomId).emit('message', msg);
  });

  // 创建/获取私聊
  socket.on('private_chat', ({ targetUserId }) => {
    if (!currentUserId || !users.has(targetUserId)) return;
    const ids = [currentUserId, targetUserId].sort();
    const roomId = `private_${ids[0]}_${ids[1]}`;

    if (!rooms.has(roomId)) {
      const target = users.get(targetUserId);
      const me = users.get(currentUserId);
      rooms.set(roomId, {
        id: roomId,
        name: `${me.username} & ${target.username}`,
        type: 'private',
        members: ids,
        messages: [],
        createdAt: Date.now()
      });
    }

    socket.join(roomId);
    currentRooms.add(roomId);

    // 通知对方
    const targetUser = users.get(targetUserId);
    if (targetUser.socketId) {
      const targetSocket = io.sockets.sockets.get(targetUser.socketId);
      if (targetSocket) {
        targetSocket.join(roomId);
        targetSocket.emit('new_private_room', { roomId, with: users.get(currentUserId) });
      }
    }

    const room = rooms.get(roomId);
    socket.emit('private_room_ready', {
      roomId,
      history: room.messages.slice(-100),
      target: { id: targetUserId, ...sanitizeUser(targetUser) }
    });
  });

  // 创建群组
  socket.on('create_group', ({ name, memberIds }) => {
    if (!currentUserId) return;
    const roomId = 'group_' + uuidv4().slice(0, 8);
    const allMembers = [...new Set([currentUserId, ...memberIds])];
    rooms.set(roomId, {
      id: roomId, name, type: 'group',
      members: allMembers, messages: [], createdAt: Date.now()
    });

    allMembers.forEach(uid => {
      const u = users.get(uid);
      if (u && u.socketId) {
        const s = io.sockets.sockets.get(u.socketId);
        if (s) { s.join(roomId); }
      }
    });

    const creator = users.get(currentUserId);
    io.to(roomId).emit('group_created', { roomId, name, creator: creator.username });
    io.to(roomId).emit('history', { roomId, messages: [] });
  });

  // 正在输入
  socket.on('typing', ({ roomId, isTyping }) => {
    if (!currentUserId) return;
    const user = users.get(currentUserId);
    socket.to(roomId).emit('typing', {
      userId: currentUserId, username: user.username, isTyping, roomId
    });
  });

  // 消息表情反应
  socket.on('reaction', ({ roomId, messageId, emoji }) => {
    if (!currentUserId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = room.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(currentUserId);
    if (idx >= 0) msg.reactions[emoji].splice(idx, 1);
    else msg.reactions[emoji].push(currentUserId);
    io.to(roomId).emit('reaction_updated', { messageId, reactions: msg.reactions });
  });

  // 获取用户列表
  socket.on('get_users', () => {
    if (!currentUserId) return;
    const list = [...users.values()]
      .filter(u => u.id !== currentUserId)
      .map(u => ({ id: u.id, ...sanitizeUser(u) }));
    socket.emit('users_list', list);
  });

  // 断开连接
  socket.on('disconnect', () => {
    if (currentUserId) {
      const user = users.get(currentUserId);
      if (user) { user.online = false; user.socketId = null; }
      broadcastOnlineUsers();
      console.log(`👋 ${user?.username} 下线`);
    }
  });

  function broadcastOnlineUsers() {
    const list = [...users.values()].map(u => ({
      id: u.id, ...sanitizeUser(u)
    }));
    io.emit('online_users', list);
  }

  function sanitizeUser(u) {
    return { username: u.username, color: u.color, avatar: u.avatar, online: u.online };
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 聊天服务器运行在 http://localhost:${PORT}`);
  console.log(`📱 手机访问: http://<your-ip>:${PORT}\n`);
});
