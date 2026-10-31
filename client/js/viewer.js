const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get("session");
const token = params.get("token");
history.replaceState(null, "", location.pathname);

const video = document.querySelector("#remote-video");
const placeholder = document.querySelector("#viewer-placeholder");
const errorBox = document.querySelector("#viewer-error");
let socket = null;
let peer = null;
let iceServers = null;
let pendingCandidates = [];
let statsTimer = null;
let mobileConnected = false;
let turnConfigured = false;
let stopped = false;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function setMobileStatus(connected, cameraActive) {
  mobileConnected = connected;
  document.querySelector("#mobile-state").textContent = connected
    ? cameraActive ? "Camera streaming" : "Mobile connected · camera off"
    : "Mobile disconnected";
  document.querySelector("#mobile-dot").className = `status-dot ${connected ? cameraActive ? "good" : "warn" : "bad"}`;
}

function setVideoActive(active) {
  document.querySelector("#stream-label").textContent = active ? "LIVE" : "NO VIDEO";
  document.querySelector("#stream-dot").className = `status-dot ${active ? "good" : ""}`;
  placeholder.hidden = active;
}

async function loadIceServers() {
  if (iceServers) return;
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ice`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load connection settings.");
  iceServers = result.iceServers;
  turnConfigured = result.turnConfigured;
  const turnWarning = document.querySelector("#turn-warning");
  turnWarning.textContent = turnConfigured
    ? "TURN credentials are configured, but relay reachability is unverified. Confirm a relay ICE candidate."
    : "TURN is unavailable. Some mobile networks require a TURN relay; STUN alone cannot guarantee a connection.";
  turnWarning.hidden = false;
  if (!turnConfigured) document.querySelector("#quality-label").textContent = "TURN unavailable · direct path may fail";
}

function closePeer() {
  clearInterval(statsTimer);
  if (peer) {
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.close();
  }
  peer = null;
  pendingCandidates = [];
  video.srcObject = null;
  setVideoActive(false);
  document.querySelector("#candidate-label").textContent = "Not connected";
  document.querySelector("#quality-label").textContent = turnConfigured ? "TURN configured · awaiting peer" : "TURN unavailable · direct path may fail";
}

function createPeer() {
  closePeer();
  peer = new RTCPeerConnection({ iceServers });
  peer.ontrack = ({ streams }) => {
    if (streams[0]) video.srcObject = streams[0];
    setVideoActive(true);
    video.play().catch(() => {});
  };
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && socket?.connected) socket.emit("ice-candidate", { candidate: candidate.toJSON() });
  };
  peer.onconnectionstatechange = () => {
    const state = peer?.connectionState;
    if (state === "connected") {
      document.querySelector("#quality-label").textContent = "Connected · measuring…";
      clearInterval(statsTimer);
      statsTimer = setInterval(readConnectionStats, 2500);
      readConnectionStats();
    } else if (state === "failed") {
      document.querySelector("#quality-label").textContent = "Connection failed";
      showError("The peer connection failed. Check the TURN server and network, then reconnect.");
    } else if (state === "disconnected") {
      document.querySelector("#quality-label").textContent = "Reconnecting…";
    }
  };
  return peer;
}

async function applyPendingCandidates() {
  if (!peer?.remoteDescription) return;
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    try { await peer.addIceCandidate(candidate); } catch { /* Stale candidates can arrive during reconnect. */ }
  }
}

async function handleOffer({ description } = {}) {
  if (stopped || description?.type !== "offer") return;
  try {
    await loadIceServers();
    const candidatesBeforeOffer = pendingCandidates;
    const connection = createPeer();
    pendingCandidates = candidatesBeforeOffer;
    await connection.setRemoteDescription(description);
    await applyPendingCandidates();
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    socket.emit("answer", { description: connection.localDescription.toJSON() });
    document.querySelector("#quality-label").textContent = "Negotiating connection…";
  } catch (error) {
    showError(`Could not join the camera stream: ${error.message}`);
  }
}

async function readConnectionStats() {
  if (!peer) return;
  try {
    const stats = await peer.getStats();
    const reports = [...stats.values()];
    const transport = reports.find((item) => item.type === "transport" && item.selectedCandidatePairId);
    const pair = transport
      ? stats.get(transport.selectedCandidatePairId)
      : reports.find((item) => item.type === "candidate-pair" && item.state === "succeeded" && (item.selected || item.nominated));
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const localType = local?.candidateType || "unknown";
    const remoteType = remote?.candidateType || "unknown";
    document.querySelector("#candidate-label").textContent = `${localType} <-> ${remoteType}`;
    const rttMs = Math.round((pair.currentRoundTripTime || 0) * 1000);
    const relay = localType === "relay" || remoteType === "relay";
    const label = rttMs ? `${rttMs} ms${relay ? " · relay" : ""}` : relay ? "Connected · relay" : "Connected · direct";
    document.querySelector("#quality-label").textContent = label;
  } catch {
    document.querySelector("#quality-label").textContent = "Connected · stats unavailable";
  }
}

function connectSignaling() {
  if (!sessionId || !token) {
    showError("This viewer link is incomplete. Create a new session from the dashboard.");
    document.querySelector("#reconnect").disabled = true;
    return;
  }
  stopped = false;
  socket = io({
    auth: { sessionId, token, role: "viewer" },
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelayMax: 5000,
  });
  socket.on("connect", () => {
    document.querySelector("#expiry-label").textContent = "Signaling connected";
    errorBox.hidden = true;
  });
  socket.on("connect_error", (error) => {
    document.querySelector("#expiry-label").textContent = error.message === "unauthorized" ? "Invitation expired" : "Connection unavailable";
    if (error.message === "unauthorized") showError("This viewer invitation is invalid or expired.");
  });
  socket.on("disconnect", () => {
    setMobileStatus(false, false);
    document.querySelector("#quality-label").textContent = "Signaling disconnected";
  });
  socket.on("peer-status", (status) => {
    setMobileStatus(status.mobileConnected, status.cameraActive);
    if (status.expiresAt) {
      document.querySelector("#expiry-label").textContent = `Expires ${new Date(status.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    if (status.mobileConnected && status.cameraActive) socket.emit("request-offer");
  });
  socket.on("offer", handleOffer);
  socket.on("ice-candidate", async ({ candidate } = {}) => {
    if (!candidate) return;
    if (!peer || !peer.remoteDescription) pendingCandidates.push(candidate);
    else {
      try { await peer.addIceCandidate(candidate); } catch { /* Candidate can belong to a prior ICE restart. */ }
    }
  });
  socket.on("camera-stopped", () => closePeer());
  socket.on("session-expired", () => {
    closePeer();
    setMobileStatus(false, false);
    showError("This camera session has expired.");
    socket.disconnect();
  });
  socket.on("signaling-error", ({ message }) => showError(message || "Signaling error."));
}

document.querySelector("#fullscreen").addEventListener("click", async () => {
  const stage = document.querySelector("#viewer-stage");
  if (document.fullscreenElement) await document.exitFullscreen();
  else await stage.requestFullscreen?.();
});
document.querySelector("#reconnect").addEventListener("click", () => {
  errorBox.hidden = true;
  if (!socket?.connected) {
    socket?.disconnect();
    connectSignaling();
    return;
  }
  closePeer();
  socket.emit("request-offer");
});
document.querySelector("#stop-viewing").addEventListener("click", () => {
  stopped = true;
  closePeer();
  socket?.disconnect();
  setMobileStatus(false, false);
  document.querySelector("#quality-label").textContent = "Viewing stopped";
});
window.addEventListener("pagehide", () => {
  closePeer();
  socket?.disconnect();
});

connectSignaling();