const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { getIceServers, hasTurnServer } = require("../config/iceServers");

const envKeys = ["STUN_URL", "TURN_URL", "TURN_USERNAME", "TURN_PASSWORD", "TURN_SHARED_SECRET"];

function withTurnEnv(values, callback) {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    callback();
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("STUN remains available and example TURN values stay disabled", () => {
  withTurnEnv({
    STUN_URL: "stun:stun.l.google.com:19302",
    TURN_URL: "turn:turn.example:3478",
    TURN_USERNAME: "replace-me",
    TURN_PASSWORD: "replace-me",
  }, () => {
    assert.deepEqual(getIceServers(Date.now() + 60_000), [
      { urls: ["stun:stun.l.google.com:19302"] },
    ]);
    assert.equal(hasTurnServer(), false);
  });
});

test("coturn shared-secret credentials are time-limited and session-scoped", () => {
  const expiresAt = Date.now() + 5 * 60 * 1000;
  withTurnEnv({
    STUN_URL: "stun:stun.l.google.com:19302",
    TURN_URL: "turn:relay.invalid:3478,turns:relay.invalid:5349",
    TURN_USERNAME: "fieldlink",
    TURN_SHARED_SECRET: "test-shared-secret",
  }, () => {
    const iceServers = getIceServers(expiresAt);
    assert.equal(hasTurnServer(), true);
    assert.deepEqual(iceServers[0], { urls: ["stun:stun.l.google.com:19302"] });
    assert.deepEqual(iceServers[1].urls, [
      "turn:relay.invalid:3478",
      "turns:relay.invalid:5349",
    ]);
    const [usernameExpiry, username] = iceServers[1].username.split(":");
    assert.equal(username, "fieldlink");
    assert.equal(Number(usernameExpiry), Math.floor(expiresAt / 1000));
    const expectedCredential = crypto
      .createHmac("sha1", "test-shared-secret")
      .update(iceServers[1].username)
      .digest("base64");
    assert.equal(iceServers[1].credential, expectedCredential);
  });
});

test("STUN URLs are configurable and placeholder TURN secrets remain disabled", () => {
  withTurnEnv({
    STUN_URL: "stun:stun-one.invalid:3478,stuns:stun-two.invalid:5349",
    TURN_URL: "turn:relay.example:3478",
    TURN_SHARED_SECRET: "replace-with-a-real-secret",
  }, () => {
    const iceServers = getIceServers(Date.now() + 60_000);
    assert.deepEqual(iceServers, [{
      urls: ["stun:stun-one.invalid:3478", "stuns:stun-two.invalid:5349"],
    }]);
    assert.equal(hasTurnServer(), false);
  });
});