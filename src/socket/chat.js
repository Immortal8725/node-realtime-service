/**
 * Appointment-scoped chat.
 * Events: chat:join, chat:message, chat:leave
 */
function registerChat(io, socket) {
  socket.on("chat:join", (payload = {}) => {
    const appointmentId = payload.appointmentId;
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

  socket.on("chat:leave", (payload = {}) => {
    const appointmentId = payload.appointmentId;
    if (!appointmentId) return;
    const room = `appointment:${appointmentId}`;
    socket.leave(room);
    socket.to(room).emit("chat:presence", {
      type: "leave",
      username: socket.user?.username,
      appointmentId,
      at: new Date().toISOString(),
    });
  });

  socket.on("chat:message", (payload = {}) => {
    const appointmentId = payload.appointmentId;
    const text = String(payload.text || "").trim();
    if (!appointmentId || !text) return;
    if (text.length > 2000) return;

    const room = `appointment:${appointmentId}`;
    // Ensure sender is in the room (covers race before chat:join lands)
    socket.join(room);

    const message = {
      id: payload.id || undefined,
      appointmentId,
      text,
      from: {
        username: socket.user?.username,
        userId: socket.user?.userId,
        roles: socket.user?.roles || [],
        tenantId: socket.user?.tenantId,
      },
      at: payload.at || new Date().toISOString(),
    };
    io.to(room).emit("chat:message", message);
  });
}

module.exports = { registerChat };
