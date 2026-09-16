const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { AccessToken } = require('livekit-server-sdk');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ✅ Socket.IO សម្រាប់ Remote Control
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIGURATION
// ============================================================
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'APIitJucPDF6UUB';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'RMIiHGvrNbGG1sC6KtHIhYfv5egzX9upvmcdPNLVqvQ';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://meeting-86lp77zt.livekit.cloud';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI not set!');
  process.exit(1);
}

// ============================================================
// MONGODB SCHEMAS
// ============================================================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  displayName: { type: String, default: '' },
  role: { 
    type: String, 
    enum: ['admin', 'supervisor', 'user'], 
    default: 'user' 
  },
  assignedRooms: [{ type: String }],
  isActive: { type: Boolean, default: true },
  currentDeviceId: { type: String, default: null },
  lastLogin: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  roomName: { type: String, default: '' },
  createdBy: { type: String, default: 'system' },
  createdAt: { type: Date, default: Date.now }
});

const remoteRequestSchema = new mongoose.Schema({
  controllerId: { type: String, required: true },
  controllerName: { type: String, required: true },
  targetId: { type: String, required: true },
  targetName: { type: String, required: true },
  roomId: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'ended'], 
    default: 'pending' 
  },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const RemoteRequest = mongoose.model('RemoteRequest', remoteRequestSchema);

// ============================================================
// OTP + ONLINE TRACKING
// ============================================================
const otpStore = new Map();
const onlineUsers = new Map();
const roomOnlineCount = {};

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of otpStore.entries()) {
    if (value.expiresAt < now) otpStore.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================
// MONGODB CONNECTION
// ============================================================
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ Connected to MongoDB!');
    
    const adminExists = await User.findOne({ username: 'admin' });
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await User.create({
        username: 'admin',
        password: hashedPassword,
        displayName: 'Administrator',
        role: 'admin',
        assignedRooms: ['*'],
        isActive: true,
        currentDeviceId: null
      });
      console.log('✅ Created default admin: admin / admin123');
    }
    
    const room1 = await Room.findOne({ roomId: 'meeting-1' });
    if (!room1) {
      await Room.create({ roomId: 'meeting-1', roomName: 'បន្ទប់ទី ១' });
      await Room.create({ roomId: 'meeting-2', roomName: 'បន្ទប់ទី ២' });
      await Room.create({ roomId: 'meeting-3', roomName: 'បន្ទប់ទី ៣' });
      console.log('✅ Created default rooms');
    }
  })
  .catch(err => {
    console.error('❌ MongoDB Error:', err);
    process.exit(1);
  });

// ============================================================
// MIDDLEWARE
// ============================================================
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function verifyAdminOrSupervisor(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
    return res.status(403).json({ error: 'Admin or Supervisor access required' });
  }
  next();
}

// ============================================================
// API: GET PUBLIC ROOMS
// ============================================================
app.get('/api/rooms/public', async (req, res) => {
  try {
    const rooms = await Room.find({}, 'roomId roomName');
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: LOGIN
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password, deviceId, selectedRoom } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(401).json({ error: 'ឈ្មោះ ឬលេខសម្ងាត់មិនត្រឹមត្រូវ!' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'គណនីត្រូវបានផ្អាក!' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'ឈ្មោះ ឬលេខសម្ងាត់មិនត្រឹមត្រូវ!' });
    }

    // ✅ ពិនិត្យសិទ្ធិចូលបន្ទប់
    if (user.role === 'user' && selectedRoom) {
      const canJoin = user.assignedRooms.includes('*') || 
                      user.assignedRooms.includes(selectedRoom);
      
      if (!canJoin) {
        return res.status(403).json({ 
          error: `អ្នកគ្មានសិទ្ធិចូលបន្ទប់ "${selectedRoom}" ទេ!` 
        });
      }
    }

    // 2FA CHECK
    const hasOtherDevice = user.currentDeviceId && 
                           user.currentDeviceId !== 'null' &&
                           user.currentDeviceId !== deviceId &&
                           user.lastLogin && 
                           (Date.now() - new Date(user.lastLogin).getTime()) < (30 * 60 * 1000);

    if (hasOtherDevice) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otpStore.set(username, {
        otp: otp,
        expiresAt: Date.now() + (5 * 60 * 1000),
        deviceId: deviceId
      });

      console.log(`🔐 2FA Required for ${username}. OTP: ${otp}`);
      
      return res.json({
        requires2FA: true,
        message: 'គណនីកំពុង Online នៅឧបករណ៍ផ្សេង!',
        debugOtp: otp
      });
    }

    user.currentDeviceId = deviceId || 'unknown';
    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        assignedRooms: user.assignedRooms
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ Login: ${username} (${user.role})`);
    
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        assignedRooms: user.assignedRooms
      },
      selectedRoom: selectedRoom || null
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: LOGOUT
// ============================================================
app.post('/api/auth/logout', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user) {
      user.currentDeviceId = null;
      await user.save();
      console.log(`🚪 Logout: ${user.username}`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: VERIFY OTP
// ============================================================
app.post('/api/auth/verify-otp', async (req, res) => {
  const { username, password, otp, deviceId, selectedRoom } = req.body;

  try {
    const storedOtp = otpStore.get(username);
    if (!storedOtp || storedOtp.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'OTP ផុតកំណត់!' });
    }
    if (storedOtp.otp !== otp) {
      return res.status(401).json({ error: 'OTP មិនត្រឹមត្រូវ!' });
    }

    otpStore.delete(username);
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.currentDeviceId = deviceId;
    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        assignedRooms: user.assignedRooms
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        assignedRooms: user.assignedRooms
      },
      selectedRoom: selectedRoom || null
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: REGISTER USER (Admin only)
// ============================================================
app.post('/api/auth/register', verifyToken, verifyAdmin, async (req, res) => {
  const { username, password, displayName, role, assignedRooms } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      password: hashedPassword,
      displayName: displayName || username,
      role: role || 'user',
      assignedRooms: assignedRooms || [],
      isActive: true,
      currentDeviceId: null
    });

    console.log(`✅ User created: ${username} (${role})`);
    res.json({ success: true, user });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ============================================================
// API: GET MY ROOMS
// ============================================================
app.get('/api/rooms/my-rooms', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let rooms;
    if (user.role === 'admin' || user.role === 'supervisor' || user.assignedRooms.includes('*')) {
      rooms = await Room.find();
    } else {
      rooms = await Room.find({ roomId: { $in: user.assignedRooms } });
    }

    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: ADMIN ROOMS
// ============================================================
app.get('/api/admin/rooms', verifyToken, verifyAdminOrSupervisor, async (req, res) => {
  try {
    const rooms = await Room.find();
    const roomsWithStats = rooms.map(room => ({
      ...room.toObject(),
      onlineCount: roomOnlineCount[room.roomId] || 0
    }));
    res.json({ rooms: roomsWithStats });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: CREATE ROOM (Admin only)
// ============================================================
app.post('/api/admin/rooms', verifyToken, verifyAdmin, async (req, res) => {
  const { roomId, roomName } = req.body;

  if (!roomId) {
    return res.status(400).json({ error: 'Room ID required' });
  }

  try {
    const existing = await Room.findOne({ roomId });
    if (existing) {
      return res.status(400).json({ error: 'បន្ទប់នេះមានរួចហើយ!' });
    }

    const room = await Room.create({
      roomId,
      roomName: roomName || roomId,
      createdBy: req.user.username
    });

    console.log(`✅ Room created: ${roomId}`);
    res.json({ success: true, room });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// ============================================================
// API: DELETE ROOM (Admin only)
// ============================================================
app.delete('/api/admin/rooms/:roomId', verifyToken, verifyAdmin, async (req, res) => {
  try {
    await Room.findOneAndDelete({ roomId: req.params.roomId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// ============================================================
// API: GET USERS
// ============================================================
app.get('/api/admin/users', verifyToken, verifyAdminOrSupervisor, async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============================================================
// API: UPDATE USER
// ============================================================
app.put('/api/admin/users/:id', verifyToken, verifyAdminOrSupervisor, async (req, res) => {
  const { displayName, role, assignedRooms, isActive, newPassword } = req.body;

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (req.user.role === 'supervisor' && user.role === 'admin') {
      return res.status(403).json({ error: 'Supervisor មិនអាចកែ Admin បានទេ!' });
    }

    if (displayName) user.displayName = displayName;
    if (role && user.username !== 'admin' && req.user.role === 'admin') user.role = role;
    if (assignedRooms) user.assignedRooms = assignedRooms;
    if (typeof isActive === 'boolean' && req.user.role === 'admin') user.isActive = isActive;
    
    if (newPassword && newPassword.length >= 4) {
      user.password = await bcrypt.hash(newPassword, 10);
      user.currentDeviceId = null;
    }

    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ============================================================
// API: TOGGLE USER
// ============================================================
app.put('/api/admin/users/:id/toggle', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'admin' && user.username === req.user.username) {
      return res.status(400).json({ error: 'មិនអាចផ្អាកខ្លួនឯងបានទេ!' });
    }

    user.isActive = !user.isActive;
    if (!user.isActive) user.currentDeviceId = null;
    await user.save();

    res.json({ success: true, isActive: user.isActive });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle user' });
  }
});

// ============================================================
// API: DELETE USER
// ============================================================
app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.role === 'admin') {
      return res.status(400).json({ error: 'មិនអាចលុប Admin បានទេ!' });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ============================================================
// API: STATS
// ============================================================
app.get('/api/admin/stats', verifyToken, verifyAdminOrSupervisor, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalRooms = await Room.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    
    let totalOnline = 0;
    Object.values(roomOnlineCount).forEach(count => totalOnline += count);

    res.json({
      totalUsers,
      totalRooms,
      activeUsers,
      totalOnline
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: GET TOKEN
// ============================================================
app.post('/api/get-token', verifyToken, async (req, res) => {
  const { roomName } = req.body;
  const user = req.user;

  if (!roomName) {
    return res.status(400).json({ error: 'Room name required' });
  }

  const dbUser = await User.findById(user.id);
  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  const canJoin = 
    dbUser.role === 'admin' || 
    dbUser.role === 'supervisor' || 
    dbUser.assignedRooms.includes('*') ||
    dbUser.assignedRooms.includes(roomName);

  if (!canJoin) {
    return res.status(403).json({ error: 'អ្នកគ្មានសិទ្ធិចូលបន្ទប់នេះទេ!' });
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: user.username,
      name: user.displayName || user.username,
      ttl: '6h',
    });
    
    at.addGrant({ 
      roomJoin: true, 
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    res.json({ token, url: LIVEKIT_URL });
  } catch (error) {
    console.error('Token error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// ============================================================
// ONLINE TRACKING
// ============================================================
app.post('/api/online/join', verifyToken, async (req, res) => {
  const { roomId } = req.body;
  const username = req.user.username;

  onlineUsers.set(username, { roomId, lastSeen: Date.now() });

  if (!roomOnlineCount[roomId]) roomOnlineCount[roomId] = 0;
  roomOnlineCount[roomId]++;

  res.json({ success: true });
});

app.post('/api/online/leave', verifyToken, async (req, res) => {
  const username = req.user.username;
  const userData = onlineUsers.get(username);

  if (userData) {
    if (roomOnlineCount[userData.roomId] > 0) {
      roomOnlineCount[userData.roomId]--;
    }
    onlineUsers.delete(username);
  }

  res.json({ success: true });
});

app.get('/api/online/rooms-status', verifyToken, async (req, res) => {
  try {
    const rooms = await Room.find();
    const status = rooms.map(room => ({
      roomId: room.roomId,
      roomName: room.roomName,
      onlineCount: roomOnlineCount[room.roomId] || 0,
      users: []
    }));

    for (const [username, data] of onlineUsers.entries()) {
      const room = status.find(r => r.roomId === data.roomId);
      if (room) room.users.push(username);
    }

    res.json({ rooms: status });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// ✅ SOCKET.IO - REMOTE CONTROL SIGNALING + ROOM JOIN/LEAVE SOUND
// ============================================================
const userSockets = new Map(); // { username: socketId }

io.on('connection', (socket) => {
  console.log('🔌 Socket connected:', socket.id);

  // ចុះឈ្មោះ User
  socket.on('register-user', ({ username }) => {
    userSockets.set(username, socket.id);
    socket.username = username;
    // ✅ ចងចាំក្នុង socket.data ដែរ ដើម្បីអោយ room-joined/room-left/disconnect ប្រើបាន
    socket.data.username = username;
    console.log(`✅ Registered: ${username} → ${socket.id}`);
  });

  // ============================================================
  // ✅ NEW: ROOM PRESENCE — Join/Leave Sound Broadcast
  // ============================================================

  // User/Admin ប្រកាសថាកំពុងចូលបន្ទប់មួយ (ស្រាប់ ឬតាម auto-join)
  socket.on('room-joined', ({ roomId, username, displayName }) => {
    if (!roomId || !username) return;
    socket.join('vc-room-' + roomId);
    socket.data.currentRoomId = roomId;
    socket.data.username = username;
    // ជូនដំណឹងទៅអ្នកផ្សេងទៀតទាំងអស់ក្នុងបន្ទប់នេះ (មិនរាប់បញ្ចូលខ្លួនឯង)
    socket.to('vc-room-' + roomId).emit('room-user-joined', { roomId, username, displayName });
    console.log(`👤 ${username} joined room ${roomId} (socket presence)`);
  });

  // User/Admin ប្រកាសថាកំពុងចេញពីបន្ទប់
  socket.on('room-left', ({ roomId, username }) => {
    if (!roomId || !username) return;
    socket.to('vc-room-' + roomId).emit('room-user-left', { roomId, username });
    socket.leave('vc-room-' + roomId);
    if (socket.data.currentRoomId === roomId) {
      socket.data.currentRoomId = null;
    }
    console.log(`👤 ${username} left room ${roomId} (socket presence)`);
  });

  // ============================================================
  // REMOTE CONTROL SIGNALING (មានស្រាប់)
  // ============================================================

  // ✅ Controller ផ្ញើសំណើ
  socket.on('remote-request', ({ targetUsername, controllerName }) => {
    const targetSocketId = userSockets.get(targetUsername);
    if (targetSocketId) {
      io.to(targetSocketId).emit('remote-request-received', {
        controllerName,
        controllerSocketId: socket.id
      });
      console.log(`📨 Remote request: ${controllerName} → ${targetUsername}`);
    } else {
      console.log(`❌ Target not found: ${targetUsername}`);
      io.to(socket.id).emit('remote-rejected-notify');
    }
  });

  // ✅ Target អនុញ្ញាត
  socket.on('remote-approved', ({ controllerSocketId, targetUsername }) => {
    io.to(controllerSocketId).emit('remote-approved-notify', {
      targetUsername,
      targetSocketId: socket.id
    });
    console.log(`✅ Remote approved: ${targetUsername}`);
  });

  // ✅ Target បដិសេធ
  socket.on('remote-rejected', ({ controllerSocketId }) => {
    io.to(controllerSocketId).emit('remote-rejected-notify');
    console.log(`❌ Remote rejected`);
  });

  // ✅ Mouse Move
  socket.on('remote-mouse-move', ({ targetSocketId, x, y }) => {
    io.to(targetSocketId).emit('remote-mouse-move-received', { x, y });
  });

  // ✅ Mouse Click
  socket.on('remote-mouse-click', ({ targetSocketId, x, y, button }) => {
    io.to(targetSocketId).emit('remote-mouse-click-received', { x, y, button });
  });

  // ✅ Keyboard
  socket.on('remote-keyboard', ({ targetSocketId, key }) => {
    io.to(targetSocketId).emit('remote-keyboard-received', { key });
  });

  // ✅ បញ្ចប់
  socket.on('remote-end', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('remote-ended-notify');
    console.log(`🛑 Remote ended`);
  });

  // ============================================================
  // DISCONNECT (merged: remote-control cleanup + room-leave sound)
  // ============================================================
  socket.on('disconnect', () => {
    // ✅ ករណីបិទ tab / បាត់ Internet ដោយមិនចុច "ចាកចេញបន្ទប់"
    // ត្រូវអោយអ្នកផ្សេងក្នុងបន្ទប់លឺសំឡេង Leave ដែរ
    if (socket.data.currentRoomId && socket.data.username) {
      socket.to('vc-room-' + socket.data.currentRoomId).emit('room-user-left', {
        roomId: socket.data.currentRoomId,
        username: socket.data.username
      });
    }

    if (socket.username) {
      userSockets.delete(socket.username);
      console.log(`🔌 Disconnected: ${socket.username}`);
    }
  });
});

// ============================================================
// START SERVER (ប្រើ server មិនមែន app)
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`🎮 Socket.IO Remote Control: Enabled`);
  console.log(`🔊 Room Join/Leave Sound Broadcast: Enabled`);
});
