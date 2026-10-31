const { authenticate } = require("../sessionManager");

function requireSessionToken(req, res, next) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(req.get("authorization") || "");
  if (!match) return res.status(401).json({ error: "Session authorization required." });
  const mobileSession = authenticate(req.params.sessionId, "mobile", match[1]);
  const viewerSession = authenticate(req.params.sessionId, "viewer", match[1]);
  if (!mobileSession && !viewerSession) {
    return res.status(401).json({ error: "Invalid or expired session authorization." });
  }

  req.session = mobileSession || viewerSession;
  next();
}

module.exports = { requireSessionToken };