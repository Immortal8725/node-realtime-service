const http = require("http");
const path = require("path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.OTP_DEBUG_MODE = "false";
process.env.JWT_SECRET = "test-jwt-secret-must-be-at-least-32-characters-long";
process.env.INTERNAL_API_KEY = "test-internal-key-32chars-minimum";
process.env.CORS_ORIGINS = [
  "https://digimed-connect.co.za",
  "https://www.digimed-connect.co.za",
  "https://*.vercel.app",
  "http://localhost:3000",
].join(",");
for (const name of [
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "EMAIL_PROVIDER",
  "REDIS_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
  "TWILIO_FROM",
  "WHATSAPP_PROVIDER",
  "WHATSAPP_API_URL",
  "WHATSAPP_API_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_TOKEN",
]) {
  delete process.env[name];
}

const { io: ioClient } = require("socket.io-client");
const { createApp } = require("../src/server");
const {
  validateConfig,
  isOriginAllowed,
  parseOrigins,
  resolveAllowedOrigins,
  resolveTrustProxy,
  DEFAULT_ORIGINS,
} = require("../src/config");
const { redact } = require("../src/logger");
const { verifyToken } = require("../src/middleware/auth");
const emailService = require("../src/services/emailService");
const otpService = require("../src/services/otpService");
const { createMemoryOtpStore, createRedisOtpStore, createOtpStore, KEY_PREFIX } = require("../src/services/otpStore");
const { authorizeAppointment, resetAppointmentAccessCache } = require("../src/socket/appointmentAccess");

const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

function request(server, { method = "GET", path: reqPath = "/", headers = {}, body = null } = {}) {
  const payload =
    body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: reqPath,
        method,
        headers: {
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const ctx = createApp();
  await new Promise((resolve) => ctx.server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(ctx);
  } finally {
    await new Promise((resolve) => ctx.server.close(() => resolve()));
    ctx.io.close();
  }
}

test("public health is minimal and internal health keeps delivery details", async () => {
  const previous = {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_SMS_FROM: process.env.TWILIO_SMS_FROM,
    WHATSAPP_PROVIDER: process.env.WHATSAPP_PROVIDER,
  };
  process.env.TWILIO_ACCOUNT_SID = "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.TWILIO_AUTH_TOKEN = "twilio-auth-token";
  process.env.TWILIO_SMS_FROM = "+27110000000";
  process.env.WHATSAPP_PROVIDER = "twilio";
  try {
    await withServer(async ({ server }) => {
      const res = await request(server, {
        path: "/health",
        headers: {
          Origin: "https://www.digimed-connect.co.za",
          "x-internal-key": INTERNAL_KEY,
        },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { status: "ok", service: "node-realtime-service" });
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["access-control-allow-origin"], "https://www.digimed-connect.co.za");
      assert.equal(/twilio|stub|baileys|resend|delivery|redis/i.test(res.text), false);
      assert.equal(res.text.includes(INTERNAL_KEY), false);
      assert.equal(res.text.includes(JWT_SECRET), false);

      const denied = await request(server, { path: "/internal/health" });
      assert.equal(denied.status, 401);

      const details = await request(server, {
        path: "/internal/health",
        headers: { "x-internal-key": INTERNAL_KEY },
      });
      assert.equal(details.status, 200);
      assert.equal(details.json.version, "1.2.0");
      assert.equal(typeof details.json.uptimeSeconds, "number");
      assert.equal(details.json.redis, "off");
      assert.equal(details.json.otpStore, "memory");
      assert.equal(details.json.delivery.email, "stub");
      assert.equal(details.json.delivery.sms, "twilio");
      assert.equal(details.json.delivery.whatsapp, "twilio");
      assert.equal(details.json.delivery.internalKeyConfigured, true);
      assert.equal(details.text.includes(INTERNAL_KEY), false);
      assert.equal(details.text.includes("twilio-auth-token"), false);
      assert.equal(JSON.stringify(details.json).includes("qr"), false);

      const preview = await request(server, {
        path: "/health",
        headers: { Origin: "https://healthcare-frontend-git-main-team.vercel.app" },
      });
      assert.equal(preview.headers["access-control-allow-origin"], undefined);

      const socketDenied = await request(server, {
        path: "/socket.io/?EIO=4&transport=polling",
        headers: { Origin: "https://evil.vercel.app" },
      });
      assert.equal(socketDenied.headers["access-control-allow-origin"], undefined);

      const socketAllowed = await request(server, {
        path: "/socket.io/?EIO=4&transport=polling",
        headers: { Origin: "https://www.digimed-connect.co.za" },
      });
      assert.equal(
        socketAllowed.headers["access-control-allow-origin"],
        "https://www.digimed-connect.co.za"
      );
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("ready reports booleans only", async () => {
  await withServer(async ({ server }) => {
    const res = await request(server, { path: "/ready" });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "ready");
    assert.equal(res.json.checks.jwtSecretConfigured, true);
    assert.equal(res.json.checks.internalKeyConfigured, true);
    assert.equal(res.json.checks.redis, "off");
    assert.equal(res.text.includes(INTERNAL_KEY), false);
    assert.equal(res.text.includes(JWT_SECRET), false);
  });
});

test("internal routes reject a missing or wrong X-Internal-Key", async () => {
  await withServer(async ({ server }) => {
    for (const path of ["/internal/otp/send", "/internal/otp/verify", "/internal/notify"]) {
      const missing = await request(server, {
        method: "POST",
        path,
        body: { to: "person@example.com", channel: "email" },
      });
      assert.equal(missing.status, 401, path);
      assert.equal(missing.json.error, "Unauthorized internal call");

      const wrong = await request(server, {
        method: "POST",
        path,
        headers: { "x-internal-key": "not-the-real-internal-key" },
        body: { to: "person@example.com", channel: "email" },
      });
      assert.equal(wrong.status, 401, path);
    }

    const status = await request(server, { path: "/internal/whatsapp/status" });
    assert.equal(status.status, 401);

    const health = await request(server, { path: "/internal/health" });
    assert.equal(health.status, 401);
  });
});

test("unconfigured internal key fails closed", async () => {
  const previous = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = "short";
  try {
    await withServer(async ({ server }) => {
      const res = await request(server, {
        method: "POST",
        path: "/internal/otp/send",
        headers: { "x-internal-key": "short" },
        body: { channel: "email", to: "person@example.com" },
      });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, "INTERNAL_API_KEY not configured");
      assert.equal(res.text.includes("short"), false);
    });
  } finally {
    process.env.INTERNAL_API_KEY = previous;
  }
});

test("email OTP stub does not return the code", async () => {
  await withServer(async ({ server }) => {
    const res = await request(server, {
      method: "POST",
      path: "/internal/otp/send",
      headers: { "x-internal-key": INTERNAL_KEY },
      body: {
        channel: "email",
        to: "person@example.com",
        purpose: "login",
        tenantId: 4,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.otpSent, true);
    assert.equal(res.json.delivery.channel, "email");
    assert.equal(res.json.delivery.status, "stubbed");
    assert.equal(res.json.debugOtp, undefined);
    assert.equal(JSON.stringify(res.json).includes("verification code"), false);
    assert.equal(res.text.includes(INTERNAL_KEY), false);
  });
});

test("oversized JSON is rejected", async () => {
  await withServer(async ({ server }) => {
    const res = await request(server, {
      method: "POST",
      path: "/internal/notify",
      headers: { "x-internal-key": INTERNAL_KEY },
      body: { event: { text: "x".repeat(120 * 1024) } },
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.error, "Payload too large");
  });
});

test("CORS allows only explicit origins and drops vercel wildcards", () => {
  const origins = [
    "https://digimed-connect.co.za",
    "https://www.digimed-connect.co.za",
    "https://*.vercel.app",
    "http://localhost:3000",
  ].join(",");
  assert.deepEqual(parseOrigins(origins), [
    "https://digimed-connect.co.za",
    "https://www.digimed-connect.co.za",
    "http://localhost:3000",
  ]);
  assert.equal(isOriginAllowed("https://digimed-connect.co.za", origins), true);
  assert.equal(isOriginAllowed("https://www.digimed-connect.co.za", origins), true);
  assert.equal(isOriginAllowed("http://localhost:3000", origins), true);
  assert.equal(
    isOriginAllowed("https://healthcare-frontend-git-main-team.vercel.app", origins),
    false
  );
  assert.equal(isOriginAllowed("https://healthcare-frontend.vercel.app", origins), false);
  assert.equal(isOriginAllowed("https://evil.example", origins), false);
  assert.equal(isOriginAllowed("https://digimed-connect.co.za.evil.com", origins), false);
  assert.equal(isOriginAllowed(undefined, origins), true);
  assert.deepEqual(resolveAllowedOrigins({}), DEFAULT_ORIGINS);
  assert.deepEqual(
    resolveAllowedOrigins({
      ALLOWED_ORIGINS: "https://clinic.example",
      CORS_ORIGINS: "https://other.example,https://*.vercel.app",
    }),
    ["https://clinic.example"]
  );
});

test("production config rejects OTP debug and missing secrets", () => {
  const blocked = validateConfig({
    NODE_ENV: "production",
    OTP_DEBUG_MODE: "true",
    JWT_SECRET: "x".repeat(64),
    INTERNAL_API_KEY: "y".repeat(32),
  });
  assert.ok(blocked.errors.some((message) => message.includes("OTP_DEBUG_MODE")));

  const missing = validateConfig({
    NODE_ENV: "production",
    OTP_DEBUG_MODE: "false",
    JWT_SECRET: "short",
    INTERNAL_API_KEY: "",
    EMAIL_PROVIDER: "resend",
  });
  assert.ok(missing.errors.some((message) => message.includes("JWT_SECRET")));
  assert.ok(missing.errors.some((message) => message.includes("INTERNAL_API_KEY")));
  assert.ok(missing.errors.some((message) => message.includes("RESEND_API_KEY")));

  const dev = validateConfig({ NODE_ENV: "development", OTP_DEBUG_MODE: "true" });
  assert.deepEqual(dev.errors, []);

  const wildcardOnly = validateConfig({
    NODE_ENV: "production",
    OTP_DEBUG_MODE: "false",
    JWT_SECRET: "x".repeat(64),
    INTERNAL_API_KEY: "y".repeat(32),
    ALLOWED_ORIGINS: "https://*.vercel.app",
  });
  assert.ok(wildcardOnly.errors.some((message) => message.includes("ALLOWED_ORIGINS")));
  assert.ok(wildcardOnly.warnings.some((message) => message.includes("*.vercel.app")));
});

test("trust proxy is a hop count and never boolean true", () => {
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "true", NODE_ENV: "production" }), 1);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "1" }), 1);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "2" }), 2);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: "false", NODE_ENV: "production" }), false);
  assert.equal(resolveTrustProxy({ NODE_ENV: "production" }), 1);
  assert.equal(resolveTrustProxy({ NODE_ENV: "development" }), false);
  assert.notEqual(resolveTrustProxy({ TRUST_PROXY: "true" }), true);
});

test("JWT claims stay compatible and unsigned tokens are rejected", () => {
  const token = jwt.sign(
    { sub: "nurse1", tenantId: 7, userId: 3, roles: ["ROLE_NURSE"] },
    JWT_SECRET,
    { algorithm: "HS256" }
  );
  const user = verifyToken(`Bearer ${token}`);
  assert.equal(user.username, "nurse1");
  assert.equal(user.tenantId, 7);
  assert.equal(user.userId, 3);
  assert.deepEqual(user.roles, ["NURSE"]);

  const hs512 = jwt.sign({ sub: "doc", tenantId: "9", roles: ["DOCTOR"] }, JWT_SECRET, {
    algorithm: "HS512",
  });
  assert.equal(verifyToken(hs512).username, "doc");
  assert.equal(verifyToken(hs512).tenantId, 9);

  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "nurse1" })).toString("base64url");
  assert.throws(() => verifyToken(`${header}.${body}.`));
});

test("logger redacts secrets and OTP codes", () => {
  const cleaned = redact({
    code: "123456",
    text: "DigiMed Connect verification code: 123456",
    authorization: "Bearer abc.def.ghi",
    nested: { smtp_pass: "hunter2", note: "verification code: 654321" },
    ok: "listening",
  });
  assert.equal(cleaned.code, "[redacted]");
  assert.equal(cleaned.text, "[redacted]");
  assert.equal(cleaned.authorization, "[redacted]");
  assert.equal(cleaned.nested.smtp_pass, "[redacted]");
  assert.equal(cleaned.nested.note.includes("654321"), false);
  assert.equal(cleaned.ok, "listening");
});

test("auto email prefers Resend and can still select SMTP", async () => {
  emailService.resetCaches();
  const previousFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ id: "email_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const previous = {
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM,
    SMTP_HOST: process.env.SMTP_HOST,
  };
  try {
    process.env.RESEND_API_KEY = "re_testkey12345678";
    process.env.RESEND_FROM = "DigiMed Connect <noreply@digimed-connect.co.za>";
    process.env.SMTP_HOST = "smtp.example.com";
    delete process.env.EMAIL_PROVIDER;
    assert.equal(emailService.resolveEmailProvider(), "resend");

    const sent = await emailService.send({
      to: "person@example.com",
      subject: "Your DigiMed verification code",
      text: "DigiMed Connect verification code: 123456",
      html: "<p>123456</p>",
    });
    assert.equal(sent.status, "sent");
    assert.equal(sent.provider, "resend");
    assert.equal(sent.messageId, "email_123");
    assert.equal(captured.url, "https://api.resend.com/emails");
    assert.equal(captured.options.headers.Authorization, "Bearer re_testkey12345678");
    const payload = JSON.parse(captured.options.body);
    assert.equal(payload.from, process.env.RESEND_FROM);
    assert.deepEqual(payload.to, ["person@example.com"]);
    assert.equal(payload.text.includes("123456"), true);

    process.env.EMAIL_PROVIDER = "smtp";
    assert.equal(emailService.resolveEmailProvider(), "smtp");
    delete process.env.SMTP_HOST;
    const missing = await emailService.send({ to: "person@example.com", text: "123456" });
    assert.equal(missing.status, "error");
    assert.equal(missing.provider, "smtp");
  } finally {
    global.fetch = previousFetch;
    emailService.resetCaches();
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("stored OTP verifies without putting the code in the stub response", async () => {
  const previous = process.env.OTP_DEBUG_MODE;
  process.env.OTP_DEBUG_MODE = "true";
  try {
    const sent = await otpService.sendOtp({
      channel: "email",
      to: "person@example.com",
      purpose: "login",
      tenantId: 4,
    });
    assert.equal(sent.delivery.status, "stubbed");
    assert.match(sent.debugOtp, /^\d{6}$/);
    const verified = await otpService.verifyOtp({
      to: "person@example.com",
      purpose: "login",
      tenantId: 4,
      code: sent.debugOtp,
    });
    assert.equal(verified.verified, true);
  } finally {
    process.env.OTP_DEBUG_MODE = previous;
  }
});

test("otp send rate limit returns 429", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOtp = process.env.OTP_SEND_RATE_LIMIT_PER_MIN;
  const previousInternal = process.env.INTERNAL_RATE_LIMIT_PER_MIN;
  process.env.NODE_ENV = "development";
  process.env.OTP_SEND_RATE_LIMIT_PER_MIN = "2";
  process.env.INTERNAL_RATE_LIMIT_PER_MIN = "100";
  try {
    await withServer(async ({ server }) => {
      const headers = { "x-internal-key": INTERNAL_KEY };
      const body = { channel: "email", to: "person@example.com", purpose: "limit", tenantId: 1 };
      const first = await request(server, { method: "POST", path: "/internal/otp/send", headers, body });
      const second = await request(server, { method: "POST", path: "/internal/otp/send", headers, body });
      const third = await request(server, { method: "POST", path: "/internal/otp/send", headers, body });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
      assert.equal(third.json.error, "Too many requests");
    });
  } finally {
    process.env.NODE_ENV = previousEnv;
    if (previousOtp == null) delete process.env.OTP_SEND_RATE_LIMIT_PER_MIN;
    else process.env.OTP_SEND_RATE_LIMIT_PER_MIN = previousOtp;
    if (previousInternal == null) delete process.env.INTERNAL_RATE_LIMIT_PER_MIN;
    else process.env.INTERNAL_RATE_LIMIT_PER_MIN = previousInternal;
  }
});

test("node src/server.js listens and refuses production OTP debug", async () => {
  const serverPath = path.join(__dirname, "..", "src", "server.js");
  const baseEnv = {
    PATH: process.env.PATH,
    JWT_SECRET,
    INTERNAL_API_KEY: INTERNAL_KEY,
    CORS_ORIGINS: "http://localhost:3000",
    OTP_DEBUG_MODE: "false",
    EMAIL_PROVIDER: "auto",
  };

  const child = spawn(process.execPath, [serverPath], {
    env: { ...baseEnv, NODE_ENV: "development", PORT: "0" },
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${buf}`)), 8000);
    const onData = (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split("\n")) {
        if (!line.includes("listening")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.msg === "listening" && parsed.port) {
            clearTimeout(timer);
            resolve(parsed.port);
          }
        } catch (_) {
          /* partial line */
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}: ${buf}`));
    });
  });

  try {
    const res = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/health`, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on("error", reject);
    });
    assert.equal(res, 200);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  const refused = spawn(process.execPath, [serverPath], {
    env: {
      ...baseEnv,
      NODE_ENV: "production",
      OTP_DEBUG_MODE: "true",
      PORT: "0",
    },
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => refused.once("exit", resolve));
  assert.equal(code, 1);
});

function signUser(claims, options = {}) {
  return jwt.sign(claims, JWT_SECRET, { algorithm: "HS256", expiresIn: "5m", ...options });
}

function connectClient(port, token, extra = {}) {
  return ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    timeout: 4000,
    forceNew: true,
    ...extra,
  });
}

function waitFor(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function waitConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for connect"));
    }, 4000);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };
    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
  });
}

async function waitUntil(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}

test("rate limit keys the right-most untrusted X-Forwarded-For hop", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousOtp = process.env.OTP_SEND_RATE_LIMIT_PER_MIN;
  const previousInternal = process.env.INTERNAL_RATE_LIMIT_PER_MIN;
  const previousTrust = process.env.TRUST_PROXY;
  process.env.NODE_ENV = "development";
  process.env.TRUST_PROXY = "1";
  process.env.OTP_SEND_RATE_LIMIT_PER_MIN = "1";
  process.env.INTERNAL_RATE_LIMIT_PER_MIN = "100";
  try {
    await withServer(async ({ server, app }) => {
      assert.equal(app.get("trust proxy"), 1);
      assert.notEqual(app.get("trust proxy"), true);
      const headers = { "x-internal-key": INTERNAL_KEY };
      const body = { channel: "email", to: "limit@example.com", purpose: "xff", tenantId: 1 };
      const first = await request(server, {
        method: "POST",
        path: "/internal/otp/send",
        headers: { ...headers, "x-forwarded-for": "1.1.1.1, 8.8.8.8" },
        body,
      });
      const rotatedSpoof = await request(server, {
        method: "POST",
        path: "/internal/otp/send",
        headers: { ...headers, "x-forwarded-for": "2.2.2.2, 8.8.8.8" },
        body,
      });
      const otherClient = await request(server, {
        method: "POST",
        path: "/internal/otp/send",
        headers: { ...headers, "x-forwarded-for": "1.1.1.1, 9.9.9.9" },
        body,
      });
      assert.equal(first.status, 200);
      assert.equal(rotatedSpoof.status, 429);
      assert.equal(rotatedSpoof.json.error, "Too many requests");
      assert.equal(otherClient.status, 200);
    });
  } finally {
    process.env.NODE_ENV = previousEnv;
    if (previousOtp == null) delete process.env.OTP_SEND_RATE_LIMIT_PER_MIN;
    else process.env.OTP_SEND_RATE_LIMIT_PER_MIN = previousOtp;
    if (previousInternal == null) delete process.env.INTERNAL_RATE_LIMIT_PER_MIN;
    else process.env.INTERNAL_RATE_LIMIT_PER_MIN = previousInternal;
    if (previousTrust == null) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrust;
  }
});

test("otp verify route reports an unknown code", async () => {
  await withServer(async ({ server }) => {
    const res = await request(server, {
      method: "POST",
      path: "/internal/otp/verify",
      headers: { "x-internal-key": INTERNAL_KEY },
      body: { to: "nobody@example.com", purpose: "login", tenantId: 1, code: "000000" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "No pending code for that destination");
  });
});

test("memory OTP store expires and redis store keeps a TTL", async () => {
  let now = 1_000_000;
  const memory = createMemoryOtpStore(() => now);
  await memory.set("k", { hash: "abc" }, 30);
  assert.equal(memory.mode, "memory");
  assert.deepEqual(await memory.get("k"), { hash: "abc" });
  now += 31_000;
  assert.equal(await memory.get("k"), null);

  const data = new Map();
  const ttls = new Map();
  const calls = [];
  const client = {
    calls,
    data,
    async get(key) {
      calls.push(["get", key]);
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value, ex, ttl) {
      calls.push(["set", key, ex, ttl]);
      data.set(key, value);
      ttls.set(key, ttl);
      return "OK";
    },
    async del(key) {
      calls.push(["del", key]);
      data.delete(key);
      ttls.delete(key);
      return 1;
    },
    async ttl(key) {
      calls.push(["ttl", key]);
      return ttls.has(key) ? ttls.get(key) : -2;
    },
  };

  let factoryUrl;
  const selected = createOtpStore({ REDIS_URL: "redis://127.0.0.1:6399/0" }, (url) => {
    factoryUrl = url;
    return client;
  });
  assert.equal(selected.mode, "redis");
  assert.equal(factoryUrl, "redis://127.0.0.1:6399/0");
  assert.equal(createOtpStore({}).mode, "memory");
  assert.equal(otpService.otpStoreMode({}), "memory");
  assert.equal(otpService.otpStoreMode({ REDIS_URL: "redis://127.0.0.1:6399/0" }), "redis");

  const previousDebug = process.env.OTP_DEBUG_MODE;
  process.env.OTP_DEBUG_MODE = "true";
  otpService.setOtpStoreForTests(createRedisOtpStore(client));
  try {
    const sent = await otpService.sendOtp({
      channel: "email",
      to: "person@example.com",
      purpose: "redis",
      tenantId: 4,
    });
    const setCall = calls.find((entry) => entry[0] === "set");
    assert.equal(setCall[2], "EX");
    assert.equal(setCall[3], Number(process.env.OTP_TTL_SECONDS || 600));
    assert.equal(setCall[1].startsWith(KEY_PREFIX), true);
    assert.equal(JSON.parse(data.get(setCall[1])).hash.includes(sent.debugOtp), false);

    await assert.rejects(
      () =>
        otpService.verifyOtp({
          to: "person@example.com",
          purpose: "redis",
          tenantId: 4,
          code: "000000",
        }),
      (err) => err.status === 400 && err.message === "Invalid code"
    );
    assert.equal(JSON.parse(data.get(setCall[1])).attempts, 1);

    const verified = await otpService.verifyOtp({
      to: "person@example.com",
      purpose: "redis",
      tenantId: 4,
      code: sent.debugOtp,
    });
    assert.equal(verified.verified, true);
    assert.equal(data.has(setCall[1]), false);
  } finally {
    otpService.setOtpStoreForTests(null);
    if (previousDebug == null) delete process.env.OTP_DEBUG_MODE;
    else process.env.OTP_DEBUG_MODE = previousDebug;
  }
});

test("chat denies rooms the JWT holder does not participate in", async () => {
  delete process.env.HEALTHCARE_BACKEND_URL;
  resetAppointmentAccessCache();
  await withServer(async ({ server, io }) => {
    const port = server.address().port;
    const sockets = [];
    const open = async (claims) => {
      const socket = connectClient(port, signUser(claims));
      sockets.push(socket);
      await waitConnect(socket);
      return socket;
    };
    try {
      const outsider = await open({ sub: "outsider", tenantId: 7, userId: 9, roles: ["ROLE_NURSE"] });
      const missing = waitFor(outsider, "chat:error");
      outsider.emit("chat:join", {});
      assert.equal((await missing).code, "appointment_required");

      const invalid = waitFor(outsider, "chat:error");
      outsider.emit("chat:join", { appointmentId: "../tenant-1" });
      assert.equal((await invalid).code, "invalid_appointment");

      const denied = waitFor(outsider, "chat:error");
      outsider.emit("chat:join", { appointmentId: 42 });
      const error = await denied;
      assert.equal(error.error, "Forbidden");
      assert.equal(error.code, "not_a_participant");
      assert.equal(error.message, "You are not a participant of this appointment");
      assert.equal(error.appointmentId, "42");
      assert.equal(io.sockets.sockets.get(outsider.id).rooms.has("appointment:42"), false);

      const nurse = await open({
        sub: "nurse1",
        tenantId: 7,
        userId: 3,
        roles: ["ROLE_NURSE"],
        appointmentIds: [42],
      });
      const patient = await open({
        sub: "patient1",
        tenantId: 7,
        userId: 11,
        roles: ["PATIENT"],
        appointmentId: 42,
      });
      patient.emit("chat:join", { appointmentId: 42 });
      await waitUntil(() => io.sockets.sockets.get(patient.id).rooms.has("appointment:42"));

      const presence = waitFor(patient, "chat:presence");
      nurse.emit("chat:join", { appointmentId: 42 });
      const joined = await presence;
      assert.equal(joined.type, "join");
      assert.equal(joined.username, "nurse1");
      assert.equal(joined.appointmentId, "42");

      const incoming = waitFor(patient, "chat:message");
      nurse.emit("chat:message", { appointmentId: 42, text: "vitals are stable" });
      const message = await incoming;
      assert.equal(message.text, "vitals are stable");
      assert.equal(message.from.username, "nurse1");
      assert.equal(message.from.tenantId, 7);
      assert.equal(message.appointmentId, "42");

      let leaked = false;
      patient.on("chat:message", (payload) => {
        if (payload.text === "steal this chart") leaked = true;
      });
      const blocked = waitFor(outsider, "chat:error");
      outsider.emit("chat:message", { appointmentId: 42, text: "steal this chart" });
      assert.equal((await blocked).code, "not_a_participant");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(leaked, false);
      assert.equal(io.sockets.sockets.get(outsider.id).rooms.has("appointment:42"), false);

      const wrongRoom = waitFor(nurse, "chat:error");
      nurse.emit("chat:join", { appointmentId: 43 });
      assert.equal((await wrongRoom).code, "not_a_participant");
      assert.equal(io.sockets.sockets.get(nurse.id).rooms.has("appointment:43"), false);

      const plainUser = await open({
        sub: "user1",
        tenantId: 7,
        userId: 15,
        roles: ["USER"],
        appointmentIds: [42],
      });
      const roleDenied = waitFor(plainUser, "chat:error");
      plainUser.emit("chat:join", { appointmentId: 42 });
      assert.equal((await roleDenied).code, "not_a_participant");
    } finally {
      for (const socket of sockets) socket.disconnect();
      resetAppointmentAccessCache();
    }
  });
});

test("appointmentToken authorizes one appointment and must match the session", async () => {
  delete process.env.HEALTHCARE_BACKEND_URL;
  resetAppointmentAccessCache();
  await withServer(async ({ server, io }) => {
    const port = server.address().port;
    const socket = connectClient(
      port,
      signUser({ sub: "nurse1", tenantId: 7, userId: 3, roles: ["NURSE"] })
    );
    try {
      await waitConnect(socket);
      const appointmentToken = jwt.sign(
        { sub: "nurse1", tenantId: 7, userId: 3, appointmentId: 77 },
        JWT_SECRET,
        { algorithm: "HS256", expiresIn: "2m" }
      );
      socket.emit("chat:join", { appointmentId: 77, appointmentToken });
      await waitUntil(() => io.sockets.sockets.get(socket.id).rooms.has("appointment:77"));

      const otherUser = jwt.sign(
        { sub: "other", tenantId: 7, userId: 8, appointmentId: 77 },
        JWT_SECRET,
        { algorithm: "HS256", expiresIn: "2m" }
      );
      const denied = waitFor(socket, "chat:error");
      socket.emit("chat:message", {
        appointmentId: 88,
        text: "nope",
        appointmentToken: otherUser,
      });
      assert.equal((await denied).code, "not_a_participant");
      assert.equal(io.sockets.sockets.get(socket.id).rooms.has("appointment:88"), false);

      const expired = jwt.sign(
        {
          sub: "nurse1",
          tenantId: 7,
          userId: 3,
          appointmentId: 88,
          exp: Math.floor(Date.now() / 1000) - 10,
        },
        JWT_SECRET,
        { algorithm: "HS256" }
      );
      const expiredError = waitFor(socket, "chat:error");
      socket.emit("chat:join", { appointmentId: 88, appointmentToken: expired });
      assert.equal((await expiredError).code, "not_a_participant");
    } finally {
      socket.disconnect();
      resetAppointmentAccessCache();
    }
  });
});

test("backend participant lookup is authoritative and cached", async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.HEALTHCARE_BACKEND_URL;
  process.env.HEALTHCARE_BACKEND_URL = "https://backend.test/";
  resetAppointmentAccessCache();
  let calls = 0;
  let mode = "allow";
  global.fetch = async (url, options) => {
    calls += 1;
    assert.equal(options.method, "GET");
    assert.equal(options.headers["X-Internal-Key"], INTERNAL_KEY);
    assert.equal(options.redirect, "error");
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://backend.test");
    assert.equal(parsed.pathname, "/internal/realtime/appointments/42/access");
    assert.equal(parsed.searchParams.get("username"), "patient1");
    assert.equal(parsed.searchParams.get("userId"), "11");
    assert.equal(parsed.searchParams.get("tenantId"), "7");
    if (mode === "allow") {
      return new Response(JSON.stringify({ allowed: true, tenantId: 7, participant: "patient" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (mode === "tenant") {
      return new Response(JSON.stringify({ allowed: true, tenantId: 99, participant: "patient" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (mode === "down") {
      throw new Error("connect ECONNREFUSED");
    }
    return new Response(JSON.stringify({ allowed: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const claims = { sub: "patient1", tenantId: 7, userId: 11, roles: ["PATIENT"], appointmentIds: [42] };
  try {
    await withServer(async ({ server, io }) => {
      const port = server.address().port;
      const socket = connectClient(port, signUser(claims));
      try {
        await waitConnect(socket);
        socket.emit("chat:join", { appointmentId: 42 });
        await waitUntil(() => io.sockets.sockets.get(socket.id).rooms.has("appointment:42"));
        const incoming = waitFor(socket, "chat:message");
        socket.emit("chat:message", { appointmentId: 42, text: "hello clinic" });
        assert.equal((await incoming).text, "hello clinic");
        assert.equal(calls, 1);

        mode = "deny";
        resetAppointmentAccessCache();
        const denied = waitFor(socket, "chat:error");
        socket.emit("chat:join", { appointmentId: 42 });
        assert.equal((await denied).code, "not_a_participant");
        await waitUntil(() => !io.sockets.sockets.get(socket.id).rooms.has("appointment:42"));
        const afterDeny = calls;
        socket.emit("chat:message", { appointmentId: 42, text: "again" });
        assert.equal((await waitFor(socket, "chat:error")).code, "not_a_participant");
        assert.equal(calls, afterDeny);

        mode = "tenant";
        resetAppointmentAccessCache();
        const mismatch = waitFor(socket, "chat:error");
        socket.emit("chat:join", { appointmentId: 42 });
        assert.equal((await mismatch).code, "not_a_participant");

        mode = "down";
        resetAppointmentAccessCache();
        const down = waitFor(socket, "chat:error");
        socket.emit("chat:join", { appointmentId: 42 });
        assert.equal((await down).code, "not_a_participant");
        assert.equal(io.sockets.sockets.get(socket.id).rooms.has("appointment:42"), false);
      } finally {
        socket.disconnect();
      }
    });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl == null) delete process.env.HEALTHCARE_BACKEND_URL;
    else process.env.HEALTHCARE_BACKEND_URL = previousUrl;
    resetAppointmentAccessCache();
  }
});

test("a configured but invalid healthcare backend URL denies chat", async () => {
  const previous = process.env.HEALTHCARE_BACKEND_URL;
  process.env.HEALTHCARE_BACKEND_URL = "not a url";
  resetAppointmentAccessCache();
  try {
    const decision = await authorizeAppointment(
      { username: "nurse1", tenantId: 7, userId: 3, roles: ["NURSE"], appointmentIds: [42] },
      "42",
      {}
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "not_a_participant");
  } finally {
    if (previous == null) delete process.env.HEALTHCARE_BACKEND_URL;
    else process.env.HEALTHCARE_BACKEND_URL = previous;
    resetAppointmentAccessCache();
  }
});

test("socket handshake rejects an origin that is not allowlisted", async () => {
  await withServer(async ({ server }) => {
    const socket = connectClient(
      server.address().port,
      signUser({ sub: "nurse1", tenantId: 7, userId: 3, roles: ["NURSE"], appointmentIds: [1] }),
      { extraHeaders: { Origin: "https://evil.vercel.app" } }
    );
    try {
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for rejection")), 4000);
        socket.on("connect", () => {
          clearTimeout(timer);
          reject(new Error("socket connected"));
        });
        socket.on("connect_error", (error) => {
          clearTimeout(timer);
          resolve(error);
        });
      });
      assert.match(String(err.message), /Origin not allowed/);
    } finally {
      socket.disconnect();
    }
  });
});
