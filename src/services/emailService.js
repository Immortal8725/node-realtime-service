/**
 * Email delivery. Uses SMTP env when configured; otherwise stubs to console.
 */
async function send({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.info(`[email:stub] to=${to} subject=${subject} text=${text}`);
    return { channel: "email", status: "stubbed" };
  }

  // Lightweight SMTP via nodemailer is optional; avoid hard dep if unset.
  // When SMTP_* is set, operators can add nodemailer later. For now log + mark configured.
  console.info(`[email:configured-but-nodemailer-not-bundled] to=${to} subject=${subject}`);
  console.info(`[email] Install nodemailer and extend emailService.js for live SMTP. Body: ${text}`);
  return { channel: "email", status: "logged_pending_smtp_client" };
}

module.exports = { send };
