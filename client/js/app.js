const createButton = document.querySelector("#create-session");
const createError = document.querySelector("#create-error");
const linksPanel = document.querySelector("#links-panel");
let activeSession = null;
let statusTimer = null;

createButton.addEventListener("click", async () => {
  createButton.disabled = true;
  createButton.textContent = "Creating private session…";
  createError.hidden = true;

  try {
    const response = await fetch("/api/sessions", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create session.");
    activeSession = result;
    document.querySelector("#mobile-link").value = result.mobileUrl;
    document.querySelector("#viewer-link").value = result.viewerUrl;
    document.querySelector("#session-id").textContent = result.sessionId;
    document.querySelector("#expiry-label").textContent = new Date(result.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    document.querySelector("#session-meta").hidden = false;
    linksPanel.hidden = false;
    document.querySelector("#session-state").innerHTML = '<span class="status-dot good"></span> Session active';
    document.querySelector("#transport-note").textContent = result.turnConfigured
      ? "TURN credentials are configured, but relay reachability has not been tested."
      : "TURN is unavailable. Some mobile carrier or restrictive networks will not connect; STUN alone cannot guarantee connectivity.";
    document.querySelector("#turn-notice").textContent = result.turnConfigured
      ? "TURN credentials are present; confirm the selected ICE candidate is relay to verify coturn connectivity."
      : "No usable TURN credentials are configured. Direct connections may work, but networks that require relay will fail.";
    document.querySelector("#mobile-state").textContent = "Waiting for phone to open invitation";
    document.querySelector("#viewer-state").textContent = "Waiting for viewer link";
    document.querySelector("#mobile-dot").className = "status-dot warn";
    document.querySelector("#viewer-dot").className = "status-dot warn";
    pollStatus();
    clearInterval(statusTimer);
    statusTimer = setInterval(pollStatus, 4000);
  } catch (error) {
    createError.textContent = error.message;
    createError.hidden = false;
  } finally {
    createButton.disabled = false;
    createButton.innerHTML = '<span aria-hidden="true">＋</span> Create secure session';
  }
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const input = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1400);
    } catch {
      input.select();
      document.execCommand("copy");
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1400);
    }
  });
});

async function pollStatus() {
  if (!activeSession) return;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(activeSession.sessionId)}/status`, {
      headers: { Authorization: `Bearer ${new URLSearchParams(new URL(activeSession.viewerUrl).hash.slice(1)).get("token")}` },
      cache: "no-store",
    });
    if (response.status === 404 || response.status === 401) {
      clearInterval(statusTimer);
      document.querySelector("#session-state").innerHTML = '<span class="status-dot bad"></span> Session expired';
      document.querySelector("#mobile-state").textContent = "Invitation has expired";
      document.querySelector("#mobile-dot").className = "status-dot bad";
      return;
    }
    if (!response.ok) return;
    const status = await response.json();
    document.querySelector("#mobile-state").textContent = status.cameraActive ? "Camera streaming" : status.mobileConnected ? "Connected · camera off" : "Waiting for phone";
    document.querySelector("#mobile-dot").className = `status-dot ${status.cameraActive || status.mobileConnected ? "good" : "warn"}`;
    document.querySelector("#viewer-state").textContent = status.viewerConnected ? "Viewer connected" : "Waiting for viewer link";
    document.querySelector("#viewer-dot").className = `status-dot ${status.viewerConnected ? "good" : "warn"}`;
  } catch {
    document.querySelector("#mobile-state").textContent = "Status temporarily unavailable";
  }
}