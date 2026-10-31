const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const sessions = require("../server/sessionManager");
const { installSignaling } = require("../server/signaling");

function waitForEvent(socket, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}.`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(eventName, onEvent);
  });
}

function connectSocket(url, credentials) {
  const socket = connect(url, {
    auth: credentials,
    reconnection: false,
    transports: ["websocket"],
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => reject(error));
  });
}

test("Socket.IO authenticates roles and relays WebRTC signaling only within a session", async (t) => {
  const httpServer = createServer();
  const ioServer = new Server(httpServer, { cors: { origin: "*" } });
  installSignaling(ioServer);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  const session = sessions.createSession(60);
  const otherSession = sessions.createSession(60);
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    sessions.removeSession(session.session.id);
    sessions.removeSession(otherSession.session.id);
    await new Promise((resolve) => ioServer.close(resolve));
  });

  const mobile = await connectSocket(url, {
    sessionId: session.session.id,
    token: session.mobileToken,
    role: "mobile",
  });
  const viewer = await connectSocket(url, {
    sessionId: session.session.id,
    token: session.viewerToken,
    role: "viewer",
  });
  const otherViewer = await connectSocket(url, {
    sessionId: otherSession.session.id,
    token: otherSession.viewerToken,
    role: "viewer",
  });
  sockets.push(mobile, viewer, otherViewer);

  const unauthorized = connect(url, {
    auth: { sessionId: session.session.id, token: session.mobileToken, role: "viewer" },
    reconnection: false,
    transports: ["websocket"],
  });
  const authError = await waitForEvent(unauthorized, "connect_error");
  assert.equal(authError.message, "unauthorized");
  unauthorized.disconnect();

  assert.equal(ioServer.sockets.adapter.rooms.get(session.session.id)?.size, 2);
  assert.equal(ioServer.sockets.adapter.rooms.get(otherSession.session.id)?.size, 1);

  const invalidRoleError = waitForEvent(mobile, "signaling-error");
  mobile.emit("answer", { description: { type: "answer", sdp: "v=0\r\n" } });
  assert.equal((await invalidRoleError).message, "Invalid answer.");

  const offer = { type: "offer", sdp: "v=0\r\n" };
  const receivedOffer = waitForEvent(viewer, "offer");
  const unexpectedOtherOffer = waitForEvent(otherViewer, "offer", 150)
    .then(() => assert.fail("Offer crossed into another session."))
    .catch((error) => {
      if (error.message !== "Timed out waiting for offer.") throw error;
    });
  mobile.emit("offer", { description: offer });
  assert.deepEqual(await receivedOffer, { description: offer });
  await unexpectedOtherOffer;

  const answer = { type: "answer", sdp: "v=0\r\n" };
  const receivedAnswer = waitForEvent(mobile, "answer");
  viewer.emit("answer", { description: answer });
  assert.deepEqual(await receivedAnswer, { description: answer });

  const candidate = { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
  const receivedCandidate = waitForEvent(viewer, "ice-candidate");
  mobile.emit("ice-candidate", { candidate });
  assert.deepEqual(await receivedCandidate, { candidate });
});