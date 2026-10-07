/**
 * Startup checks and CORS origin matching.
 * Production fails closed. Development keeps the existing loose defaults.
 */

function parseOrigins(raw) {
  const source = raw == null || String(raw).trim() === "" ? "http://localhost:3000" : String(raw);
  return source
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function originMatcher(entry) {
  if (!entry.includes("*")) {
    return (origin) => origin.toLowerCase() === entry.toLowerCase();
  }
  const escaped = entry
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  const re = new RegExp(`^${escaped}$`, "i");
  return (origin) => re.test(origin);
}

/**
 * Allow missing Origin (curl, Spring, same-process health checks).
 * `*` in a CORS_ORIGINS entry is a single-label wildcard, so
 * `https://*.vercel.app` matches Vercel production and preview hosts.
 */
function isOriginAllowed(origin, origins) {
  if (!origin) return true;
  const list = Array.isArray(origins) ? origins : parseOrigins(origins ?? process.env.CORS_ORIGINS);
  return list.some((entry) => originMatcher(entry)(String(origin)));
}

function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const nodeEnv = env.NODE_ENV || "development";
  const debug = String(env.OTP_DEBUG_MODE || "").toLowerCase() === "true";

  if (nodeEnv === "production" && debug) {
    errors.push("OTP_DEBUG_MODE=true is forbidden in production");
  }

  if (nodeEnv === "production") {
    const jwt = String(env.JWT_SECRET || "");
    if (jwt.length < 32) {
      errors.push("JWT_SECRET must be set to at least 32 characters in production");
    } else if (jwt.length < 64) {
      warnings.push(
        "JWT_SECRET is shorter than the DigiMed 64-character standard; use the same value as Spring"
      );
    }

    if (String(env.INTERNAL_API_KEY || "").length < 16) {
      errors.push("INTERNAL_API_KEY must be set to at least 16 characters in production");
    }

    const emailProvider = String(env.EMAIL_PROVIDER || "").toLowerCase().trim();
    if (emailProvider === "resend" && (!env.RESEND_API_KEY || !env.RESEND_FROM)) {
      errors.push("EMAIL_PROVIDER=resend requires RESEND_API_KEY and RESEND_FROM");
    }
    if (emailProvider === "smtp" && !env.SMTP_HOST) {
      errors.push("EMAIL_PROVIDER=smtp requires SMTP_HOST");
    }
  }

  return { errors, warnings };
}

function shouldTrustProxy(env = process.env) {
  const flag = String(env.TRUST_PROXY || "").toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (flag === "true" || flag === "1") return true;
  return env.NODE_ENV === "production";
}

module.exports = {
  parseOrigins,
  isOriginAllowed,
  validateConfig,
  shouldTrustProxy,
};
