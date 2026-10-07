/**
 * JSON logs for stdout/stderr. Secret-shaped fields and OTP codes are redacted.
 * Info/warn are quiet when NODE_ENV=test unless LOG_LEVEL=debug.
 */

const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|x-internal-key|cookie|set-cookie|password|pass|passwd|token|secret|api[-_]?key|apikey|jwt|jwt_secret|internal_api_key|code|otp|debugotp|html|text|body|smtp_pass|auth_token|resend_api_key|twilio_auth_token)$/i;

function redactString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\bre_[A-Za-z0-9]{8,}\b/g, "[redacted]")
    .replace(/\bAC[a-f0-9]{32}\b/gi, "[redacted]")
    .replace(/(verification code[:\s]*)\d{4,8}/gi, "$1[redacted]")
    .replace(/\b(otp|code)[:\s]+\d{4,8}\b/gi, "$1 [redacted]")
    .replace(
      /\b(api[_-]?key|secret|token|password|auth(?:_token)?)(=|:)\s*\S+/gi,
      "$1$2[redacted]"
    );
}

function redact(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) out[key] = "[redacted]";
      else out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return redactString(value);
}

function maskDestination(to) {
  const raw = String(to || "");
  if (!raw) return "[redacted]";
  if (raw.includes("@")) {
    const at = raw.indexOf("@");
    const head = raw.slice(0, 1);
    return `${head}***${raw.slice(at)}`;
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 4) {
    return `${raw.slice(0, Math.min(3, raw.length))}***${digits.slice(-2)}`;
  }
  return "[redacted]";
}

function enabled(level) {
  if (process.env.LOG_LEVEL === "silent") return false;
  if (process.env.NODE_ENV === "test" && process.env.LOG_LEVEL !== "debug") {
    return level === "error";
  }
  return true;
}

function write(level, fields, msg) {
  if (!enabled(level)) return;
  const payload = {
    time: new Date().toISOString(),
    level,
    service: "node-realtime-service",
    msg: redactString(msg),
    ...redact(fields || {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

module.exports = {
  redact,
  redactString,
  maskDestination,
  info(fields, msg) {
    if (typeof fields === "string") write("info", {}, fields);
    else write("info", fields, msg);
  },
  warn(fields, msg) {
    if (typeof fields === "string") write("warn", {}, fields);
    else write("warn", fields, msg);
  },
  error(fields, msg) {
    if (typeof fields === "string") write("error", {}, fields);
    else write("error", fields, msg);
  },
};
