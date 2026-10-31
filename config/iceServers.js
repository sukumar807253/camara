const crypto = require("node:crypto");
const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

function isPlaceholder(value) {
  return /replace-me|your-domain\.example|(?:^|[.:/])[^/?]*\.example(?:[:/?]|$)/i.test(value || "");
}

function parseUrls(value, protocolPattern) {
  return (value || "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => protocolPattern.test(url) && !isPlaceholder(url));
}

function configuredStunUrls() {
  if (process.env.STUN_URL === undefined) return [DEFAULT_STUN_URL];
  return parseUrls(process.env.STUN_URL, /^stuns?:[^\s,]+$/i);
}

function configuredTurnUrls() {
  return parseUrls(process.env.TURN_URL, /^turns?:[^\s,]+$/i);
}

function turnCredentials(sessionExpiresAt) {
  if (process.env.TURN_SHARED_SECRET && !isPlaceholder(process.env.TURN_SHARED_SECRET)) {
    const expiresAt = Math.floor(sessionExpiresAt / 1000);
    const baseUsername = isPlaceholder(process.env.TURN_USERNAME) ? "camera" : (process.env.TURN_USERNAME || "camera");
    const username = `${expiresAt}:${baseUsername}`;
    const credential = crypto
      .createHmac("sha1", process.env.TURN_SHARED_SECRET)
      .update(username)
      .digest("base64");
    return { username, credential };
  }

  if (
    process.env.TURN_USERNAME &&
    process.env.TURN_PASSWORD &&
    !isPlaceholder(process.env.TURN_USERNAME) &&
    !isPlaceholder(process.env.TURN_PASSWORD)
  ) {
    return { username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD };
  }

  return null;
}

function getIceServers(sessionExpiresAt) {
  const iceServers = [];
  const stunUrls = configuredStunUrls();
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  const urls = configuredTurnUrls();
  const credentials = turnCredentials(sessionExpiresAt);
  if (urls.length && credentials) iceServers.push({ urls, ...credentials });

  return iceServers;
}

function hasTurnServer() {
  return configuredTurnUrls().length > 0 && Boolean(turnCredentials(Date.now() + 60_000));
}

module.exports = { getIceServers, hasTurnServer };