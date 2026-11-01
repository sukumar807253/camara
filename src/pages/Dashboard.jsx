import React, { useState, useEffect, useRef } from 'react';
import Header from '../components/Header';
import StatusDot from '../components/StatusDot';
import QrCodeModal from '../components/QrCodeModal';
import { 
  Plus, 
  Smartphone, 
  Monitor, 
  Copy, 
  Check, 
  ExternalLink, 
  QrCode, 
  ShieldCheck, 
  AlertCircle, 
  Clock, 
  Radio, 
  Info,
  Lock
} from 'lucide-react';

export default function Dashboard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionData, setSessionData] = useState(null);
  const [sessionStatus, setSessionStatus] = useState({
    mobileConnected: false,
    viewerConnected: false,
    cameraActive: false,
    expired: false,
  });
  const [copiedKey, setCopiedKey] = useState(null);
  const [showQrFor, setShowQrFor] = useState(null);

  const statusTimerRef = useRef(null);

  const extractViewerToken = (viewerUrl) => {
    try {
      const hash = new URL(viewerUrl).hash.slice(1);
      return new URLSearchParams(hash).get('token') || '';
    } catch {
      return '';
    }
  };

  const handleCreateSession = async () => {
    setLoading(true);
    setError('');
    clearInterval(statusTimerRef.current);

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create session');

      setSessionData(data);
      setSessionStatus({
        mobileConnected: false,
        viewerConnected: false,
        cameraActive: false,
        expired: false,
      });

      // Start polling
      pollStatus(data);
      statusTimerRef.current = setInterval(() => pollStatus(data), 4000);
    } catch (err) {
      setError(err.message || 'Unable to create session. Check connection and retry.');
    } finally {
      setLoading(false);
    }
  };

  const pollStatus = async (session) => {
    if (!session?.sessionId || !session?.viewerUrl) return;
    const token = extractViewerToken(session.viewerUrl);

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });

      if (res.status === 404 || res.status === 401) {
        clearInterval(statusTimerRef.current);
        setSessionStatus((prev) => ({ ...prev, expired: true }));
        return;
      }

      if (!res.ok) return;
      const status = await res.json();
      setSessionStatus({
        mobileConnected: Boolean(status.mobileConnected),
        viewerConnected: Boolean(status.viewerConnected),
        cameraActive: Boolean(status.cameraActive),
        expired: false,
      });
    } catch {
      // transient network poll failure
    }
  };

  useEffect(() => {
    return () => clearInterval(statusTimerRef.current);
  }, []);

  const copyToClipboard = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Fallback
    }
  };

  // Helper status calculations
  const getSessionStateBadge = () => {
    if (!sessionData) return { label: 'No session', dot: 'neutral' };
    if (sessionStatus.expired) return { label: 'Session expired', dot: 'bad' };
    return { label: 'Session active', dot: 'good', pulse: true };
  };

  const getMobileState = () => {
    if (!sessionData) return { text: 'Waiting for a session', dot: 'neutral' };
    if (sessionStatus.expired) return { text: 'Invitation has expired', dot: 'bad' };
    if (sessionStatus.cameraActive) return { text: 'Camera streaming live', dot: 'good' };
    if (sessionStatus.mobileConnected) return { text: 'Connected · camera off', dot: 'good' };
    return { text: 'Waiting for phone to open invitation', dot: 'warn' };
  };

  const getViewerState = () => {
    if (!sessionData) return { text: 'Open the viewer link to connect', dot: 'neutral' };
    if (sessionStatus.expired) return { text: 'Session expired', dot: 'bad' };
    if (sessionStatus.viewerConnected) return { text: 'Viewer connected', dot: 'good' };
    return { text: 'Waiting for viewer link', dot: 'warn' };
  };

  const sessionBadge = getSessionStateBadge();
  const mobileState = getMobileState();
  const viewerState = getViewerState();

  const expiryTimeFormatted = sessionData?.expiresAt
    ? new Date(sessionData.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : 'in 30 minutes';

  return (
    <div className="min-h-screen bg-[#0c1015] text-slate-100 flex flex-col font-sans">
      <Header subtitle="PRIVATE CAMERA SESSIONS" />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        {/* Intro Row */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
          <div>
            <p className="text-xs font-mono font-semibold tracking-wider text-sky-400 mb-1 uppercase">
              YOUR DEVICES, CONNECTED
            </p>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
              Camera sessions
            </h1>
            <p className="mt-2 text-sm text-slate-400 max-w-xl">
              Create a private, consent-based WebRTC link to securely stream your phone camera to your laptop viewer.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-xs text-slate-300">
            <StatusDot status="good" pulse />
            <span className="font-medium">End-to-end media path</span>
          </div>
        </section>

        {/* Workspace Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-8">
          {/* Panel 1: Create Session */}
          <article className="lg:col-span-7 rounded-2xl bg-slate-900/70 border border-slate-800/90 p-6 sm:p-7 shadow-xl backdrop-blur-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <span className="text-[11px] font-mono font-semibold text-sky-400 uppercase tracking-wider">
                    Step 01
                  </span>
                  <h2 className="text-xl font-bold text-white tracking-tight mt-0.5">
                    Start a camera link
                  </h2>
                </div>
                <div className="w-8 h-8 rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center font-mono text-xs font-bold text-slate-400">
                  01
                </div>
              </div>

              <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-6">
                Only someone with the private invitation links can join. Your mobile camera stays off until you explicitly grant permission on your phone.
              </p>

              <button
                type="button"
                onClick={handleCreateSession}
                disabled={loading}
                className="w-full py-3.5 px-5 rounded-xl font-semibold text-sm text-slate-950 bg-sky-400 hover:bg-sky-300 active:scale-[0.99] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(56,189,248,0.25)] hover:shadow-[0_0_25px_rgba(56,189,248,0.4)]"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                    Creating secure session…
                  </span>
                ) : (
                  <>
                    <Plus className="w-4 h-4 stroke-[3]" />
                    Create secure session
                  </>
                )}
              </button>

              {error && (
                <div className="mt-4 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {sessionData && (
              <div className="mt-6 pt-5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-sky-400" />
                  <span>
                    Expires at <strong className="text-slate-200">{expiryTimeFormatted}</strong>
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-slate-300">
                  <Lock className="w-3 h-3 text-slate-400" />
                  <span className="truncate max-w-[140px] sm:max-w-none">{sessionData.sessionId}</span>
                </div>
              </div>
            )}
          </article>

          {/* Panel 2: Live Status */}
          <article className="lg:col-span-5 rounded-2xl bg-slate-900/70 border border-slate-800/90 p-6 sm:p-7 shadow-xl backdrop-blur-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <span className="text-[11px] font-mono font-semibold text-sky-400 uppercase tracking-wider">
                    Live Status
                  </span>
                  <h2 className="text-xl font-bold text-white tracking-tight mt-0.5">
                    Connection
                  </h2>
                </div>
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300">
                  <StatusDot status={sessionBadge.dot} pulse={sessionBadge.pulse} />
                  <span>{sessionBadge.label}</span>
                </div>
              </div>

              {/* Mobile Camera Device Row */}
              <div className="flex items-center gap-4 py-3.5 border-b border-slate-800/70">
                <div className="w-10 h-10 rounded-xl bg-slate-800/90 border border-slate-700/80 flex items-center justify-center text-sky-400 flex-shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-200">Mobile camera</div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">{mobileState.text}</div>
                </div>
                <StatusDot status={mobileState.dot} />
              </div>

              {/* Laptop Viewer Device Row */}
              <div className="flex items-center gap-4 py-3.5">
                <div className="w-10 h-10 rounded-xl bg-slate-800/90 border border-slate-700/80 flex items-center justify-center text-sky-400 flex-shrink-0">
                  <Monitor className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-200">This viewer</div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">{viewerState.text}</div>
                </div>
                <StatusDot status={viewerState.dot} />
              </div>
            </div>

            <div className="mt-5 p-3 rounded-xl bg-slate-950/70 border border-slate-800 text-[11px] text-slate-400 leading-relaxed flex items-start gap-2">
              <Info className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
              <span>
                {sessionData?.turnConfigured
                  ? 'TURN relay credentials configured. Confirm the selected ICE candidate is relay for carrier networks.'
                  : 'Direct P2P enabled. Media travels peer-to-peer when network allows; TURN relay recommended for strict carrier NATs.'}
              </span>
            </div>
          </article>
        </div>

        {/* Panel 3: Invitations Panel */}
        {sessionData && (
          <section className="rounded-2xl bg-slate-900/90 border border-sky-900/40 p-6 sm:p-7 shadow-2xl backdrop-blur-md mb-8 animate-in fade-in slide-in-from-bottom-3 duration-300">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-slate-800">
              <div>
                <span className="text-[11px] font-mono font-semibold text-sky-400 uppercase tracking-wider">
                  Invitations
                </span>
                <h2 className="text-xl font-bold text-white tracking-tight mt-0.5">
                  Join this session
                </h2>
              </div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono font-medium">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>PRIVATE LINKS</span>
              </div>
            </div>

            {/* Link A: Phone Camera */}
            <div className="py-4 border-b border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-start gap-3 md:w-1/3">
                <span className="w-6 h-6 rounded-md bg-sky-500/10 border border-sky-500/30 font-mono text-xs font-bold text-sky-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                  A
                </span>
                <div>
                  <strong className="text-sm font-semibold text-slate-200 block">Phone camera</strong>
                  <span className="text-xs text-slate-400">Open on your Android phone or scan QR code</span>
                </div>
              </div>

              <div className="flex-1 flex items-center gap-2 min-w-0">
                <input
                  type="text"
                  readOnly
                  value={sessionData.mobileUrl}
                  onClick={(e) => e.target.select()}
                  aria-label="Phone camera invitation link"
                  className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 focus:outline-none focus:border-sky-500 selection:bg-sky-500/30"
                />
                <button
                  type="button"
                  onClick={() => setShowQrFor(sessionData.mobileUrl)}
                  title="Show QR Code to scan on mobile"
                  className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 transition flex items-center justify-center flex-shrink-0 border border-slate-700"
                >
                  <QrCode className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => copyToClipboard(sessionData.mobileUrl, 'mobile')}
                  className="px-3.5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition flex items-center gap-1.5 flex-shrink-0 border border-slate-700"
                >
                  {copiedKey === 'mobile' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === 'mobile' ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={sessionData.mobileUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in new tab"
                  className="p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition flex items-center justify-center flex-shrink-0 border border-slate-700"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            </div>

            {/* Link B: Laptop Viewer */}
            <div className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-start gap-3 md:w-1/3">
                <span className="w-6 h-6 rounded-md bg-indigo-500/10 border border-indigo-500/30 font-mono text-xs font-bold text-indigo-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                  B
                </span>
                <div>
                  <strong className="text-sm font-semibold text-slate-200 block">Laptop viewer</strong>
                  <span className="text-xs text-slate-400">Open on this or another laptop/screen</span>
                </div>
              </div>

              <div className="flex-1 flex items-center gap-2 min-w-0">
                <input
                  type="text"
                  readOnly
                  value={sessionData.viewerUrl}
                  onClick={(e) => e.target.select()}
                  aria-label="Laptop viewer invitation link"
                  className="w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 focus:outline-none focus:border-sky-500 selection:bg-sky-500/30"
                />
                <button
                  type="button"
                  onClick={() => copyToClipboard(sessionData.viewerUrl, 'viewer')}
                  className="px-3.5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition flex items-center gap-1.5 flex-shrink-0 border border-slate-700"
                >
                  {copiedKey === 'viewer' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedKey === 'viewer' ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={sessionData.viewerUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open Viewer"
                  className="p-2.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 transition flex items-center justify-center flex-shrink-0 border border-sky-500/30"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400 leading-relaxed">
              {sessionData.turnConfigured
                ? 'Note: TURN credentials are present. Confirm the selected ICE candidate in the viewer is relay to verify connectivity.'
                : 'Note: No TURN credentials configured. Direct connections work on local Wi-Fi, but restrictive cellular networks may fail without a relay.'}
            </div>
          </section>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 px-4 sm:px-6 lg:px-8 text-xs text-slate-400 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Private by design · DTLS-SRTP encrypted</span>
        </div>
        <div>Camera permission is always user-controlled on the mobile phone</div>
      </footer>

      {/* QR Code Modal for Phone Link */}
      {showQrFor && (
        <QrCodeModal url={showQrFor} onClose={() => setShowQrFor(null)} />
      )}
    </div>
  );
}
