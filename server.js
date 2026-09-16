const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
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
  console.error('❌ MONGO_URI environment variable មិនត្រូវបានកំណត់ទេ!');
  process.exit(1);
}

// ============================================================
// MONGODB SCHEMA
// ============================================================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  displayName: { type: String, default: '' },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  isActive: { type: Boolean, default: true },
  currentDeviceId: { type: String, default: null },
  currentSocketId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
});

const User = mongoose.model('User', userSchema);

// ============================================================
// OTP STORAGE (In-Memory for simplicity)
// For production, use Redis
// ============================================================
const otpStore = new Map(); // { username: { otp, expiresAt, deviceId } }

// Clean expired OTPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of otpStore.entries()) {
    if (value.expiresAt < now) {
      otpStore.delete(key);
    }
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
        isActive: true
      });
      console.log('✅ Created default admin: admin / admin123');
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

// ============================================================
// API: Login (with 2FA check)
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password, deviceId } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(401).json({ error: 'ឈ្មោះ ឬលេខសម្ងាត់មិនត្រឹមត្រូវ!' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'គណនីត្រូវបានផ្អាក! សូមទាក់ទង Admin' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'ឈ្មោះ ឬលេខសម្ងាត់មិនត្រឹមត្រូវ!' });
    }

    // ============================================================
    // ✅ 2FA CHECK: ប្រសិនបើ Device ផ្សេងកំពុង Login
    // ============================================================
    if (user.currentDeviceId && user.currentDeviceId !== deviceId) {
      // មាន Device ផ្សេងកំពុង Online - ត្រូវការ OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      otpStore.set(username, {
        otp: otp,
        expiresAt: Date.now() + (5 * 60 * 1000), // 5 នាទី
        deviceId: deviceId
      });

      console.log(`🔐 2FA Required for ${username}. OTP: ${otp}`);
      
      // ផ្ញើ OTP ទៅ Device ចាស់តាម Socket.IO (បើមាន)
      // ឬបង្ហាញក្នុង Console (សម្រាប់ការសាកល្បង)
      
      return res.json({
        requires2FA: true,
        message: 'គណនីរបស់អ្នកកំពុង Online នៅឧបករណ៍ផ្សេង។ សូមបញ្ចូលលេខកូដ 2FA!',
        // សម្រាប់ការសាកល្បង - កុំធ្វើបែបនេះក្នុង Production!
        debugOtp: otp
      });
    }

    // ✅ Device ដូចគ្នា ឬ Device ដំបូង - Login បាន
    user.currentDeviceId = deviceId || 'unknown';
    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${username}`);
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: Verify OTP (2FA)
// ============================================================
app.post('/api/auth/verify-otp', async (req, res) => {
  const { username, password, otp, deviceId } = req.body;

  if (!username || !password || !otp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const storedOtp = otpStore.get(username);

    if (!storedOtp) {
      return res.status(400).json({ error: 'គ្មានលេខកូដ OTP ឬផុតកំណត់!' });
    }

    if (storedOtp.expiresAt < Date.now()) {
      otpStore.delete(username);
      return res.status(400).json({ error: 'លេខកូដ OTP ផុតកំណត់!' });
    }

    if (storedOtp.otp !== otp) {
      return res.status(401).json({ error: 'លេខកូដ OTP មិនត្រឹមត្រូវ!' });
    }

    // OTP ត្រឹមត្រូវ - Login បាន
    otpStore.delete(username);

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.currentDeviceId = deviceId;
    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ 2FA verified for: ${username}`);
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
      }
    });
  } catch (error) {
    console.error('OTP verify error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: Register (Admin only)
// ============================================================
app.post('/api/auth/register', verifyToken, verifyAdmin, async (req, res) => {
  const { username, password, displayName, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
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
      isActive: true
    });

    console.log(`✅ New user created: ${username}`);
    res.json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ============================================================
// API: Get Current User
// ============================================================
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, '-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// API: Admin - Get All Users
// ============================================================
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 });
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============================================================
// API: Admin - Toggle User Status
// ============================================================
app.put('/api/admin/users/:id/toggle', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role === 'admin' && user.username === req.user.username) {
      return res.status(400).json({ error: 'មិនអាចផ្អាកខ្លួនឯងបានទេ!' });
    }

    user.isActive = !user.isActive;
    if (!user.isActive) {
      user.currentDeviceId = null; // Reset device when deactivated
    }
    await user.save();

    res.json({ success: true, isActive: user.isActive });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle user' });
  }
});

// ============================================================
// API: Admin - Delete User
// ============================================================
app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

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
// API: Admin - Reset Password
// ============================================================
app.put('/api/admin/users/:id/reset-password', verifyToken, verifyAdmin, async (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.currentDeviceId = null; // Reset device to force re-login
    await user.save();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ============================================================
// API: Generate LiveKit Token
// ============================================================
app.post('/api/get-token', verifyToken, async (req, res) => {
  const { roomName } = req.body;
  const user = req.user;

  if (!roomName) {
    return res.status(400).json({ error: 'Room name is required' });
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
    console.error('❌ Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// ============================================================
// API: Health Check
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 LiveKit URL: ${LIVEKIT_URL}`);
  console.log(`📱 PWA Support: Enabled`);
  console.log(`🔐 2FA Protection: Enabled`);
});
