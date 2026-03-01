const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'revupro-super-secret-merged-key';

const DATA_PATH = path.join(__dirname, 'data.json');
const GPS_LOG_PATH = path.join(__dirname, 'gps_logs.json');

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// --- Data Storage ---
let usersDB = {};               // username -> hash
let messages = [];              // { from, to, message, timestamp, read }
let connectedUsers = new Map(); // username -> socket.id
let callStatus = new Map();

// --- Load/Save Logic ---
function loadData() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const data = fs.readFileSync(DATA_PATH, 'utf8');
      const parsed = JSON.parse(data);
      usersDB = parsed.users || {};
      messages = parsed.messages || [];
    }
  } catch (e) {
    console.log('📝 Creating new data file...');
  }
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify({ users: usersDB, messages }, null, 2));
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

// --- API Routes ---
app.post('/api/auth/signup', async (req, res) => {
  let { username, password } = req.body;
  username = username.toLowerCase().trim();

  if (usersDB[username]) return res.status(409).json({ message: 'User exists' });

  const hashedPassword = await bcrypt.hash(password, 10);
  usersDB[username] = hashedPassword;
  saveData();

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

// ✅ NEW: Delete chat history between current user and target
app.delete('/api/messages/:target', authenticateToken, (req, res) => {
  const target = req.params.target.toLowerCase();
  const current = req.user.username.toLowerCase();

  const before = messages.length;
  messages = messages.filter(
    (m) =>
      !(
        (m.from === current && m.to === target) ||
        (m.from === target && m.to === current)
      )
  );

  const deleted = before - messages.length;
  saveData();

  res.json({ ok: true, deleted });
});

app.get('/api/contacts', authenticateToken, (req, res) => {
  const current = req.user.username.toLowerCase();
  res.json(getContactsForUser(current));
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

  // --- Chat ---
  socket.on('send-message', ({ to, message }) => {
    const timestamp = new Date().toISOString();
    const msg = {
      from: username,
      to: to.toLowerCase(),
      message,
      timestamp,
      read: false,
    };

    messages.push(msg);
    saveData();

    const recipientSocket = connectedUsers.get(to.toLowerCase());

    socket.emit('message-sent-confirm', msg);

    if (recipientSocket) {
      io.to(recipientSocket).emit('receive-message', msg);
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
      saveData();

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

    // validate offer shape early — helps surface client-side serialization issues
    if (!offer || !offer.sdp || !offer.type) {
      console.warn('Malformed offer received, rejecting call', { from: socket.userId, to: toUser });
      socket.emit('call-failed', { user: toUser, reason: 'malformed-offer' });
      return;
    }

    const recipientSocket = connectedUsers.get(toUser);

    // If offline, tell caller
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

  // New: surface diagnostic events coming from client
  socket.on('call-diagnostics', (d) => {
    console.log('call-diagnostics:', socket.userId, d || {});
    // optionally persist to file for later analysis (not implemented here to keep changes small)
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
