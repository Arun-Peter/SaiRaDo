const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

const DATA_PATH = path.join(__dirname, 'data.json');
const USERS_PATH = path.join(__dirname, 'users.json');
const CHATS_PATH = path.join(__dirname, 'chats.json');
const APP_STATE_PATH = path.join(__dirname, 'app_state.json');
const GPS_LOG_PATH = path.join(__dirname, 'gps_logs.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const ATTACHMENT_TYPES = new Set([...IMAGE_TYPES, ...VIDEO_TYPES]);

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve only client assets; application data stays outside the public directory.
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Serve index.html as the root page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// --- Data Storage ---
let usersDB = {};               // username -> hash
let messages = [];              // { from, to, message, timestamp, read }
let groups = {};                // groupId -> { id, name, members[], createdBy, createdAt }
let groupMessages = [];         // { groupId, from, message, timestamp }
let blockedUsers = {};          // username -> array of blocked usernames (serialized as array)
let connectedUsers = new Map(); // username -> socket.id
let callStatus = new Map();

// --- Load/Save Logic ---
function loadData() {
  const legacyData = fs.existsSync(DATA_PATH)
    ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
    : {};
  const usersData = readJson(USERS_PATH, legacyData.users || {});
  const chatsData = readJson(CHATS_PATH, {
    messages: legacyData.messages || [],
    groupMessages: legacyData.groupMessages || [],
  });
  const appStateData = readJson(APP_STATE_PATH, {
    groups: legacyData.groups || {},
    blockedUsers: legacyData.blockedUsers || {},
  });

  usersDB = usersData;
  messages = chatsData.messages || [];
  groupMessages = chatsData.groupMessages || [];
  groups = appStateData.groups || {};
  blockedUsers = appStateData.blockedUsers || {};

  if (fs.existsSync(DATA_PATH)) {
    saveUsers();
    saveChats();
    saveAppState();
    fs.unlinkSync(DATA_PATH);
    console.log('✅ Migrated data.json into users.json, chats.json, and app_state.json');
  }
}

function readJson(filePath, fallback) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
    : fallback;
}

function saveUsers() {
  fs.writeFileSync(USERS_PATH, JSON.stringify(usersDB, null, 2));
}

function saveChats() {
  fs.writeFileSync(CHATS_PATH, JSON.stringify({
    messages,
    groupMessages,
  }, null, 2));
}

function saveAppState() {
  fs.writeFileSync(APP_STATE_PATH, JSON.stringify({
    groups,
    blockedUsers,
  }, null, 2));
}

function removeAttachments(chatMessages) {
  for (const msg of chatMessages) {
    const id = msg.attachment && msg.attachment.id;
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) {
      fs.rmSync(path.join(UPLOADS_DIR, id), { force: true });
    }
  }
}

function getAttachmentType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    return 'video/mp4';
  }
  if (buffer.length >= 4 &&
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'video/webm';
  }
  return null;
}

function createAttachmentMessage({ username, recipient, groupId, message, buffer, mimeType }) {
  const id = crypto.randomUUID();
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(UPLOADS_DIR, id), buffer, { flag: 'wx', mode: 0o600 });

  const msg = {
    from: username,
    message,
    timestamp: new Date().toISOString(),
    attachment: { id, mimeType },
  };

  if (groupId) {
    msg.groupId = groupId;
    groupMessages.push(msg);
    try {
      saveChats();
    } catch (error) {
      groupMessages.pop();
      fs.rmSync(path.join(UPLOADS_DIR, id), { force: true });
      throw error;
    }
    for (const member of groups[groupId].members) {
      const sid = connectedUsers.get(member);
      if (sid) io.to(sid).emit('receive-group-message', msg);
    }
  } else {
    msg.to = recipient;
    msg.read = false;
    messages.push(msg);
    try {
      saveChats();
    } catch (error) {
      messages.pop();
      fs.rmSync(path.join(UPLOADS_DIR, id), { force: true });
      throw error;
    }
    const recipientSocket = connectedUsers.get(recipient);
    socketBroadcastDirectMessage(username, recipientSocket, msg);
  }
  return msg;
}

function socketBroadcastDirectMessage(username, recipientSocket, msg) {
  const senderSocket = connectedUsers.get(username);
  if (senderSocket) io.to(senderSocket).emit('message-sent-confirm', msg);
  if (recipientSocket) io.to(recipientSocket).emit('receive-message', msg);
}

function logGPS(username, stage, type, coords) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    username,
    stage,
    callType: type,
    latitude: coords.latitude || 'N/A',
    longitude: coords.longitude || 'N/A',
    error: coords.error || null,
  };

  let logs = [];
  try {
    if (fs.existsSync(GPS_LOG_PATH)) {
      logs = JSON.parse(fs.readFileSync(GPS_LOG_PATH, 'utf8'));
    }
  } catch (e) {}

  logs.push(logEntry);
  fs.writeFileSync(GPS_LOG_PATH, JSON.stringify(logs, null, 2));
  console.log(`📍 GPS Logged [${stage}] for ${username}`);
}

loadData();

// --- Auth Middleware ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Contacts helper
function getContactsForUser(username) {
  const current = username.toLowerCase();
  const set = new Set();

  for (const m of messages) {
    if (m.from === current) set.add(m.to);
    if (m.to === current) set.add(m.from);
  }

  set.delete(current);
  return Array.from(set).sort();
}

function isBlocked(blocker, target) {
  const list = blockedUsers[blocker.toLowerCase()];
  return Array.isArray(list) && list.includes(target.toLowerCase());
}

// --- API Routes ---
app.post('/api/auth/signup', async (req, res) => {
  let { username, password } = req.body;
  username = username.toLowerCase().trim();

  if (usersDB[username]) return res.status(409).json({ message: 'User exists' });

  const hashedPassword = await bcrypt.hash(password, 10);
  usersDB[username] = hashedPassword;
  saveUsers();

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/api/auth/login', async (req, res) => {
  let { username, password } = req.body;
  username = username.toLowerCase().trim();

  if (!usersDB[username]) return res.status(401).json({ message: 'Invalid credentials' });

  const isValid = await bcrypt.compare(password, usersDB[username]);
  if (!isValid) return res.status(401).json({ message: 'Invalid credentials' });

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({ username: req.user.username });
});

app.post('/api/attachments/direct/:target', authenticateToken,
  express.raw({ type: Array.from(ATTACHMENT_TYPES), limit: MAX_VIDEO_BYTES }),
  (req, res) => {
    const username = req.user.username.toLowerCase();
    const target = req.params.target.toLowerCase();
    const buffer = req.body;

    if (!usersDB[target] || target === username) {
      return res.status(404).json({ message: 'Chat recipient not found' });
    }
    if (isBlocked(target, username)) {
      return res.status(403).json({ message: 'Recipient is not accepting messages from you' });
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ message: 'Choose a supported attachment to upload' });
    }
    const mimeType = getAttachmentType(buffer);
    if (!mimeType || mimeType !== req.headers['content-type'] ||
        !ATTACHMENT_TYPES.has(req.headers['content-type'])) {
      return res.status(415).json({ message: 'Only valid JPEG, PNG, GIF, WebP, MP4, or WebM files are supported' });
    }
    const maxBytes = VIDEO_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (buffer.length >= maxBytes) {
      return res.status(413).json({
        message: VIDEO_TYPES.has(mimeType)
          ? 'Video must be smaller than 5 MB'
          : 'Image must be smaller than 1 MB',
      });
    }

    const message = typeof req.headers['x-message-text'] === 'string'
      ? req.headers['x-message-text'].trim()
      : '';
    if (message.length > 1000) {
      return res.status(400).json({ message: 'Caption must be 1000 characters or fewer' });
    }

    const msg = createAttachmentMessage({ username, recipient: target, message, buffer, mimeType });
    res.status(201).json(msg);
  });

app.post('/api/attachments/group/:groupId', authenticateToken,
  express.raw({ type: Array.from(ATTACHMENT_TYPES), limit: MAX_VIDEO_BYTES }),
  (req, res) => {
    const username = req.user.username.toLowerCase();
    const group = groups[req.params.groupId];
    const buffer = req.body;

    if (!group || !group.members.includes(username)) {
      return res.status(403).json({ message: 'Not a member of this group' });
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ message: 'Choose a supported attachment to upload' });
    }
    const mimeType = getAttachmentType(buffer);
    if (!mimeType || mimeType !== req.headers['content-type'] ||
        !ATTACHMENT_TYPES.has(req.headers['content-type'])) {
      return res.status(415).json({ message: 'Only valid JPEG, PNG, GIF, WebP, MP4, or WebM files are supported' });
    }
    const maxBytes = VIDEO_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (buffer.length >= maxBytes) {
      return res.status(413).json({
        message: VIDEO_TYPES.has(mimeType)
          ? 'Video must be smaller than 5 MB'
          : 'Image must be smaller than 1 MB',
      });
    }

    const message = typeof req.headers['x-message-text'] === 'string'
      ? req.headers['x-message-text'].trim()
      : '';
    if (message.length > 1000) {
      return res.status(400).json({ message: 'Caption must be 1000 characters or fewer' });
    }

    const msg = createAttachmentMessage({
      username,
      groupId: group.id,
      message,
      buffer,
      mimeType,
    });
    res.status(201).json(msg);
  });

app.get('/api/attachments/:id', authenticateToken, (req, res) => {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(404).json({ message: 'Attachment not found' });
  }

  const username = req.user.username.toLowerCase();
  const msg = messages.find(item => item.attachment && item.attachment.id === id &&
    (item.from === username || item.to === username)) ||
    groupMessages.find(item => item.attachment && item.attachment.id === id &&
      groups[item.groupId] && groups[item.groupId].members.includes(username));
  if (!msg || !ATTACHMENT_TYPES.has(msg.attachment.mimeType)) {
    return res.status(404).json({ message: 'Attachment not found' });
  }

  const filePath = path.join(UPLOADS_DIR, id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'Attachment file not found' });
  }

  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  });
  res.type(msg.attachment.mimeType).sendFile(filePath);
});

app.get('/api/messages/:target', authenticateToken, (req, res) => {
  const target = req.params.target.toLowerCase();
  const current = req.user.username.toLowerCase();

  const history = messages.filter(
    (m) =>
      (m.from === current && m.to === target) ||
      (m.from === target && m.to === current)
  );

  res.json(history);
});

// Delete chat history between current user and target
app.delete('/api/messages/:target', authenticateToken, (req, res) => {
  const target = req.params.target.toLowerCase();
  const current = req.user.username.toLowerCase();

  const before = messages.length;
  const removedMessages = messages.filter(
    (m) => (m.from === current && m.to === target) || (m.from === target && m.to === current)
  );
  messages = messages.filter(
    (m) =>
      !(
        (m.from === current && m.to === target) ||
        (m.from === target && m.to === current)
      )
  );

  const deleted = before - messages.length;
  saveChats();
  removeAttachments(removedMessages);

  res.json({ ok: true, deleted });
});

app.get('/api/contacts', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  res.json(getContactsForUser(current));
});

// --- Block / Unblock Routes ---
app.get('/api/blocked', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  res.json(blockedUsers[current] || []);
});

app.post('/api/block/:target', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  const target = req.params.target.toLowerCase();
  if (current === target) return res.status(400).json({ message: 'Cannot block yourself' });

  if (!blockedUsers[current]) blockedUsers[current] = [];
  if (!blockedUsers[current].includes(target)) {
    blockedUsers[current].push(target);
    saveAppState();
  }
  res.json({ ok: true });
});

app.post('/api/unblock/:target', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  const target = req.params.target.toLowerCase();

  if (blockedUsers[current]) {
    blockedUsers[current] = blockedUsers[current].filter(u => u !== target);
    saveAppState();
  }
  res.json({ ok: true });
});

// --- Group Routes ---
app.get('/api/groups', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  const myGroups = Object.values(groups).filter(g => g.members.includes(current));
  res.json(myGroups);
});

app.post('/api/groups', authenticateToken, (req, res) => {
  let { name, members } = req.body;
  const current = req.user.username.toLowerCase();

  if (!name || !name.trim()) return res.status(400).json({ message: 'Group name required' });
  if (!Array.isArray(members) || members.length < 1) {
    return res.status(400).json({ message: 'At least one other member required' });
  }

  const memberSet = new Set(members.map(m => m.toLowerCase()));
  memberSet.add(current);

  const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const group = {
    id: groupId,
    name: name.trim(),
    members: Array.from(memberSet),
    createdBy: current,
    createdAt: new Date().toISOString(),
  };

  groups[groupId] = group;
  saveAppState();

  // Notify all online members
  for (const member of group.members) {
    const sid = connectedUsers.get(member);
    if (sid) io.to(sid).emit('group-created', group);
  }

  res.json(group);
});

app.get('/api/groups/:groupId/messages', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  const { groupId } = req.params;
  const group = groups[groupId];

  if (!group || !group.members.includes(current)) {
    return res.status(403).json({ message: 'Not a member of this group' });
  }

  res.json(groupMessages.filter(m => m.groupId === groupId));
});

app.delete('/api/groups/:groupId', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  const { groupId } = req.params;
  const group = groups[groupId];

  if (!group) return res.status(404).json({ message: 'Group not found' });
  if (!group.members.includes(current)) return res.status(403).json({ message: 'Not a member' });

  const members = [...group.members];
  delete groups[groupId];
  const removedMessages = groupMessages.filter(m => m.groupId === groupId);
  groupMessages = groupMessages.filter(m => m.groupId !== groupId);
  saveAppState();
  saveChats();
  removeAttachments(removedMessages);

  for (const member of members) {
    const sid = connectedUsers.get(member);
    if (sid) io.to(sid).emit('group-deleted', { groupId, deletedBy: current });
  }

  res.json({ ok: true });
});

// --- Socket Logic ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication failed'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Invalid token'));
    socket.userId = decoded.username.toLowerCase();
    next();
  });
});

function getTimestamp() {
  return new Date().toISOString();
}

io.on('connection', (socket) => {
  const username = socket.userId;

  connectedUsers.set(username, socket.id);
  console.log(`✅ ${username} connected [${getTimestamp()}]`);

  io.emit('users-online', Array.from(connectedUsers.keys()));

  // Send unread counts on login
  const unreadCounts = {};
  messages.forEach((m) => {
    if (m.to === username && !m.read) {
      unreadCounts[m.from] = (unreadCounts[m.from] || 0) + 1;
    }
  });
  socket.emit('unread-counts', unreadCounts);

  // --- Direct Chat ---
  socket.on('send-message', ({ to, message }) => {
    const toUser = to.toLowerCase();

    // Silently drop if recipient has blocked this sender
    if (isBlocked(toUser, username)) {
      socket.emit('message-blocked', { to: toUser });
      return;
    }

    const timestamp = new Date().toISOString();
    const msg = {
      from: username,
      to: toUser,
      message,
      timestamp,
      read: false,
    };

    messages.push(msg);
    saveChats();

    const recipientSocket = connectedUsers.get(toUser);

    socket.emit('message-sent-confirm', msg);

    if (recipientSocket) {
      io.to(recipientSocket).emit('receive-message', msg);
    }
  });

  // --- Group Chat ---
  socket.on('send-group-message', ({ groupId, message }) => {
    const group = groups[groupId];
    if (!group || !group.members.includes(username)) return;

    const timestamp = new Date().toISOString();
    const msg = { groupId, from: username, message, timestamp };

    groupMessages.push(msg);
    saveChats();

    for (const member of group.members) {
      const sid = connectedUsers.get(member);
      if (sid) io.to(sid).emit('receive-group-message', msg);
    }
  });

  socket.on('mark-read', ({ sender }) => {
    let updated = false;
    sender = sender.toLowerCase();

    messages.forEach((m) => {
      if (m.from === sender && m.to === username && !m.read) {
        m.read = true;
        updated = true;
      }
    });

    if (updated) {
      saveChats();

      const senderSocketId = connectedUsers.get(sender);
      if (senderSocketId) {
        io.to(senderSocketId).emit('messages-read', { by: username });
      }

      const myUnread = {};
      messages.forEach((m) => {
        if (m.to === username && !m.read) {
          myUnread[m.from] = (myUnread[m.from] || 0) + 1;
        }
      });
      socket.emit('unread-counts', myUnread);
    }
  });

  // --- Calls ---
  socket.on('call-user', ({ userToCall, offer, type }) => {
    const toUser = (userToCall || '').toLowerCase();
    console.log(`📞 call-user from=${socket.userId} to=${toUser} type=${type} sdpLength=${offer && offer.sdp ? offer.sdp.length : 0}`);

    if (!offer || !offer.sdp || !offer.type) {
      console.warn('Malformed offer received, rejecting call', { from: socket.userId, to: toUser });
      socket.emit('call-failed', { user: toUser, reason: 'malformed-offer' });
      return;
    }

    const recipientSocket = connectedUsers.get(toUser);

    if (!recipientSocket) {
      socket.emit('call-failed', { user: toUser, reason: 'offline' });
      return;
    }

    callStatus.set(socket.userId, { with: toUser, type });
    io.to(recipientSocket).emit('incoming-call', { from: socket.userId, offer, type });
  });

  socket.on('answer-call', ({ to, answer }) => {
    console.log(`✅ answer-call from=${socket.userId} to=${to} sdpLength=${answer && answer.sdp ? answer.sdp.length : 0}`);
    if (!answer || !answer.sdp || !answer.type) {
      console.warn('Malformed answer received', { from: socket.userId, to });
      return;
    }
    const recipientSocket = connectedUsers.get(to.toLowerCase());
    if (recipientSocket) {
      callStatus.set(socket.userId, { with: to, type: 'active' });
      io.to(recipientSocket).emit('call-accepted', answer);
    }
  });

  socket.on('call-diagnostics', (d) => {
    console.log('call-diagnostics:', socket.userId, d || {});
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const recipientSocket = connectedUsers.get(to.toLowerCase());
    if (recipientSocket) io.to(recipientSocket).emit('ice-candidate', candidate);
  });

  socket.on('cancel-call', ({ to }) => {
    const recipientSocket = connectedUsers.get(to.toLowerCase());
    callStatus.delete(username);
    if (recipientSocket) io.to(recipientSocket).emit('call-cancelled');
  });

  socket.on('reject-call', ({ to }) => {
    const recipientSocket = connectedUsers.get(to.toLowerCase());
    if (recipientSocket) io.to(recipientSocket).emit('call-rejected');
  });

  socket.on('end-call', ({ to }) => {
    const recipientSocket = connectedUsers.get(to.toLowerCase());
    callStatus.delete(username);
    if (recipientSocket) io.to(recipientSocket).emit('call-ended');
  });

  socket.on('log-gps', ({ coords, type, stage }) => {
    logGPS(username, stage, type, coords);
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(username);
    callStatus.delete(username);
    console.log(`❌ ${username} disconnected [${getTimestamp()}]`);
    io.emit('users-online', Array.from(connectedUsers.keys()));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SaiRaDo Server running on port ${PORT}`);
  console.log(`📍 GPS Logs saved to: ${GPS_LOG_PATH}`);
});
