const crypto = require("node:crypto");

const IDLE_TTL_MS = 5 * 60 * 1000;
const sessions = new Map();
const digestSecret = process.env.SESSION_SECRET || crypto.randomBytes(32);

function tokenDigest(token) {
  return crypto.createHmac("sha256", digestSecret).update(token).digest();
}

function matchesToken(token, expectedDigest) {
  if (typeof token !== "string" || token.length > 256) return false;
  const actual = tokenDigest(token);
  return actual.length === expectedDigest.length && crypto.timingSafeEqual(actual, expectedDigest);
}

function createSession(ttlSeconds) {
  const sessionId = crypto.randomBytes(18).toString("base64url");
  const mobileToken = crypto.randomBytes(32).toString("base64url");
  const viewerToken = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    id: sessionId,
    mobileTokenDigest: tokenDigest(mobileToken),
    viewerTokenDigest: tokenDigest(viewerToken),
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    lastActivityAt: now,
    mobileSocketId: null,
    viewerSocketId: null,
    cameraActive: false,
  };

  sessions.set(sessionId, session);
  return { session, mobileToken, viewerToken };
}

function getSession(sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{20,32}$/.test(sessionId)) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    if (!session.mobileSocketId && !session.viewerSocketId) sessions.delete(sessionId);
    return null;
  }
  return session;
}

function authenticate(sessionId, role, token) {
  const session = getSession(sessionId);
  if (!session || (role !== "mobile" && role !== "viewer")) return null;
  const expected = role === "mobile" ? session.mobileTokenDigest : session.viewerTokenDigest;
  return matchesToken(token, expected) ? session : null;
}

function touch(session) {
  session.lastActivityAt = Date.now();
}

function removeSession(sessionId) {
  return sessions.delete(sessionId);
}

function listSessions() {
  return [...sessions.values()];
}

function cleanup(now = Date.now()) {
  for (const [sessionId, session] of sessions) {
    const expired = session.expiresAt <= now;
    const idle = !session.mobileSocketId &&
      !session.viewerSocketId &&
      now - session.lastActivityAt >= IDLE_TTL_MS;
    if (expired || idle) sessions.delete(sessionId);
  }
}

module.exports = {
  authenticate,
  cleanup,
  createSession,
  getSession,
  listSessions,
  removeSession,
  touch,
};