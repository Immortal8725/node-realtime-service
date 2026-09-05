const crypto = require("crypto");
const emailService = require("./emailService");
const whatsappService = require("./whatsappService");

const pending = new Map(); // key -> { hash, createdAt, attempts, meta }

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

function generateOtp() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

function storageKey({ purpose, to, tenantId }) {
  return `${purpose || "generic"}:${tenantId || "x"}:${String(to).trim()}`;
}

async function sendOtp({ channel = "whatsapp", to, purpose = "generic", tenantId, message }) {
  if (!to) {
    const err = new Error("to is required");
    err.status = 400;
    throw err;
  }

  const code = generateOtp();
  const key = storageKey({ purpose, to, tenantId });
  pending.set(key, {
    hash: hashOtp(code),
    createdAt: Date.now(),
    attempts: 0,
    meta: { channel, purpose, tenantId },
  });

  const body =
    message ||
    `DigiMed Connect verification code: ${code}. Valid for ${Math.floor(ttlSeconds() / 60)} minutes.`;

  let delivery = { channel, status: "stubbed" };
  const ch = String(channel).toLowerCase();
  if (ch === "email") {
    delivery = await emailService.send({ to, subject: "Your DigiMed verification code", text: body });
  } else if (ch === "whatsapp" || ch === "sms") {
    delivery = await whatsappService.send({ to, text: body });
  } else {
    console.info(`[otp] channel=${ch} to=${to} purpose=${purpose} (logged only)`);
  }

  const out = {
    otpSent: true,
    expiresIn: ttlSeconds(),
    delivery,
  };
  if (debugMode()) {
    out.debugOtp = code;
  }
  return out;
}

function verifyOtp({ to, purpose = "generic", tenantId, code }) {
  const key = storageKey({ purpose, to, tenantId });
  const entry = pending.get(key);
  if (!entry) {
    const err = new Error("No pending code for that destination");
    err.status = 400;
    throw err;
  }
  if (Date.now() - entry.createdAt > ttlSeconds() * 1000) {
    pending.delete(key);
    const err = new Error("Code expired");
    err.status = 400;
    throw err;
  }
  entry.attempts += 1;
  if (entry.attempts > maxAttempts()) {
    pending.delete(key);
    const err = new Error("Too many attempts");
    err.status = 400;
    throw err;
  }
  const ok = entry.hash === hashOtp(code);
  if (!ok) {
    const err = new Error("Invalid code");
    err.status = 400;
    throw err;
  }
  pending.delete(key);
  return { verified: true };
}

module.exports = { sendOtp, verifyOtp, debugMode };
