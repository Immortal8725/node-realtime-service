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

const { createApp } = require("../src/server");
const { validateConfig, isOriginAllowed } = require("../src/config");
const { redact } = require("../src/logger");
const { verifyToken } = require("../src/middleware/auth");
const emailService = require("../src/services/emailService");
const otpService = require("../src/services/otpService");

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

test("health reports version and delivery status without secrets", async () => {
  await withServer(async ({ server }) => {
    const res = await request(server, {
      path: "/health",
      headers: { Origin: "https://www.digimed-connect.co.za" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "ok");
    assert.equal(res.json.service, "node-realtime-service");
    assert.equal(res.json.version, "1.1.0");
    assert.equal(typeof res.json.uptimeSeconds, "number");
    assert.equal(res.json.redisAdapter, false);
    assert.equal(res.json.redis, "off");
    assert.equal(res.json.delivery.email, "stub");
    assert.equal(res.json.delivery.sms, "stub");
    assert.equal(res.json.delivery.whatsapp, "stub");
    assert.equal(res.json.delivery.internalKeyConfigured, true);
    assert.equal(res.json.delivery.otpDebugMode, false);
    assert.equal(res.json.delivery.baileys, undefined);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["access-control-allow-origin"], "https://www.digimed-connect.co.za");
    assert.equal(res.text.includes(INTERNAL_KEY), false);
    assert.equal(res.text.includes(JWT_SECRET), false);
    assert.equal(JSON.stringify(res.json).includes("qr"), false);
  });
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

test("CORS allows DigiMed hosts and Vercel previews", () => {
  const origins = process.env.CORS_ORIGINS;
  assert.equal(isOriginAllowed("https://digimed-connect.co.za", origins), true);
  assert.equal(isOriginAllowed("https://www.digimed-connect.co.za", origins), true);
  assert.equal(
    isOriginAllowed("https://healthcare-frontend-git-main-team.vercel.app", origins),
    true
  );
  assert.equal(isOriginAllowed("https://evil.example", origins), false);
  assert.equal(isOriginAllowed("https://notvercel.app", origins), false);
  assert.equal(isOriginAllowed("https://evil.vercel.app.attacker.com", origins), false);
  assert.equal(isOriginAllowed(undefined, origins), true);
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
    const verified = otpService.verifyOtp({
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
