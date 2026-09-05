/**
 * User / tenant notification subscriptions + server push helper.
 */
function registerNotifications(io, socket) {
  socket.on("notify:subscribe", () => {
    const user = socket.user || {};
    if (user.userId != null) {
      socket.join(`user:${user.userId}`);
    }
    if (user.username) {
      socket.join(`user:${user.username}`);
    }
    if (user.tenantId != null) {
      socket.join(`tenant:${user.tenantId}`);
    }
    socket.emit("notify:subscribed", {
      userId: user.userId,
      username: user.username,
      tenantId: user.tenantId,
    });
  });
}

/**
 * Push a notification from Express/internal routes.
 * target: { userId?, username?, tenantId? }
 */
function pushNotification(io, target = {}, event = {}) {
  const payload = {
    ...event,
    at: event.at || new Date().toISOString(),
  };
  if (target.userId != null) {
    io.to(`user:${target.userId}`).emit("notify:event", payload);
  }
  if (target.username) {
    io.to(`user:${target.username}`).emit("notify:event", payload);
  }
  if (target.tenantId != null) {
    io.to(`tenant:${target.tenantId}`).emit("notify:event", payload);
  }
}

module.exports = { registerNotifications, pushNotification };
