/**
 * WhatsApp / SMS delivery. Calls WHATSAPP_API_URL when set; otherwise stubs.
 * Compatible with Africa's Talking / Twilio-style gateway wrappers later.
 */
async function send({ to, text }) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;

  if (!url || !token) {
    console.info(`[whatsapp:stub] to=${to} text=${text}`);
    return { channel: "whatsapp", status: "stubbed" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, message: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[whatsapp] provider error ${res.status}: ${body}`);
      return { channel: "whatsapp", status: "error", code: res.status };
    }
    return { channel: "whatsapp", status: "sent" };
  } catch (e) {
    console.error("[whatsapp] send failed", e.message);
    return { channel: "whatsapp", status: "error", detail: e.message };
  }
}

module.exports = { send };
