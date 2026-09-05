const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || "";
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set (same value as Spring) and sufficiently long");
  }
  return secret;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyToken(token) {
  if (!token) {
    const err = new Error("Missing token");
    err.status = 401;
    throw err;
  }
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  const payload = jwt.verify(raw, getJwtSecret());
  const roles = Array.isArray(payload.roles)
    ? payload.roles.map((r) => String(r).replace(/^ROLE_/, ""))
    : [];
  return {
    username: payload.sub || payload.username,
    tenantId: payload.tenantId != null ? Number(payload.tenantId) : null,
    roles,
    userId: payload.userId != null ? Number(payload.userId) : null,
  };
}

/** Express middleware: Authorization Bearer JWT */
function requireJwt(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    req.user = verifyToken(header);
    next();
  } catch (e) {
    res.status(e.status || 401).json({ error: "Unauthorized", detail: e.message });
  }
}

/** Express middleware: X-Internal-Key for Spring → realtime */
function requireInternalKey(req, res, next) {
  const key = process.env.INTERNAL_API_KEY || "";
  const provided = req.headers["x-internal-key"] || "";
  if (!key || key.length < 16) {
    return res.status(503).json({ error: "INTERNAL_API_KEY not configured" });
  }
  if (!timingSafeEqualString(key, provided)) {
    return res.status(401).json({ error: "Unauthorized internal call" });
  }
  next();
}

/** Socket.IO middleware */
function socketAuth(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization ||
      socket.handshake.query?.token;
    socket.user = verifyToken(token);
    next();
  } catch (e) {
    next(new Error("Unauthorized"));
  }
}

module.exports = {
  verifyToken,
  requireJwt,
  requireInternalKey,
  socketAuth,
};
