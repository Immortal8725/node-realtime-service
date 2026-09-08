/**
 * DigiMed WhatsApp OTP delivery via Baileys (unofficial WhatsApp Web multi-device).
 *
 * Env:
 *   WHATSAPP_PROVIDER=baileys
 *   BAILEYS_AUTH_DIR=./data/baileys-auth   (persist session; use a volume in prod)
 *   BAILEYS_PRINT_QR=true                 (print QR in console for pairing)
 *
 * Pair once: watch logs / GET /internal/whatsapp/status for qr, scan with clinic phone.
 * Keep a single replica — one WhatsApp session cannot be shared across processes.
 */

const fs = require("fs");
const path = require("path");

let sock = null;
let starting = null;
let lastQr = null;
let connectionStatus = "idle"; // idle | connecting | qr | open | close
let linkedPhone = null;
let lastError = null;

function authDir() {
  const raw = process.env.BAILEYS_AUTH_DIR || "./data/baileys-auth";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function printQrEnabled() {
  return String(process.env.BAILEYS_PRINT_QR || "true").toLowerCase() !== "false";
}

function isEnabled() {
  return String(process.env.WHATSAPP_PROVIDER || "").toLowerCase().trim() === "baileys";
}

function toDigits(phone) {
  let n = String(phone || "").trim().replace(/[\s-]/g, "");
  if (/^0\d{9}$/.test(n)) n = `27${n.slice(1)}`;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("whatsapp:")) n = n.replace(/^whatsapp:/, "").replace(/^\+/, "");
  return n.replace(/\D/g, "");
}

function toJid(phone) {
  const digits = toDigits(phone);
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

async function loadBaileys() {
  // Baileys 7+ is ESM-only; load dynamically from this CommonJS service.
  const mod = await import("@whiskeysockets/baileys");
  return {
    makeWASocket: mod.default || mod.makeWASocket,
    useMultiFileAuthState: mod.useMultiFileAuthState,
    DisconnectReason: mod.DisconnectReason,
    fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: mod.makeCacheableSignalKeyStore,
  };
}

function getStatus() {
  return {
    provider: "baileys",
    enabled: isEnabled(),
    status: connectionStatus,
    connected: connectionStatus === "open" && Boolean(sock),
    linkedPhone: linkedPhone || null,
    hasQr: Boolean(lastQr),
    qr: connectionStatus === "qr" ? lastQr : null,
    authDir: authDir(),
    lastError: lastError || null,
  };
}

async function start() {
  if (!isEnabled()) {
    connectionStatus = "idle";
    return getStatus();
  }
  if (sock && connectionStatus === "open") return getStatus();
  if (starting) return starting;

  starting = (async () => {
    connectionStatus = "connecting";
    lastError = null;

    const dir = authDir();
    fs.mkdirSync(dir, { recursive: true });

    const {
      makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await loadBaileys();

    const { state, saveCreds } = await useMultiFileAuthState(dir);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      console.info(`[baileys] WA version ${version?.join?.(".") || version}`);
    } catch (e) {
      console.warn("[baileys] fetchLatestBaileysVersion failed, using default:", e.message);
    }

    const silentLogger = {
      level: "silent",
      child() {
        return this;
      },
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
    };

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore
          ? makeCacheableSignalKeyStore(state.keys, silentLogger)
          : state.keys,
      },
      printQRInTerminal: false,
      logger: silentLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update || {};

      if (qr) {
        lastQr = qr;
        connectionStatus = "qr";
        console.info("[baileys] Scan QR with the clinic WhatsApp (Linked devices).");
        console.info("[baileys] QR also available at GET /internal/whatsapp/status (X-Internal-Key).");
        if (printQrEnabled()) {
          try {
            const qrcode = require("qrcode-terminal");
            qrcode.generate(qr, { small: true });
          } catch (_) {
            console.info("[baileys] qrcode-terminal unavailable; use /internal/whatsapp/status");
          }
        }
      }

      if (connection === "open") {
        lastQr = null;
        connectionStatus = "open";
        linkedPhone =
          sock?.user?.id?.split?.(":")?.[0] ||
          sock?.user?.id?.split?.("@")?.[0] ||
          null;
        console.info(`[baileys] connected as ${linkedPhone || "unknown"}`);
      }

      if (connection === "close") {
        connectionStatus = "close";
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.status ||
          null;
        const loggedOut =
          statusCode === DisconnectReason?.loggedOut ||
          statusCode === 401;
        lastError = lastDisconnect?.error?.message || `closed status=${statusCode}`;
        sock = null;
        console.warn(`[baileys] connection closed: ${lastError}`);

        if (!loggedOut && isEnabled()) {
          console.info("[baileys] reconnecting in 3s…");
          setTimeout(() => {
            starting = null;
            start().catch((e) => console.error("[baileys] reconnect failed", e.message));
          }, 3000);
        } else if (loggedOut) {
          console.error("[baileys] logged out — delete auth dir and scan a new QR");
        }
      }
    });

    starting = null;
    return getStatus();
  })().catch((e) => {
    starting = null;
    sock = null;
    connectionStatus = "close";
    lastError = e.message;
    console.error("[baileys] start failed", e);
    throw e;
  });

  return starting;
}

async function ensureReady() {
  if (!isEnabled()) {
    return { ok: false, detail: "WHATSAPP_PROVIDER is not baileys" };
  }
  if (!sock || connectionStatus !== "open") {
    await start();
  }
  if (!sock || connectionStatus !== "open") {
    return {
      ok: false,
      detail:
        connectionStatus === "qr"
          ? "Baileys waiting for QR scan (see /internal/whatsapp/status)"
          : `Baileys not connected (status=${connectionStatus})`,
      status: getStatus(),
    };
  }
  return { ok: true };
}

async function send({ to, text }) {
  const ready = await ensureReady();
  if (!ready.ok) {
    return {
      channel: "whatsapp",
      status: "error",
      provider: "baileys",
      detail: ready.detail,
    };
  }

  const jid = toJid(to);
  if (!jid) {
    return {
      channel: "whatsapp",
      status: "error",
      provider: "baileys",
      detail: "invalid phone number",
    };
  }

  try {
    if (typeof sock.onWhatsApp === "function") {
      const check = await sock.onWhatsApp(jid.replace(/@s\.whatsapp\.net$/, ""));
      const entry = Array.isArray(check) ? check[0] : check;
      if (entry && entry.exists === false) {
        return {
          channel: "whatsapp",
          status: "error",
          provider: "baileys",
          detail: "number is not on WhatsApp",
        };
      }
      if (entry?.jid) {
        await sock.sendMessage(entry.jid, { text: String(text) });
      } else {
        await sock.sendMessage(jid, { text: String(text) });
      }
    } else {
      await sock.sendMessage(jid, { text: String(text) });
    }

    console.info(`[baileys] sent OTP to=${jid}`);
    return { channel: "whatsapp", status: "sent", provider: "baileys", to: jid };
  } catch (e) {
    console.error(`[baileys] send failed to=${jid}`, e.message);
    return {
      channel: "whatsapp",
      status: "error",
      provider: "baileys",
      detail: e.message,
    };
  }
}

module.exports = {
  isEnabled,
  start,
  send,
  getStatus,
  toJid,
};
