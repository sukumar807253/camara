const test = require("node:test");
const assert = require("node:assert/strict");
const sessions = require("../server/sessionManager");

test("session creates separate, role-bound credentials", () => {
  const created = sessions.createSession(3600);
  try {
    assert.match(created.session.id, /^[A-Za-z0-9_-]{20,32}$/);
    assert.notEqual(created.mobileToken, created.viewerToken);
    assert.equal(sessions.authenticate(created.session.id, "mobile", created.mobileToken), created.session);
    assert.equal(sessions.authenticate(created.session.id, "viewer", created.viewerToken), created.session);
    assert.equal(sessions.authenticate(created.session.id, "viewer", created.mobileToken), null);
    assert.equal(sessions.authenticate(created.session.id, "mobile", "incorrect-token"), null);
  } finally {
    sessions.removeSession(created.session.id);
  }
});

test("expired sessions cannot be authenticated", () => {
  const created = sessions.createSession(0);
  assert.equal(sessions.getSession(created.session.id), null);
  assert.equal(sessions.authenticate(created.session.id, "mobile", created.mobileToken), null);
});

test("inactive disconnected sessions are cleaned up", () => {
  const created = sessions.createSession(3600);
  created.session.lastActivityAt = Date.now() - 6 * 60 * 1000;
  sessions.cleanup();
  assert.equal(sessions.getSession(created.session.id), null);
});