/**
 * Startup checks, explicit CORS origins, and proxy hop count.
 * Production fails closed. Wildcards are never compiled into allow rules.
 */

const DEFAULT_ORIGINS = [
  "https://digimed-connect.co.za",
  "https://www.digimed-connect.co.za",
];

function canonicalOrigin(entry) {
  const value = String(entry || "").trim();
  if (!value || value.includes("*")) return null;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function classifyOrigins(raw) {
  const blank = raw == null || String(raw).trim() === "";
  const source = blank ? DEFAULT_ORIGINS.join(",") : String(raw);
  const origins = [];
  const rejected = [];
  const seen = new Set();
  for (const part of source.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const origin = canonicalOrigin(trimmed);
    if (!origin) {
      rejected.push(trimmed);
      continue;
    }
    const key = origin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    origins.push(origin);
  }
  return { origins, rejected, usedDefault: blank };
}

function originSource(env = process.env) {
  if (env.ALLOWED_ORIGINS != null && String(env.ALLOWED_ORIGINS).trim() !== "") {
    return env.ALLOWED_ORIGINS;
  }
  if (env.CORS_ORIGINS != null && String(env.CORS_ORIGINS).trim() !== "") {
    return env.CORS_ORIGINS;
  }
  return "";
}

/**
 * Explicit origins only. ALLOWED_ORIGINS wins over the legacy CORS_ORIGINS name.
 * An empty value falls back to the DigiMed production hosts.
 * Entries containing `*` (including `https://*.vercel.app`) are dropped.
 */
function parseOrigins(raw) {
  return classifyOrigins(raw).origins;
}

function resolveAllowedOrigins(env = process.env) {
  return classifyOrigins(originSource(env)).origins;
}

/**
 * Allow a missing Origin (curl, Spring, Railway health checks, same-process calls).
 * A presented Origin must match the explicit list exactly.
 */
function isOriginAllowed(origin, origins) {
  if (!origin) return true;
  const list = Array.isArray(origins)
    ? origins.map((entry) => canonicalOrigin(entry)).filter(Boolean)
    : typeof origins === "string"
      ? parseOrigins(origins)
      : resolveAllowedOrigins();
  const wanted = String(origin).toLowerCase();
  return list.some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Hop count for Express `trust proxy`. Never boolean `true` — that would trust
 * the client-supplied leftmost X-Forwarded-For hop. Railway is one proxy.
 * Returns `false` or a positive integer.
 */
function resolveTrustProxy(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const fallback = nodeEnv === "production" ? 1 : false;
  if (env.TRUST_PROXY == null || String(env.TRUST_PROXY).trim() === "") return fallback;
  const flag = String(env.TRUST_PROXY).trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off" || flag === "no") return false;
  if (flag === "true" || flag === "yes" || flag === "on") return 1;
  const hops = Number(flag);
  if (Number.isInteger(hops) && hops > 0 && hops < 32) return hops;
  return fallback;
}

function shouldTrustProxy(env = process.env) {
  return resolveTrustProxy(env) !== false;
}

function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const nodeEnv = env.NODE_ENV || "development";
  const debug = String(env.OTP_DEBUG_MODE || "").toLowerCase() === "true";

  if (nodeEnv === "production" && debug) {
    errors.push("OTP_DEBUG_MODE=true is forbidden in production");
  }

  const classified = classifyOrigins(originSource(env));
  if (classified.rejected.length) {
    warnings.push(
      `Ignoring non-explicit CORS origins (${classified.rejected.join(", ")}). Set ALLOWED_ORIGINS to exact origins; wildcards such as https://*.vercel.app are not allowed`
    );
  }
  if (nodeEnv === "production" && classified.origins.length === 0) {
    errors.push(
      "ALLOWED_ORIGINS must include at least one explicit origin. Wildcards such as https://*.vercel.app are not allowed"
    );
  }

  if (nodeEnv === "production" && !String(env.HEALTHCARE_BACKEND_URL || "").trim()) {
    warnings.push(
      "HEALTHCARE_BACKEND_URL is unset. Chat join and send are denied unless the JWT is appointment-scoped or the client presents an appointmentToken"
    );
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

module.exports = {
  DEFAULT_ORIGINS,
  parseOrigins,
  classifyOrigins,
  resolveAllowedOrigins,
  isOriginAllowed,
  resolveTrustProxy,
  shouldTrustProxy,
  validateConfig,
};
