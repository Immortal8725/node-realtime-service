/**
 * Appointment-scoped chat.
 * Events: chat:join, chat:message, chat:leave, chat:error
 *
 * Join and send are denied unless the caller is a participant of that
 * appointment. chat:error is emitted on denial. The room is not joined.
 */
const { authorizeAppointment, normalizeAppointmentId } = require("./appointmentAccess");

function emitError(socket, body, ack) {
  socket.emit("chat:error", body);
  if (typeof ack === "function") ack(body);
}

function asPayload(payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload;
}

function forbidden(appointmentId) {
  return {
    error: "Forbidden",
    message: "You are not a participant of this appointment",
    code: "not_a_participant",
    appointmentId,
  };
}

async function requireAccess(socket, payload, ack) {
  const body = asPayload(payload);
  const raw = body.appointmentId;
  if (raw == null || String(raw).trim() === "") {
    emitError(
      socket,
      { error: "Bad request", message: "appointmentId is required", code: "appointment_required" },
      ack
    );
    return null;
  }
  const appointmentId = normalizeAppointmentId(raw);
  if (!appointmentId) {
    emitError(
      socket,
      { error: "Bad request", message: "appointmentId is invalid", code: "invalid_appointment" },
      ack
    );
    return null;
  }

  let decision;
  try {
    decision = await authorizeAppointment(socket.user, appointmentId, body);
  } catch (_) {
    decision = { allowed: false };
  }
  if (!decision || decision.allowed !== true) {
    socket.leave(`appointment:${appointmentId}`);
    emitError(socket, forbidden(appointmentId), ack);
    return null;
  }
  return appointmentId;
}

function registerChat(io, socket) {
  socket.on("chat:join", async (payload, ack) => {
    const appointmentId = await requireAccess(socket, payload, ack);
    if (!appointmentId) return;
    const room = `appointment:${appointmentId}`;
    socket.join(room);
    socket.to(room).emit("chat:presence", {
      type: "join",
      username: socket.user?.username,
      appointmentId,
      at: new Date().toISOString(),
    });
  });

  socket.on("chat:leave", (payload) => {
    const appointmentId = normalizeAppointmentId(asPayload(payload).appointmentId);
    if (!appointmentId) return;
    const room = `appointment:${appointmentId}`;
    const wasIn = socket.rooms.has(room);
    socket.leave(room);
    if (!wasIn) return;
    socket.to(room).emit("chat:presence", {
      type: "leave",
      username: socket.user?.username,
      appointmentId,
      at: new Date().toISOString(),
    });
  });

  socket.on("chat:message", async (payload, ack) => {
    const body = asPayload(payload);
    const appointmentId = await requireAccess(socket, body, ack);
    if (!appointmentId) return;
    const text = String(body.text || "").trim();
    if (!text || text.length > 2000) return;

    const room = `appointment:${appointmentId}`;
    socket.join(room);

    const message = {
      id: body.id || undefined,
      appointmentId,
      text,
      from: {
        username: socket.user?.username,
        userId: socket.user?.userId,
        roles: socket.user?.roles || [],
        tenantId: socket.user?.tenantId,
      },
      at: body.at || new Date().toISOString(),
    };
    io.to(room).emit("chat:message", message);
  });
}

module.exports = { registerChat };
