require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const { socketAuth, requireInternalKey } = require("./middleware/auth");
const otpRoutes = require("./routes/otpRoutes");
const { registerChat } = require("./socket/chat");
const { registerNotifications, pushNotification } = require("./socket/notifications");
const { isOriginAllowed, validateConfig, resolveAllowedOrigins, resolveTrustProxy } = require("./config");
const logger = require("./logger");
const { resolveEmailProvider } = require("./services/emailService");
const { otpStoreMode } = require("./services/otpService");
const pkg = require("../package.json");

const PORT = Number(process.env.PORT || 4001);
const JSON_LIMIT = process.env.JSON_BODY_LIMIT || "100kb";

/** Runtime adapter state. /health and /ready read this; they never include secrets. */
const runtime = {
  redis: "off",
};

function corsOriginDelegate(origins) {
  return function originDelegate(origin, callback) {
    if (isOriginAllowed(origin, origins)) return callback(null, true);
    return callback(null, false);
  };
}

function deliverySnapshot() {
  const smtpOrResend = resolveEmailProvider();
  const waProvider = String(process.env.WHATSAPP_PROVIDER || "").toLowerCase().trim();
  let whatsapp = "stub";
  if (waProvider === "baileys") whatsapp = "baileys";
  else if (waProvider === "twilio" || process.env.TWILIO_ACCOUNT_SID) whatsapp = "twilio";
  else if (waProvider === "meta" || process.env.WHATSAPP_PHONE_NUMBER_ID) whatsapp = "meta";
  else if (process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN) whatsapp = "generic";

  let sms = "stub";
  try {
    const smsService = require("./services/smsService");
    if (smsService.isConfigured()) sms = "twilio";
  } catch (_) {
    /* ignore */
  }

  const delivery = {
    email: smtpOrResend,
    sms,
    whatsapp,
    internalKeyConfigured: Boolean(process.env.INTERNAL_API_KEY && process.env.INTERNAL_API_KEY.length >= 16),
    otpDebugMode: String(process.env.OTP_DEBUG_MODE || "false").toLowerCase() === "true",
  };

  if (whatsapp === "baileys") {
    try {
      const baileysService = require("./services/baileysService");
      const st = baileysService.getStatus();
      delivery.baileys = {
        status: st.status,
        connected: st.connected,
        linkedPhone: st.linkedPhone,
        hasQr: st.hasQr,
      };
    } catch (_) {
      delivery.baileys = { status: "error" };
    }
  }

  return delivery;
}

function readinessBody() {
  const jwtOk = String(process.env.JWT_SECRET || "").length >= 32;
  const keyOk = String(process.env.INTERNAL_API_KEY || "").length >= 16;
  const redisUrl = Boolean(process.env.REDIS_URL && String(process.env.REDIS_URL).trim());
  const redis = !redisUrl ? "off" : runtime.redis === "connected" ? "connected" : "unavailable";
  const ready = jwtOk && keyOk && redis !== "unavailable";
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? "ready" : "not_ready",
      service: "node-realtime-service",
      checks: {
        jwtSecretConfigured: jwtOk,
        internalKeyConfigured: keyOk,
        redis,
      },
    },
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function buildLimiter(limit) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
    // Default key is req.ip passed through ipKeyGenerator. With trust proxy set
    // to a hop count, that is the right-most untrusted hop, not X-Forwarded-For[0].
    skip: () => process.env.NODE_ENV === "test" || process.env.RATE_LIMIT_DISABLED === "true",
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode || 0);
  if (status === 413 || err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  if (err instanceof SyntaxError && status === 400) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  logger.error({ path: req.path, err: err.message }, "request failed");
  return res.status(500).json({ error: "Internal error" });
}

function createApp() {
  const origins = resolveAllowedOrigins();
  const app = express();
  const server = http.createServer(app);

  // Hop count, never boolean true. req.ip is then the right-most untrusted
  // X-Forwarded-For address. Railway's edge is one proxy.
  const trustProxy = resolveTrustProxy();
  app.set("trust proxy", trustProxy === false ? false : trustProxy);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      frameguard: { action: "deny" },
    })
  );

  const internalLimit = positiveInt(process.env.INTERNAL_RATE_LIMIT_PER_MIN, 300);
  const otpSendLimit = positiveInt(process.env.OTP_SEND_RATE_LIMIT_PER_MIN, 30);

  app.use(
    cors({
      origin: corsOriginDelegate(origins),
      credentials: true,
    })
  );
  app.use("/internal", buildLimiter(internalLimit));
  app.post("/internal/otp/send", buildLimiter(otpSendLimit));

  app.use(express.json({ limit: JSON_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_LIMIT }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "node-realtime-service",
    });
  });

  app.get("/internal/health", requireInternalKey, (_req, res) => {
    res.json({
      status: "ok",
      service: "node-realtime-service",
      version: pkg.version,
      uptimeSeconds: Math.floor(process.uptime()),
      redisAdapter: runtime.redis === "connected",
      redis: runtime.redis,
      otpStore: otpStoreMode(),
      delivery: deliverySnapshot(),
      time: new Date().toISOString(),
    });
  });

  app.get("/ready", (_req, res) => {
    const ready = readinessBody();
    res.status(ready.statusCode).json(ready.body);
  });

  app.use("/internal/otp", otpRoutes);

  /** Baileys pairing status + QR (protected). QR is not exposed on /health. */
  app.get("/internal/whatsapp/status", requireInternalKey, (_req, res) => {
    const baileysService = require("./services/baileysService");
    res.json(baileysService.getStatus());
  });

  const io = new Server(server, {
    cors: {
      origin: corsOriginDelegate(origins),
      credentials: true,
    },
  });

  app.set("io", io);

  app.post("/internal/notify", requireInternalKey, (req, res) => {
    const { target = {}, event = {} } = req.body || {};
    pushNotification(io, target, event);
    res.json({ pushed: true });
  });

  app.use(errorHandler);

  io.use((socket, next) => {
    const origin = socket.handshake.headers?.origin;
    if (!isOriginAllowed(origin, origins)) {
      return next(new Error("Origin not allowed"));
    }
    return next();
  });

  io.use(socketAuth);

  io.on("connection", (socket) => {
    logger.info(
      {
        username: socket.user?.username || "?",
        tenantId: socket.user?.tenantId ?? null,
      },
      "socket connected"
    );
    registerChat(io, socket);
    registerNotifications(io, socket);

    if (socket.user?.userId != null) socket.join(`user:${socket.user.userId}`);
    if (socket.user?.username) socket.join(`user:${socket.user.username}`);
    if (socket.user?.tenantId != null) socket.join(`tenant:${socket.user.tenantId}`);

    socket.on("disconnect", (reason) => {
      logger.info(
        { username: socket.user?.username || "?", reason },
        "socket disconnect"
      );
    });
  });

  return { app, server, io, origins };
}

function redisLogTarget(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "rediss:" ? "6380" : "6379");
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch (_) {
    return "configured";
  }
}

function waitForReady(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (client.status === "ready") return resolve();
    const timer = setTimeout(() => reject(new Error("redis ready timeout")), timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      client.off("error", onError);
      resolve();
    };
    const onError = (err) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      reject(err);
    };
    client.once("ready", onReady);
    client.once("error", onError);
  });
}

async function shutdownRedis(pubClient, subClient) {
  for (const client of [pubClient, subClient]) {
    if (!client) continue;
    try {
      await client.quit();
    } catch (_) {
      client.disconnect();
    }
  }
}

async function setupRedisAdapter(io) {
  const url = process.env.REDIS_URL;
  if (!url || !String(url).trim()) {
    runtime.redis = "off";
    logger.info({}, "redis adapter off (single-node mode)");
    return;
  }

  runtime.redis = "unavailable";
  const timeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000);
  let pubClient;
  let subClient;
  try {
    const { createAdapter } = require("@socket.io/redis-adapter");
    const Redis = require("ioredis");
    const options = {
      maxRetriesPerRequest: null,
      connectionName: "digimed-realtime",
      connectTimeout: timeoutMs,
    };
    pubClient = new Redis(url, options);
    subClient = pubClient.duplicate();
    pubClient.on("error", (err) => {
      logger.error({ role: "pub", err: err.message }, "redis client error");
    });
    subClient.on("error", (err) => {
      logger.error({ role: "sub", err: err.message }, "redis client error");
    });
    pubClient.on("ready", () => {
      runtime.redis = "connected";
    });
    pubClient.on("close", () => {
      if (runtime.redis === "connected") runtime.redis = "unavailable";
    });

    await Promise.all([waitForReady(pubClient, timeoutMs), waitForReady(subClient, timeoutMs)]);
    io.adapter(createAdapter(pubClient, subClient));
    runtime.redis = "connected";
    logger.info({ target: redisLogTarget(url) }, "redis adapter on (multi-instance ready)");
  } catch (err) {
    runtime.redis = "unavailable";
    await shutdownRedis(pubClient, subClient);
    const production = (process.env.NODE_ENV || "development") === "production";
    if (production) {
      logger.error({ err: err.message, target: redisLogTarget(url) }, "redis adapter failed");
      throw new Error("REDIS_URL is set but the Redis adapter failed to connect");
    }
    logger.error(
      { err: err.message, target: redisLogTarget(url) },
      "redis adapter failed — continuing single-node"
    );
  }
}

async function start() {
  const { errors, warnings } = validateConfig();
  warnings.forEach((message) => logger.warn({ event: "config" }, message));
  if (errors.length) {
    errors.forEach((message) => logger.error({ event: "config" }, message));
    process.exit(1);
  }

  const ctx = createApp();
  await setupRedisAdapter(ctx.io);

  const whatsappProvider = String(process.env.WHATSAPP_PROVIDER || "").toLowerCase().trim();
  if (whatsappProvider === "baileys" && process.env.REDIS_URL && String(process.env.REDIS_URL).trim()) {
    logger.warn(
      {},
      "Baileys stays single-process; keep one replica even when Redis fans out Socket.IO"
    );
  }

  if (whatsappProvider === "baileys") {
    try {
      const baileysService = require("./services/baileysService");
      await baileysService.start();
    } catch (err) {
      logger.error({ err: err.message }, "baileys failed to start");
    }
  }

  await new Promise((resolve) => ctx.server.listen(PORT, "0.0.0.0", resolve));
  const bound = ctx.server.address();
  const otpStore = otpStoreMode();
  if (otpStore === "memory") {
    logger.warn(
      {},
      "OTP codes are stored in memory on this instance only. Set REDIS_URL to share them across replicas"
    );
  }
  logger.info(
    {
      port: bound && typeof bound === "object" ? bound.port : PORT,
      origins: ctx.origins,
      email: resolveEmailProvider(),
      version: pkg.version,
      otpStore,
      trustProxy: resolveTrustProxy(),
    },
    "listening"
  );
}

if (require.main === module) {
  start().catch((err) => {
    logger.error({ err: err.message }, "fatal startup error");
    process.exit(1);
  });
}

module.exports = {
  createApp,
  start,
  runtime,
};
