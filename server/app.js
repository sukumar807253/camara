require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER_EXTERNAL_URL);
const configuredBaseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
const baseUrl = configuredBaseUrl || `http://localhost:${process.env.PORT || 3000}`;

if (isProduction) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || /replace-me|replace-with/i.test(process.env.SESSION_SECRET)) {
    throw new Error("Production requires a SESSION_SECRET with at least 32 characters.");
  }
  if (!configuredBaseUrl) {
    throw new Error("Production requires BASE_URL or Render's RENDER_EXTERNAL_URL.");
  }
  const productionUrl = new URL(baseUrl);
  if (productionUrl.protocol !== "https:" || /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(productionUrl.hostname) || /\.example$/i.test(productionUrl.hostname)) {
    throw new Error("Production BASE_URL must be a public HTTPS origin, not localhost or an example host.");
  }
}

const express = require("express");
const helmet = require("helmet");
const http = require("node:http");
const path = require("node:path");
const { rateLimit } = require("express-rate-limit");
const { Server } = require("socket.io");
const { getIceServers, hasTurnServer } = require("../config/iceServers");
const { requireSessionToken } = require("./middleware/auth");
const { requireSecureTransport, requireSocketSecureTransport } = require("./middleware/security");
const { installSignaling } = require("./signaling");
const sessions = require("./sessionManager");

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 3000;
const ttlSeconds = Math.min(Math.max(Number(process.env.SESSION_TTL_SECONDS) || 1800, 60), 86400);
const host = process.env.RENDER_EXTERNAL_URL ? "0.0.0.0" : process.env.HOST || "0.0.0.0";

if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

const allowedOrigin = new URL(baseUrl).origin;
const io = new Server(server, {
  maxHttpBufferSize: 300 * 1024,
  cors: { origin: allowedOrigin, methods: ["GET", "POST"] },
});

app.disable("x-powered-by");
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "no-referrer" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      ...(process.env.NODE_ENV === "production" ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: process.env.NODE_ENV === "production" ? undefined : false,
}));
app.get("/healthz", (req, res) => {
  res.set("Cache-Control", "no-store").status(200).json({ status: "ok" });
});
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(self), microphone=()");
  next();
});
app.use(requireSecureTransport);
app.use(express.json({ limit: "16kb", type: "application/json" }));

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sessions created. Try again later." },
});
const sessionReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.post("/api/sessions", createLimiter, (req, res) => {
  if (req.body && Object.keys(req.body).length) {
    return res.status(400).json({ error: "This endpoint does not accept a request body." });
  }
  const { session, mobileToken, viewerToken } = sessions.createSession(ttlSeconds);
  const origin = new URL(baseUrl).origin;
  const mobileUrl = new URL("/mobile.html", origin);
  mobileUrl.hash = new URLSearchParams({ session: session.id, token: mobileToken }).toString();
  const viewerUrl = new URL("/viewer.html", origin);
  viewerUrl.hash = new URLSearchParams({ session: session.id, token: viewerToken }).toString();

  res.set("Cache-Control", "no-store").status(201).json({
    sessionId: session.id,
    mobileUrl: mobileUrl.toString(),
    viewerUrl: viewerUrl.toString(),
    expiresAt: session.expiresAt,
    ttlSeconds,
    turnConfigured: hasTurnServer(),
  });
});

app.get("/api/sessions/:sessionId/status", sessionReadLimiter, requireSessionToken, (req, res) => {
  const session = sessions.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found or expired." });
  res.set("Cache-Control", "no-store").json({
    mobileConnected: Boolean(session.mobileSocketId),
    viewerConnected: Boolean(session.viewerSocketId),
    cameraActive: session.cameraActive,
    expiresAt: session.expiresAt,
  });
});

app.get("/api/sessions/:sessionId/ice", sessionReadLimiter, requireSessionToken, (req, res) => {
  if (!sessions.getSession(req.params.sessionId)) {
    return res.status(404).json({ error: "Session not found or expired." });
  }
  res.set("Cache-Control", "no-store").json({
    iceServers: getIceServers(req.session.expiresAt),
    turnConfigured: hasTurnServer(),
  });
});

app.use(express.static(path.join(__dirname, "../client"), {
  index: "index.html",
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  setHeaders(res, path) {
    if (/\.(html|js|css)$/.test(path)) res.setHeader("Cache-Control", "no-cache");
  },
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ error: status === 400 ? "Invalid request." : "Internal server error." });
});

io.use(requireSocketSecureTransport);
installSignaling(io);

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.listSessions()) {
    if (session.expiresAt <= now) {
      io.to(session.id).emit("session-expired");
      io.in(session.id).disconnectSockets(true);
      sessions.removeSession(session.id);
    }
  }
  sessions.cleanup(now);
}, 15 * 1000);
cleanupTimer.unref();

server.listen(port, host, () => {
  if (!process.env.SESSION_SECRET) {
    console.warn("SESSION_SECRET is unset. Set a long random value before production deployment.");
  }
  if (!hasTurnServer()) {
    console.warn("TURN is not configured; connections requiring relay will not work.");
  }
  console.log(`Camera streaming server listening on ${host}:${port}`);
});

function shutdown() {
  clearInterval(cleanupTimer);
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);