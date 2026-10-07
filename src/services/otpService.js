const crypto = require("crypto");
const emailService = require("./emailService");
const smsService = require("./smsService");
const whatsappService = require("./whatsappService");
const logger = require("../logger");
const { createOtpStore } = require("./otpStore");

let activeStore = null;
let testStore = null;
let memoryNoted = false;

function ttlSeconds() {
  return Number(process.env.OTP_TTL_SECONDS || 600);
}

function maxAttempts() {
  return Number(process.env.OTP_MAX_ATTEMPTS || 5);
}

function debugMode() {
  return String(process.env.OTP_DEBUG_MODE || "false").toLowerCase() === "true";
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function hashesEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateOtp() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function storageKey({ purpose, to, tenantId }) {
  return `${purpose || "generic"}:${tenantId || "x"}:${String(to).trim().toLowerCase()}`;
}

function otpStoreMode(env = process.env) {
  if (testStore) return testStore.mode;
  const url = String((env && env.REDIS_URL) || "").trim();
  return url ? "redis" : "memory";
}

function getStore() {
  if (testStore) return testStore;
  if (activeStore) return activeStore;
  activeStore = createOtpStore(process.env);
  if (activeStore.mode === "memory" && !memoryNoted) {
    memoryNoted = true;
    logger.warn(
      {},
      "OTP codes are stored in memory on this instance only. Set REDIS_URL to share them across replicas"
    );
  }
  return activeStore;
}

function setOtpStoreForTests(store) {
  testStore = store || null;
}

function safeStoreError(err) {
  const message = err && err.message ? String(err.message) : "redis error";
  if (message.includes("@") || message.includes("://")) return "redis error";
  return message.slice(0, 200);
}

async function withStore(fn) {
  try {
    return await fn(getStore());
  } catch (err) {
    if (err && err.status) throw err;
    logger.error({ err: safeStoreError(err) }, "otp store failed");
    const wrapped = new Error("OTP store unavailable");
    wrapped.status = 503;
    throw wrapped;
  }
}

/**
 * Send OTP via email, SMS (Twilio), or WhatsApp.
 * body: { channel, to, purpose, tenantId, message?, code? }
 * If `code` is provided (Spring), that exact code is delivered and stored for verify.
 */
async function sendOtp({
  channel = "whatsapp",
  to,
  purpose = "generic",
  tenantId,
  message,
  code: providedCode,
}) {
  if (!to) {
    const err = new Error("to is required");
    err.status = 400;
    throw err;
  }

  const code =
    providedCode && String(providedCode).trim()
      ? String(providedCode).trim()
      : generateOtp();

  if (!/^\d{4,8}$/.test(code)) {
    const err = new Error("code must be 4-8 digits when provided");
    err.status = 400;
    throw err;
  }

  const key = storageKey({ purpose, to, tenantId });
  const ttl = ttlSeconds();
  await withStore((store) =>
    store.set(
      key,
      {
        hash: hashOtp(code),
        createdAt: Date.now(),
        attempts: 0,
        meta: { channel, purpose, tenantId },
      },
      ttl
    )
  );

  const mins = Math.max(1, Math.floor(ttl / 60));
  const body =
    message ||
    `DigiMed Connect verification code: ${code}. Valid for ${mins} minutes. Do not share this code.`;

  const ch = String(channel || "whatsapp").toLowerCase();
  let delivery;

  if (ch === "email") {
    delivery = await emailService.send({
      to,
      subject: "Your DigiMed verification code",
      text: body,
      html: `<p>Your DigiMed Connect verification code is:</p>
             <p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p>
             <p>Valid for ${mins} minutes. Do not share this code.</p>`,
    });
  } else if (ch === "sms") {
    delivery = await smsService.send({ to, text: body });
  } else if (ch === "whatsapp") {
    delivery = await whatsappService.send({ to, text: body });
  } else if (ch === "both") {
    delivery = { channel: "both", status: "error", detail: "use separate send calls" };
  } else {
    logger.info({ channel: ch, to: logger.maskDestination(to) }, "otp unknown channel");
    delivery = { channel: ch, status: "stubbed" };
  }

  const out = {
    otpSent: delivery.status === "sent" || delivery.status === "stubbed",
    expiresIn: ttl,
    delivery,
  };
  if (debugMode()) {
    out.debugOtp = code;
  }
  return out;
}

async function verifyOtp({ to, purpose = "generic", tenantId, code }) {
  const key = storageKey({ purpose, to, tenantId });
  return withStore(async (store) => {
    const entry = await store.get(key);
    if (!entry) {
      const err = new Error("No pending code for that destination");
      err.status = 400;
      throw err;
    }
    const remaining = await store.ttl(key);
    if (remaining < 1 || Date.now() - entry.createdAt > ttlSeconds() * 1000) {
      await store.delete(key);
      const err = new Error("Code expired");
      err.status = 400;
      throw err;
    }
    entry.attempts = Number(entry.attempts || 0) + 1;
    if (entry.attempts > maxAttempts()) {
      await store.delete(key);
      const err = new Error("Too many attempts");
      err.status = 400;
      throw err;
    }
    const ok = hashesEqual(entry.hash, hashOtp(code));
    if (!ok) {
      await store.set(key, entry, remaining);
      const err = new Error("Invalid code");
      err.status = 400;
      throw err;
    }
    await store.delete(key);
    return { verified: true };
  });
}

module.exports = {
  sendOtp,
  verifyOtp,
  debugMode,
  otpStoreMode,
  setOtpStoreForTests,
};
