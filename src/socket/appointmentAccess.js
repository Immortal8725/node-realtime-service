/**
 * Appointment chat authorization. Deny unless a participant check succeeds.
 *
 * Preferred: healthcare-backend internal lookup with X-Internal-Key, cached briefly.
 * Fallback (only when HEALTHCARE_BACKEND_URL is unset): the verified JWT must
 * carry this appointment, or the event must include a matching appointmentToken.
 * Tenant and a participant role are required on that fallback path.
 */

const jwt = require("jsonwebtoken");
const logger = require("../logger");

const PARTICIPANT_ROLES = new Set([
  "PATIENT",
  "DOCTOR",
  "NURSE",
  "CLINICIAN",
  "STAFF",
  "ADMIN",
  "RECEPTIONIST",
  "PRACTICE_MANAGER",
  "PHARMACIST",
  "PHYSICIAN",
  "MIDWIFE",
  "THERAPIST",
  "TENANT_ADMIN",
  "SUPER_ADMIN",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cache = new Map();
const MAX_CACHE = 2000;

function normalizeAppointmentId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (/^[0-9]{1,18}$/.test(id)) return id;
  if (UUID_RE.test(id)) return id.toLowerCase();
  return null;
}

function hasParticipantRole(user) {
  return (user?.roles || []).some((role) => PARTICIPANT_ROLES.has(String(role).toUpperCase()));
}

function sameTenant(left, right) {
  if (left == null || right == null) return false;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && a === b;
}

function claimsIncludeAppointment(user, appointmentId) {
  const ids = [];
  if (user?.appointmentId != null) ids.push(user.appointmentId);
  if (Array.isArray(user?.appointmentIds)) ids.push(...user.appointmentIds);
  return ids.some((value) => normalizeAppointmentId(value) === appointmentId);
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || "";
  if (!secret || secret.length < 32) return null;
  return secret;
}

function tokenAllows(user, appointmentId, token) {
  if (typeof token !== "string" || !token.trim()) return false;
  const secret = getJwtSecret();
  if (!secret) return false;
  let claims;
  try {
    claims = jwt.verify(token.trim(), secret, {
      algorithms: ["HS256", "HS384", "HS512"],
    });
  } catch (_) {
    return false;
  }
  if (!claims || typeof claims !== "object") return false;
  if (normalizeAppointmentId(claims.appointmentId) !== appointmentId) return false;
  if (!sameTenant(claims.tenantId, user.tenantId)) return false;

  const claimName = claims.sub || claims.username;
  const claimId = claims.userId != null ? Number(claims.userId) : null;
  const nameOk = Boolean(claimName) && String(claimName) === String(user.username || "");
  const idOk =
    claimId != null && user.userId != null && claimId === Number(user.userId) && Number.isFinite(claimId);
  if (claimName && user.username && String(claimName) !== String(user.username)) return false;
  if (
    claimId != null &&
    user.userId != null &&
    claimId !== Number(user.userId)
  ) {
    return false;
  }
  return nameOk || idOk;
}

function checkWithClaims(user, appointmentId, payload) {
  if (!hasParticipantRole(user)) {
    return { allowed: false, code: "not_a_participant" };
  }
  if (claimsIncludeAppointment(user, appointmentId)) {
    return { allowed: true, code: "appointment_claim" };
  }
  if (tokenAllows(user, appointmentId, payload?.appointmentToken)) {
    return { allowed: true, code: "appointment_token" };
  }
  return { allowed: false, code: "not_a_participant" };
}

function backendBase() {
  const base = String(process.env.HEALTHCARE_BACKEND_URL || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  let url;
  try {
    url = new URL(base);
  } catch (_) {
    return "";
  }
  if (url.username || url.password) return "";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return base;
}

function positiveTtl() {
  const configured = Number(process.env.CHAT_ACCESS_CACHE_SECONDS || 30);
  if (!Number.isFinite(configured) || configured < 1) return 30;
  return Math.min(300, Math.floor(configured));
}

function negativeTtl() {
  return Math.min(10, positiveTtl());
}

function timeoutMs() {
  const n = Number(process.env.CHAT_ACCESS_TIMEOUT_MS || 2000);
  if (!Number.isFinite(n) || n < 200) return 2000;
  return Math.min(10000, Math.floor(n));
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlSeconds) {
  cache.delete(key);
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function deny() {
  return { allowed: false, code: "not_a_participant" };
}

async function lookupBackend(user, appointmentId, base) {
  const apiKey = String(process.env.INTERNAL_API_KEY || "");
  if (apiKey.length < 16) return deny();

  const url = new URL(
    `${base}/internal/realtime/appointments/${encodeURIComponent(appointmentId)}/access`
  );
  if (user.userId != null) url.searchParams.set("userId", String(user.userId));
  if (user.username) url.searchParams.set("username", String(user.username));
  url.searchParams.set("tenantId", String(user.tenantId));

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Internal-Key": apiKey,
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    logger.warn(
      { appointmentId, err: err && err.name ? err.name : "error" },
      "appointment access lookup failed"
    );
    return deny();
  }

  let body = null;
  try {
    const text = await response.text();
    if (text.length > 4096) return deny();
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = null;
  }

  if (!response.ok || !body || body.allowed !== true) {
    logger.info({ appointmentId, status: response.status }, "appointment access denied by backend");
    return deny();
  }
  if (body.tenantId != null && !sameTenant(body.tenantId, user.tenantId)) {
    logger.info({ appointmentId }, "appointment access denied because tenant did not match");
    return deny();
  }
  return { allowed: true, code: "backend" };
}

async function checkWithBackend(user, appointmentId, base) {
  const key = `${user.userId ?? ""}|${user.username ?? ""}|${user.tenantId}|${appointmentId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const decision = await lookupBackend(user, appointmentId, base);
  cacheSet(key, decision, decision.allowed ? positiveTtl() : negativeTtl());
  return decision;
}

/**
 * @returns {Promise<{ allowed: boolean, code: string }>}
 */
async function authorizeAppointment(user, appointmentId, payload) {
  const id = normalizeAppointmentId(appointmentId);
  if (!id) return { allowed: false, code: "invalid_appointment" };
  if (!user || !Number.isFinite(Number(user.tenantId))) return deny();
  if (!user.username && user.userId == null) return deny();

  const configured = String(process.env.HEALTHCARE_BACKEND_URL || "").trim();
  const base = backendBase();
  if (configured && !base) return deny();
  if (base) return checkWithBackend(user, id, base);
  return checkWithClaims(user, id, payload || {});
}

function resetAppointmentAccessCache() {
  cache.clear();
}

module.exports = {
  PARTICIPANT_ROLES,
  authorizeAppointment,
  normalizeAppointmentId,
  resetAppointmentAccessCache,
};
