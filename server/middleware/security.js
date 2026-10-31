function requireSecureTransport(req, res, next) {
  if (process.env.NODE_ENV === "production" && !req.secure) {
    return res.status(400).json({ error: "HTTPS is required." });
  }
  next();
}

function requireSocketSecureTransport(socket, next) {
  if (process.env.NODE_ENV !== "production") return next();
  const forwardedProto = process.env.TRUST_PROXY === "1" && socket.handshake.headers["x-forwarded-proto"];
  if (socket.request.secure || forwardedProto === "https") return next();
  next(new Error("HTTPS is required."));
}

module.exports = { requireSecureTransport, requireSocketSecureTransport };