const test = require("node:test");
const assert = require("node:assert/strict");
const { requireSecureTransport, requireSocketSecureTransport } = require("../server/middleware/security");

test("production HTTP is rejected unless a secure request or trusted proxy is used", () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousTrustProxy = process.env.TRUST_PROXY;
  process.env.NODE_ENV = "production";

  try {
    process.env.TRUST_PROXY = "0";
    let nextCalled = false;
    const response = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    requireSecureTransport({ secure: false }, response, () => { nextCalled = true; });
    assert.equal(response.statusCode, 400);
    assert.equal(nextCalled, false);

    let socketError;
    const socket = {
      request: { secure: false },
      handshake: { headers: { "x-forwarded-proto": "https" } },
    };
    requireSocketSecureTransport(socket, (error) => { socketError = error; });
    assert.equal(socketError?.message, "HTTPS is required.");

    process.env.TRUST_PROXY = "1";
    let proxySocketError = "not-called";
    requireSocketSecureTransport(socket, (error) => { proxySocketError = error || null; });
    assert.equal(proxySocketError, null);
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
  }
});