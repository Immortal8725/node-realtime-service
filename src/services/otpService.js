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
  return `${purpose || "generic"}:${tenantId || "x"}:${String(to).trim().toLowerCase()}`;
}

/**
 * Send OTP via email and/or WhatsApp.
 * body: { channel, to, purpose, tenantId, message?, code? }
 * If `code` is provided (Spring Paperless), that exact code is delivered and stored for verify.
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
  pending.set(key, {
    hash: hashOtp(code),
    createdAt: Date.now(),
    attempts: 0,
    meta: { channel, purpose, tenantId },
  });

  const mins = Math.max(1, Math.floor(ttlSeconds() / 60));
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
  } else if (ch === "whatsapp" || ch === "sms") {
    delivery = await whatsappService.send({ to, text: body });
  } else if (ch === "both") {
    // Split "to" as phone|email not supported; use dedicated fields via callers
    delivery = { channel: "both", status: "error", detail: "use separate send calls" };
  } else {
    console.info(`[otp] unknown channel=${ch} to=${to}`);
    delivery = { channel: ch, status: "stubbed" };
  }

  const out = {
    otpSent: delivery.status === "sent" || delivery.status === "stubbed",
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
