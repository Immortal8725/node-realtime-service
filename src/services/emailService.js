/**
 * Email OTP delivery.
 *
 * EMAIL_PROVIDER:
 *   auto (default) — Resend when RESEND_API_KEY and RESEND_FROM are set, otherwise SMTP
 *   resend         — Resend only (RESEND_API_KEY + RESEND_FROM)
 *   smtp           — nodemailer only (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM)
 *
 * SMTP stays available. Selecting Resend does not remove it.
 */
const nodemailer = require("nodemailer");
const logger = require("../logger");

let transporter = null;
let transporterKey = "";

function emailTransport(env = process.env) {
  const explicit = String(env.EMAIL_PROVIDER || "auto").toLowerCase().trim() || "auto";
  const resendReady = Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
  const smtpReady = Boolean(env.SMTP_HOST);

  if (explicit === "resend") return resendReady ? "resend" : "resend-missing";
  if (explicit === "smtp") return smtpReady ? "smtp" : "smtp-missing";
  if (resendReady) return "resend";
  if (smtpReady) return "smtp";
  return "stub";
}

/** Channel name reported on /health: resend | smtp | stub */
function resolveEmailProvider(env = process.env) {
  const transport = emailTransport(env);
  if (transport === "resend" || transport === "smtp") return transport;
  return "stub";
}

function smtpCacheKey(env = process.env) {
  return [
    env.SMTP_HOST || "",
    env.SMTP_PORT || "",
    env.SMTP_SECURE || "",
    env.SMTP_USER || "",
  ].join("|");
}

function getTransporter(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const key = smtpCacheKey(env);
  if (transporter && transporterKey === key) return transporter;

  const port = Number(env.SMTP_PORT || 587);
  const secure = String(env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          }
        : undefined,
  });
  transporterKey = key;
  return transporter;
}

function resetCaches() {
  transporter = null;
  transporterKey = "";
}

async function sendResend({ to, subject, text, html }, env = process.env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM;
  if (!apiKey || !from) {
    return {
      channel: "email",
      status: "error",
      provider: "resend",
      reason: "RESEND_API_KEY and RESEND_FROM are required",
    };
  }

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject || "DigiMed Connect verification",
        text,
        html: html || undefined,
      }),
      signal: AbortSignal.timeout(Number(env.RESEND_TIMEOUT_MS || 15000)),
    });
  } catch (e) {
    logger.error({ provider: "resend", err: e.message }, "email send failed");
    return { channel: "email", status: "error", provider: "resend", detail: "resend request failed" };
  }

  const raw = await res.text();
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (_) {
    parsed = {};
  }

  if (!res.ok) {
    const detail = logger.redactString(String(parsed.message || parsed.name || "resend send failed")).slice(0, 300);
    logger.error({ provider: "resend", status: res.status, detail }, "email send failed");
    return { channel: "email", status: "error", provider: "resend", code: res.status, detail };
  }

  logger.info(
    { provider: "resend", to: logger.maskDestination(to), messageId: parsed.id || null },
    "email sent"
  );
  return {
    channel: "email",
    status: "sent",
    provider: "resend",
    messageId: parsed.id || null,
  };
}

async function sendSmtp({ to, subject, text, html }, env = process.env) {
  const tx = getTransporter(env);
  if (!tx) {
    return {
      channel: "email",
      status: "error",
      provider: "smtp",
      reason: "SMTP_HOST is required",
    };
  }

  const from = env.SMTP_FROM || env.SMTP_USER || "noreply@digimed-connect.co.za";

  try {
    const info = await tx.sendMail({
      from,
      to,
      subject: subject || "DigiMed Connect verification",
      text,
      html: html || undefined,
    });
    logger.info(
      { provider: "smtp", to: logger.maskDestination(to), messageId: info.messageId || null },
      "email sent"
    );
    return {
      channel: "email",
      status: "sent",
      provider: "smtp",
      messageId: info.messageId || null,
    };
  } catch (e) {
    logger.error({ provider: "smtp", err: e.message }, "email send failed");
    return {
      channel: "email",
      status: "error",
      provider: "smtp",
      detail: logger.redactString(e.message).slice(0, 300),
    };
  }
}

async function send(payload, env = process.env) {
  const transport = emailTransport(env);
  if (transport === "resend") return sendResend(payload, env);
  if (transport === "smtp") return sendSmtp(payload, env);
  if (transport === "resend-missing" || transport === "smtp-missing") {
    const provider = transport === "resend-missing" ? "resend" : "smtp";
    logger.error({ provider }, "email provider selected but not configured");
    return {
      channel: "email",
      status: "error",
      provider,
      reason:
        provider === "resend"
          ? "RESEND_API_KEY and RESEND_FROM are required"
          : "SMTP_HOST is required",
    };
  }

  logger.info({ to: logger.maskDestination(payload.to) }, "email stub");
  return { channel: "email", status: "stubbed", reason: "email provider not configured" };
}

module.exports = {
  send,
  emailTransport,
  resolveEmailProvider,
  resetCaches,
};
