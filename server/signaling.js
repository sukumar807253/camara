const { authenticate, touch } = require("./sessionManager");

const MAX_SDP_LENGTH = 256 * 1024;
const MAX_CANDIDATE_LENGTH = 4096;

function validDescription(value, expectedType) {
  return value &&
    typeof value === "object" &&
    value.type === expectedType &&
    typeof value.sdp === "string" &&
    value.sdp.length > 0 &&
    value.sdp.length <= MAX_SDP_LENGTH;
}

function validCandidate(value) {
  return value === null || (
    value &&
    typeof value === "object" &&
    typeof value.candidate === "string" &&
    value.candidate.length <= MAX_CANDIDATE_LENGTH &&
    (value.sdpMid === null || typeof value.sdpMid === "string") &&
    (value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex))
  );
}

function installSignaling(io) {
  io.use((socket, next) => {
    const auth = socket.handshake.auth;
    if (!auth || typeof auth !== "object") return next(new Error("unauthorized"));

    const session = authenticate(auth.sessionId, auth.role, auth.token);
    if (!session) return next(new Error("unauthorized"));
    socket.data.sessionId = session.id;
    socket.data.role = auth.role;
    next();
  });

  io.on("connection", (socket) => {
    const session = authenticate(
      socket.data.sessionId,
      socket.data.role,
      socket.handshake.auth.token,
    );
    if (!session) return socket.disconnect(true);

    const role = socket.data.role;
    const slot = role === "mobile" ? "mobileSocketId" : "viewerSocketId";
    let signalWindowStart = Date.now();
    let signalCount = 0;
    const withinSignalLimit = () => {
      if (session.expiresAt <= Date.now()) {
        io.to(session.id).emit("session-expired");
        io.in(session.id).disconnectSockets(true);
        return false;
      }
      const now = Date.now();
      if (now - signalWindowStart >= 10_000) {
        signalWindowStart = now;
        signalCount = 0;
      }
      signalCount += 1;
      if (signalCount <= 160) return true;
      socket.disconnect(true);
      return false;
    };
    const previousSocketId = session[slot];
    if (previousSocketId && previousSocketId !== socket.id) {
      io.sockets.sockets.get(previousSocketId)?.disconnect(true);
    }

    session[slot] = socket.id;
    touch(session);
    socket.join(session.id);
    socket.emit("peer-status", {
      mobileConnected: Boolean(session.mobileSocketId),
      viewerConnected: Boolean(session.viewerSocketId),
      cameraActive: session.cameraActive,
      expiresAt: session.expiresAt,
    });
    io.to(session.id).emit("peer-status", {
      mobileConnected: Boolean(session.mobileSocketId),
      viewerConnected: Boolean(session.viewerSocketId),
      cameraActive: session.cameraActive,
      expiresAt: session.expiresAt,
    });

    socket.on("offer", (payload) => {
      if (!withinSignalLimit()) return;
      const description = payload?.description;
      if (role !== "mobile" || !validDescription(description, "offer")) {
        return socket.emit("signaling-error", { message: "Invalid offer." });
      }
      const peerId = session.viewerSocketId;
      if (!peerId) return socket.emit("signaling-error", { message: "Viewer is not connected." });
      touch(session);
      io.to(peerId).emit("offer", { description });
    });

    socket.on("answer", (payload) => {
      if (!withinSignalLimit()) return;
      const description = payload?.description;
      if (role !== "viewer" || !validDescription(description, "answer")) {
        return socket.emit("signaling-error", { message: "Invalid answer." });
      }
      const peerId = session.mobileSocketId;
      if (!peerId) return socket.emit("signaling-error", { message: "Mobile camera is not connected." });
      touch(session);
      io.to(peerId).emit("answer", { description });
    });

    socket.on("ice-candidate", (payload) => {
      if (!withinSignalLimit()) return;
      const candidate = payload?.candidate;
      if (!validCandidate(candidate)) {
        return socket.emit("signaling-error", { message: "Invalid ICE candidate." });
      }
      const peerId = role === "mobile" ? session.viewerSocketId : session.mobileSocketId;
      if (!peerId) return;
      touch(session);
      io.to(peerId).emit("ice-candidate", { candidate });
    });

    socket.on("camera-state", (payload) => {
      const active = payload?.active;
      if (role !== "mobile" || typeof active !== "boolean") return;
      if (!withinSignalLimit()) return;
      session.cameraActive = active;
      touch(session);
      io.to(session.id).emit("peer-status", {
        mobileConnected: Boolean(session.mobileSocketId),
        viewerConnected: Boolean(session.viewerSocketId),
        cameraActive: session.cameraActive,
        expiresAt: session.expiresAt,
      });
    });

    socket.on("camera-stopped", () => {
      if (role !== "mobile") return;
      if (!withinSignalLimit()) return;
      session.cameraActive = false;
      touch(session);
      io.to(session.id).emit("camera-stopped");
    });

    socket.on("request-offer", () => {
      if (role !== "viewer" || !session.mobileSocketId) return;
      if (!withinSignalLimit()) return;
      touch(session);
      io.to(session.mobileSocketId).emit("renegotiate");
    });

    socket.on("camera-control", (payload) => {
      if (role !== "viewer" || !session.mobileSocketId) return;
      if (!withinSignalLimit()) return;
      if (!payload || typeof payload !== "object" || typeof payload.action !== "string") return;
      touch(session);
      io.to(session.mobileSocketId).emit("camera-control", payload);
    });

    socket.on("camera-info", (payload) => {
      if (role !== "mobile" || !session.viewerSocketId) return;
      if (!withinSignalLimit()) return;
      if (!payload || typeof payload !== "object") return;
      touch(session);
      io.to(session.viewerSocketId).emit("camera-info", payload);
    });

    socket.on("disconnect", () => {
      if (session[slot] !== socket.id) return;
      session[slot] = null;
      touch(session);

      io.to(session.id).emit("peer-status", {
        mobileConnected: Boolean(session.mobileSocketId),
        viewerConnected: Boolean(session.viewerSocketId),
        cameraActive: session.cameraActive,
        expiresAt: session.expiresAt,
      });
      // Do NOT kill camera or emit camera-stopped on disconnect.
      // Keeps session ready indefinitely so stream resumes whenever mobile screen turns back on.
    });
  });
}

module.exports = { installSignaling };