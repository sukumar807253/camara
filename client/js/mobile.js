const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get("session");
const token = params.get("token");
history.replaceState(null, "", location.pathname);

const startButton = document.querySelector("#start-camera");
const stopButton = document.querySelector("#stop-camera");
const switchButton = document.querySelector("#switch-camera");
const disconnectButton = document.querySelector("#disconnect");
const preview = document.querySelector("#local-video");
const placeholder = document.querySelector("#camera-placeholder");
const errorBox = document.querySelector("#camera-error");
let socket = null;
let peer = null;
let stream = null;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let pendingCandidates = [];
let facingMode = "environment";
let makingOffer = false;
let viewerConnected = false;
let cameraPromptAttempted = false;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function setConnection(connected, message) {
  document.querySelector("#connection-label").textContent = message;
  document.querySelector("#connection-dot").className = `status-dot ${connected ? "good" : "bad"}`;
}

function setCameraActive(active) {
  document.querySelector("#camera-label").textContent = active ? "LIVE PREVIEW" : "OFF";
  document.querySelector("#camera-dot").className = `status-dot ${active ? "good" : ""}`;
  placeholder.hidden = active;
  startButton.hidden = active;
  startButton.disabled = active;
  stopButton.disabled = !active;
  switchButton.disabled = !active;
}

async function loadIceServers() {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ice`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load connection settings.");
  iceServers = result.iceServers;
}

function createPeer() {
  if (!stream || !viewerConnected || !window.RTCPeerConnection) return null;
  closePeer();
  peer = new RTCPeerConnection({ iceServers });
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && socket?.connected) socket.emit("ice-candidate", { candidate: candidate.toJSON() });
  };
  peer.onconnectionstatechange = () => {
    if (peer?.connectionState === "connected") setConnection(true, "Connected to viewer · streaming");
    if (["failed", "disconnected"].includes(peer?.connectionState)) {
      setConnection(false, "Viewer connection interrupted");
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (peer?.iceConnectionState === "failed") showError("Network path failed. Check TURN configuration and reconnect the viewer.");
  };
  return peer;
}

function closePeer() {
  if (peer) {
    peer.onicecandidate = null;
    peer.onconnectionstatechange = null;
    peer.close();
  }
  peer = null;
  pendingCandidates = [];
  makingOffer = false;
}

async function maybeOffer() {
  if (!stream || !viewerConnected || !socket?.connected || makingOffer) return;
  if (!peer || peer.signalingState === "closed") createPeer();
  if (!peer || peer.signalingState !== "stable") return;
  makingOffer = true;
  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("offer", { description: peer.localDescription.toJSON() });
    setConnection(true, "Connecting to viewer…");
  } catch (error) {
    showError(`Could not start the video connection: ${error.message}`);
  } finally {
    makingOffer = false;
  }
}

async function applyPendingCandidates() {
  if (!peer?.remoteDescription) return;
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    try { await peer.addIceCandidate(candidate); } catch { /* Stale candidates can arrive during reconnect. */ }
  }
}

async function startCamera() {
  if (!sessionId || !token) return showError("This invitation link is incomplete. Create a new session from the dashboard.");
  if (!navigator.mediaDevices?.getUserMedia) return showError("Camera access requires HTTPS and a supported browser.");
  if (!socket?.connected) return showError("The secure session is not connected yet. Check your internet connection and retry.");

  clearError();
  startButton.disabled = true;
  startButton.textContent = "Waiting for permission…";
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode } },
      audio: false,
    });
    stream = newStream;
    preview.srcObject = stream;
    setCameraActive(true);
    await loadIceServers();
    socket.emit("camera-state", { active: true });
    if (viewerConnected) {
      createPeer();
      await maybeOffer();
    } else {
      setConnection(true, "Camera ready · waiting for viewer");
    }
  } catch (error) {
    newStream?.getTracks().forEach((track) => track.stop());
    stream = null;
    preview.srcObject = null;
    setCameraActive(false);
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      showError("Camera permission was denied. Allow camera access in your browser settings, then try again.");
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      showError("No camera was found on this device.");
    } else if (error.name === "NotReadableError") {
      showError("The camera is already in use by another app. Close it and retry.");
    } else {
      showError(error.message || "Could not start the camera. Check browser permissions and HTTPS.");
    }
  } finally {
    startButton.textContent = "Allow camera";
    startButton.disabled = Boolean(stream);
  }
}

function stopCamera() {
  if (socket?.connected) {
    socket.emit("camera-state", { active: false });
    socket.emit("camera-stopped");
  }
  closePeer();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  preview.srcObject = null;
  setCameraActive(false);
  setConnection(Boolean(socket?.connected), socket?.connected ? "Connected · camera off" : "Disconnected");
}

async function switchCamera() {
  const nextFacingMode = facingMode === "environment" ? "user" : "environment";
  switchButton.disabled = true;
  clearError();
  let nextStream;
  try {
    nextStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: nextFacingMode } },
      audio: false,
    });
    const nextTrack = nextStream.getVideoTracks()[0];
    const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
    if (sender) await sender.replaceTrack(nextTrack);
    const previousStream = stream;
    stream = nextStream;
    preview.srcObject = stream;
    facingMode = nextFacingMode;
    previousStream?.getTracks().forEach((track) => track.stop());
  } catch (error) {
    nextStream?.getTracks().forEach((track) => track.stop());
    showError(error.name === "NotAllowedError" ? "Camera permission is needed to switch cameras." : `Could not switch camera: ${error.message}`);
  } finally {
    switchButton.disabled = !stream;
  }
}

function connectSignaling() {
  if (!sessionId || !token) {
    setConnection(false, "Invalid invitation link");
    showError("This invitation link is incomplete. Create a new session from the dashboard.");
    startButton.disabled = true;
    return;
  }
  socket = io({
    auth: { sessionId, token, role: "mobile" },
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelayMax: 5000,
  });

  socket.on("connect", () => {
    setConnection(true, "Secure signaling connected");
    if (stream) socket.emit("camera-state", { active: true });
    else if (!cameraPromptAttempted) {
      cameraPromptAttempted = true;
      startCamera();
    }
  });
  socket.on("connect_error", (error) => {
    setConnection(false, error.message === "unauthorized" ? "Invitation invalid or expired" : "Could not connect to session");
  });
  socket.on("disconnect", () => {
    viewerConnected = false;
    closePeer();
    setConnection(false, "Signaling disconnected");
  });
  socket.on("peer-status", (status) => {
    viewerConnected = status.viewerConnected;
    if (!status.mobileConnected) return;
    if (stream && viewerConnected) {
      if (!peer || peer.signalingState === "closed") createPeer();
      maybeOffer();
    } else if (!viewerConnected) {
      closePeer();
      setConnection(true, stream ? "Camera ready · waiting for viewer" : "Connected · camera off");
    }
  });
  socket.on("answer", async ({ description } = {}) => {
    if (!peer || description?.type !== "answer") return;
    try {
      await peer.setRemoteDescription(description);
      await applyPendingCandidates();
    } catch (error) {
      showError(`Could not complete the video connection: ${error.message}`);
    }
  });
  socket.on("ice-candidate", async ({ candidate } = {}) => {
    if (!peer || !candidate) return;
    if (!peer.remoteDescription) pendingCandidates.push(candidate);
    else {
      try { await peer.addIceCandidate(candidate); } catch { /* Candidate can belong to a prior ICE restart. */ }
    }
  });
  socket.on("renegotiate", () => maybeOffer());
  socket.on("camera-stopped", () => {});
  socket.on("session-expired", () => {
    stopCamera();
    socket.disconnect();
    showError("This camera session has expired.");
    startButton.disabled = true;
  });
  socket.on("signaling-error", ({ message }) => showError(message || "Signaling error."));
}

startButton.addEventListener("click", startCamera);
stopButton.addEventListener("click", stopCamera);
switchButton.addEventListener("click", switchCamera);
disconnectButton.addEventListener("click", () => {
  stopCamera();
  socket?.disconnect();
  setConnection(false, "Session disconnected");
  startButton.disabled = true;
  disconnectButton.disabled = true;
});

window.addEventListener("online", () => {
  document.querySelector("#internet-label").textContent = "Online";
  document.querySelector("#internet-dot").className = "status-dot good";
});
window.addEventListener("offline", () => {
  document.querySelector("#internet-label").textContent = "Offline";
  document.querySelector("#internet-dot").className = "status-dot bad";
});
document.querySelector("#internet-label").textContent = navigator.onLine ? "Online" : "Offline";
document.querySelector("#internet-dot").className = `status-dot ${navigator.onLine ? "good" : "bad"}`;
window.addEventListener("pagehide", () => {
  stream?.getTracks().forEach((track) => track.stop());
  socket?.disconnect();
});

connectSignaling();