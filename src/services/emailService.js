/**
 * Email delivery via SMTP (nodemailer).
 *
 * Env:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true|false)
 *   SMTP_USER, SMTP_PASS, SMTP_FROM
 */
const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          }
        : undefined,
  });
  return transporter;
}

async function send({ to, subject, text, html }) {
  const tx = getTransporter();
  if (!tx) {
    console.info(`[email:stub] to=${to} subject=${subject}`);
    return { channel: "email", status: "stubbed", reason: "SMTP_HOST not set" };
  }

  const from =
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "noreply@digimed-connect.co.za";

  try {
    const info = await tx.sendMail({
      from,
      to,
      subject: subject || "DigiMed Connect verification",
      text,
      html: html || undefined,
    });
    console.info(`[email] sent to=${to} id=${info.messageId || "?"}`);
    return {
      channel: "email",
      status: "sent",
      messageId: info.messageId || null,
    };
  } catch (e) {
    console.error("[email] send failed", e.message);
    return { channel: "email", status: "error", detail: e.message };
  }
}

module.exports = { send };
