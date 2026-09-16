const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// LIVEKIT CONFIGURATION
// ============================================================
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'APIitJucPDF6UUB';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'RMIiHGvrNbGG1sC6KtHIhYfv5egzX9upvmcdPNLVqvQ';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://meeting-86lp77zt.livekit.cloud';

// ============================================================
// API: Generate Token
// ============================================================
app.post('/api/get-token', async (req, res) => {
  const { roomName, participantName } = req.body;

  if (!roomName || !participantName) {
    return res.status(400).json({ 
      error: 'Room name and participant name are required' 
    });
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantName,
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
    console.log(`✅ Token generated for ${participantName} in room ${roomName}`);
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
  console.log(`🌐 Open: http://localhost:${PORT}`);
});
