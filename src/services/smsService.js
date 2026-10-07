/**
 * Twilio SMS delivery for DigiMed OTP.
 *
 * Required:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_SMS_FROM  (E.164, e.g. +18005551234) — or TWILIO_FROM without whatsapp: prefix
 */

const logger = require("../logger");

function providerErrorDetail(raw, status) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.message || parsed.code)) {
      return `provider error ${parsed.code || status}: ${parsed.message || "request failed"}`.slice(0, 300);
    }
  } catch (_) {
    /* plain text */
  }
  return logger.redactString(String(raw || "")).slice(0, 300);
}

function normalizeE164(to) {
  let n = String(to || "").trim().replace(/\s+/g, "");
  if (!n) return n;
  if (/^0\d{9}$/.test(n)) n = `+27${n.slice(1)}`;
  if (!n.startsWith("+") && /^\d{10,15}$/.test(n)) n = `+${n}`;
  return n.replace(/^whatsapp:/i, "");
}

function twilioSmsFrom() {
  const smsFrom = process.env.TWILIO_SMS_FROM || process.env.TWILIO_FROM || "";
  const cleaned = String(smsFrom).trim().replace(/^whatsapp:/i, "");
  if (cleaned.startsWith("+") || /^\d{10,15}$/.test(cleaned)) return cleaned;
  return "";
}

function isConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      twilioSmsFrom()
  );
}

async function send({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = twilioSmsFrom();

  if (!sid || !token || !from) {
    logger.info({ to: logger.maskDestination(to) }, "sms stub");
    return {
      channel: "sms",
      status: "stubbed",
      reason: "twilio sms not configured",
    };
  }

  const bodyTo = normalizeE164(to);
  const bodyFrom = normalizeE164(from);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({
    To: bodyTo,
    From: bodyFrom,
    Body: text,
  });

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const raw = await res.text();
  if (!res.ok) {
    const detail = providerErrorDetail(raw, res.status);
    logger.error({ provider: "twilio", status: res.status, detail }, "sms send failed");
    return { channel: "sms", status: "error", code: res.status, detail };
  }

  let sidOut = null;
  try {
    sidOut = JSON.parse(raw).sid;
  } catch (_) {
    /* ignore */
  }
  logger.info(
    { provider: "twilio", to: logger.maskDestination(bodyTo), sid: sidOut || null },
    "sms sent"
  );
  return { channel: "sms", status: "sent", provider: "twilio", sid: sidOut };
}

module.exports = { send, isConfigured, normalizeE164 };
