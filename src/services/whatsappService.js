/**
 * WhatsApp / SMS delivery.
 *
 * Providers (WHATSAPP_PROVIDER):
 *   - twilio  → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886)
 *   - meta    → Meta Cloud API: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 *   - generic → WHATSAPP_API_URL + WHATSAPP_API_TOKEN (JSON POST { to, message })
 *
 * Phone numbers should be E.164 (+27...) when possible.
 */

function normalizeWhatsAppTo(to, { twilioPrefix = false } = {}) {
  let n = String(to || "").trim().replace(/\s+/g, "");
  if (!n) return n;
  // SA local 0xx → +27xx
  if (/^0\d{9}$/.test(n)) n = `+27${n.slice(1)}`;
  if (!n.startsWith("+") && /^\d{10,15}$/.test(n)) n = `+${n}`;
  if (twilioPrefix && !n.startsWith("whatsapp:")) n = `whatsapp:${n}`;
  return n;
}

async function sendTwilio({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    return {
      channel: "whatsapp",
      status: "error",
      detail: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM required",
    };
  }

  const useWa =
    String(from).startsWith("whatsapp:") ||
    String(process.env.TWILIO_CHANNEL || "whatsapp").toLowerCase() === "whatsapp";

  const bodyFrom = useWa
    ? String(from).startsWith("whatsapp:")
      ? from
      : `whatsapp:${from.replace(/^whatsapp:/, "")}`
    : String(from).replace(/^whatsapp:/, "");

  const bodyTo = useWa
    ? normalizeWhatsAppTo(to, { twilioPrefix: true })
    : normalizeWhatsAppTo(to);

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
    console.error(`[whatsapp:twilio] ${res.status} ${raw}`);
    return { channel: "whatsapp", status: "error", code: res.status, detail: raw.slice(0, 300) };
  }
  let sidOut = null;
  try {
    sidOut = JSON.parse(raw).sid;
  } catch (_) {
    /* ignore */
  }
  console.info(`[whatsapp:twilio] sent to=${bodyTo} sid=${sidOut || "?"}`);
  return { channel: "whatsapp", status: "sent", provider: "twilio", sid: sidOut };
}

async function sendMeta({ to, text }) {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_API_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return {
      channel: "whatsapp",
      status: "error",
      detail: "WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID required for meta provider",
    };
  }

  const dest = normalizeWhatsAppTo(to).replace(/^\+/, "");
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  // Prefer template if configured (required for first contact outside 24h window)
  const template = process.env.WHATSAPP_TEMPLATE_NAME;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || "en";

  let payload;
  if (template) {
    // OTP digit as body param {{1}} — template must be approved in Meta
    const codeMatch = String(text).match(/\b(\d{4,8})\b/);
    payload = {
      messaging_product: "whatsapp",
      to: dest,
      type: "template",
      template: {
        name: template,
        language: { code: templateLang },
        components: codeMatch
          ? [
              {
                type: "body",
                parameters: [{ type: "text", text: codeMatch[1] }],
              },
            ]
          : [],
      },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      to: dest,
      type: "text",
      text: { body: text },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`[whatsapp:meta] ${res.status} ${raw}`);
    return { channel: "whatsapp", status: "error", code: res.status, detail: raw.slice(0, 300) };
  }
  console.info(`[whatsapp:meta] sent to=${dest}`);
  return { channel: "whatsapp", status: "sent", provider: "meta" };
}

async function sendGeneric({ to, text }) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  if (!url || !token) {
    console.info(`[whatsapp:stub] to=${to} text=${text}`);
    return { channel: "whatsapp", status: "stubbed", reason: "no provider configured" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: normalizeWhatsAppTo(to), message: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[whatsapp:generic] ${res.status}: ${body}`);
    return { channel: "whatsapp", status: "error", code: res.status };
  }
  return { channel: "whatsapp", status: "sent", provider: "generic" };
}

async function send({ to, text }) {
  const provider = String(process.env.WHATSAPP_PROVIDER || "").toLowerCase().trim();

  try {
    if (provider === "twilio" || (!provider && process.env.TWILIO_ACCOUNT_SID)) {
      return await sendTwilio({ to, text });
    }
    if (provider === "meta" || (!provider && process.env.WHATSAPP_PHONE_NUMBER_ID)) {
      return await sendMeta({ to, text });
    }
    if (process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN) {
      return await sendGeneric({ to, text });
    }
    console.info(`[whatsapp:stub] to=${to} (set WHATSAPP_PROVIDER=twilio|meta or WHATSAPP_API_URL)`);
    return { channel: "whatsapp", status: "stubbed", reason: "no provider configured" };
  } catch (e) {
    console.error("[whatsapp] send failed", e.message);
    return { channel: "whatsapp", status: "error", detail: e.message };
  }
}

module.exports = { send, normalizeWhatsAppTo };
