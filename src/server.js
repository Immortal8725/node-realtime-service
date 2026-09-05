require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const { socketAuth, requireInternalKey } = require("./middleware/auth");
const otpRoutes = require("./routes/otpRoutes");
const { registerChat } = require("./socket/chat");
const { registerNotifications, pushNotification } = require("./socket/notifications");

const PORT = Number(process.env.PORT || 4001);
const origins = String(process.env.CORS_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const NODE_ENV = process.env.NODE_ENV || "development";
if (NODE_ENV === "production" && String(process.env.OTP_DEBUG_MODE).toLowerCase() === "true") {
  console.error("[realtime] Refusing to start: OTP_DEBUG_MODE=true is forbidden in production");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(
  cors({
    origin: origins,
    credentials: true,
  })
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

let redisEnabled = false;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "node-realtime-service",
    redisAdapter: redisEnabled,
    time: new Date().toISOString(),
  });
});

app.use("/internal/otp", otpRoutes);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: origins,
    credentials: true,
  },
});

app.set("io", io);

app.post("/internal/notify", requireInternalKey, (req, res) => {
  const { target = {}, event = {} } = req.body || {};
  pushNotification(io, target, event);
  res.json({ pushed: true });
});

io.use(socketAuth);

io.on("connection", (socket) => {
  console.info(
    `[socket] connected ${socket.user?.username || "?"} tenant=${socket.user?.tenantId ?? "-"}`
  );
  registerChat(io, socket);
  registerNotifications(io, socket);

  if (socket.user?.userId != null) socket.join(`user:${socket.user.userId}`);
  if (socket.user?.username) socket.join(`user:${socket.user.username}`);
  if (socket.user?.tenantId != null) socket.join(`tenant:${socket.user.tenantId}`);

  socket.on("disconnect", (reason) => {
    console.info(`[socket] disconnect ${socket.user?.username || "?"} (${reason})`);
  });
});

async function setupRedisAdapter() {
  const url = process.env.REDIS_URL;
  if (!url || !String(url).trim()) {
    console.info("[realtime] Redis adapter: off (single-node mode)");
    return;
  }
  try {
    const { createAdapter } = require("@socket.io/redis-adapter");
    const Redis = require("ioredis");
    const pubClient = new Redis(url, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    await Promise.all([
      new Promise((resolve, reject) => {
        pubClient.once("ready", resolve);
        pubClient.once("error", reject);
      }),
      new Promise((resolve, reject) => {
        subClient.once("ready", resolve);
        subClient.once("error", reject);
      }),
    ]);
    io.adapter(createAdapter(pubClient, subClient));
    redisEnabled = true;
    console.info("[realtime] Redis adapter: on (multi-instance ready)");
  } catch (err) {
    console.error("[realtime] Redis adapter failed — continuing single-node:", err.message);
    redisEnabled = false;
  }
}

async function start() {
  await setupRedisAdapter();
  server.listen(PORT, "0.0.0.0", () => {
    console.info(`[realtime] listening on 0.0.0.0:${PORT}`);
    console.info(`[realtime] CORS origins: ${origins.join(", ")}`);
  });
}

start().catch((err) => {
  console.error("[realtime] fatal startup error", err);
  process.exit(1);
});
