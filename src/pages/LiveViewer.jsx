import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Header from '../components/Header';
import StatusDot from '../components/StatusDot';
import { 
  Maximize, 
  Minimize, 
  RotateCw, 
  PowerOff, 
  Smartphone, 
  Activity, 
  Layers, 
  Clock, 
  AlertTriangle, 
  Info,
  ShieldCheck
} from 'lucide-react';

export default function LiveViewer() {
  const [sessionId, setSessionId] = useState('');
  const [token, setToken] = useState('');
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [mobileStatus, setMobileStatus] = useState({ connected: false, cameraActive: false });
  const [qualityLabel, setQualityLabel] = useState('Not connected');
  const [candidateLabel, setCandidateLabel] = useState('Not connected');
  const [expiryLabel, setExpiryLabel] = useState('Checking invitation…');
  const [turnWarning, setTurnWarning] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isStopped, setIsStopped] = useState(false);

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const iceServersRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const statsTimerRef = useRef(null);
  const turnConfiguredRef = useRef(false);

  // Extract credentials from hash on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const sId = params.get('session');
    const tok = params.get('token');

    if (sId && tok) {
      setSessionId(sId);
      setToken(tok);
      window.history.replaceState(null, '', window.location.pathname);
    } else {
      setErrorMessage('This viewer invitation link is incomplete or missing. Please create a new session.');
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      closePeer();
      socketRef.current?.disconnect();
    };
  }, []);

  // Connect socket
  useEffect(() => {
    if (!sessionId || !token || isStopped) return;

    const socket = io({
      auth: { sessionId, token, role: 'viewer' },
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setExpiryLabel('Signaling connected');
      setErrorMessage('');
    });

    socket.on('connect_error', (err) => {
      setExpiryLabel(err.message === 'unauthorized' ? 'Invitation expired' : 'Connection unavailable');
      if (err.message === 'unauthorized') {
        setErrorMessage('This viewer invitation is invalid or has expired.');
      }
    });

    socket.on('disconnect', () => {
      setMobileStatus({ connected: false, cameraActive: false });
      setQualityLabel('Signaling disconnected');
    });

    socket.on('peer-status', (status) => {
      setMobileStatus({
        connected: Boolean(status.mobileConnected),
        cameraActive: Boolean(status.cameraActive),
      });

      if (status.expiresAt) {
        setExpiryLabel(
          `Expires ${new Date(status.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        );
      }

      if (status.mobileConnected && status.cameraActive) {
        socket.emit('request-offer');
      }
    });

    socket.on('offer', handleOffer);

    socket.on('ice-candidate', async ({ candidate } = {}) => {
      if (!candidate) return;
      if (!peerRef.current || !peerRef.current.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
      } else {
        try {
          await peerRef.current.addIceCandidate(candidate);
        } catch {
          // Candidate might belong to prior ICE restart
        }
      }
    });

    socket.on('camera-stopped', () => {
      closePeer();
    });

    socket.on('session-expired', () => {
      closePeer();
      setMobileStatus({ connected: false, cameraActive: false });
      setErrorMessage('This camera session has expired.');
      socket.disconnect();
    });

    socket.on('signaling-error', ({ message }) => {
      setErrorMessage(message || 'Signaling error.');
    });

    return () => {
      socket.disconnect();
    };
  }, [sessionId, token, isStopped]);

  const loadIceServers = async () => {
    if (iceServersRef.current) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ice`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load connection settings.');

      iceServersRef.current = data.iceServers;
      turnConfiguredRef.current = Boolean(data.turnConfigured);

      setTurnWarning(
        data.turnConfigured
          ? 'TURN credentials are configured. Confirm a relay ICE candidate for strict carrier networks.'
          : 'TURN is unavailable. Restrictive mobile networks may require a TURN relay.'
      );

      if (!data.turnConfigured) {
        setQualityLabel('TURN unavailable · direct path may fail');
      }
    } catch (err) {
      setErrorMessage(err.message || 'Error loading ICE configurations.');
    }
  };

  const closePeer = () => {
    clearInterval(statsTimerRef.current);
    if (peerRef.current) {
      peerRef.current.ontrack = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }
    pendingCandidatesRef.current = [];
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsVideoActive(false);
    setCandidateLabel('Not connected');
    setQualityLabel(turnConfiguredRef.current ? 'TURN configured · awaiting peer' : 'Direct path · awaiting peer');
  };

  const createPeer = () => {
    closePeer();

    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peerRef.current = peer;

    peer.ontrack = ({ streams }) => {
      if (streams[0] && videoRef.current) {
        videoRef.current.srcObject = streams[0];
        setIsVideoActive(true);
        videoRef.current.play().catch(() => {});
      }
    };

    peer.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current?.connected) {
        socketRef.current.emit('ice-candidate', { candidate: candidate.toJSON() });
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'connected') {
        setQualityLabel('Connected · measuring…');
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = setInterval(readConnectionStats, 2500);
        readConnectionStats();
      } else if (state === 'failed') {
        setQualityLabel('Connection failed');
        setErrorMessage('The peer connection failed. Check TURN server and network, then click Reconnect.');
      } else if (state === 'disconnected') {
        setQualityLabel('Reconnecting…');
      }
    };

    return peer;
  };

  const applyPendingCandidates = async () => {
    if (!peerRef.current?.remoteDescription) return;
    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const cand of candidates) {
      try {
        await peerRef.current.addIceCandidate(cand);
      } catch {
        // Ignored
      }
    }
  };

  const handleOffer = async ({ description } = {}) => {
    if (isStopped || description?.type !== 'offer') return;
    try {
      await loadIceServers();
      const candidatesBeforeOffer = pendingCandidatesRef.current;
      const connection = createPeer();
      pendingCandidatesRef.current = candidatesBeforeOffer;

      await connection.setRemoteDescription(description);
      await applyPendingCandidates();

      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      socketRef.current?.emit('answer', { description: connection.localDescription.toJSON() });
      setQualityLabel('Negotiating connection…');
    } catch (err) {
      setErrorMessage(`Could not join camera stream: ${err.message}`);
    }
  };

  const readConnectionStats = async () => {
    if (!peerRef.current) return;
    try {
      const stats = await peerRef.current.getStats();
      const reports = [...stats.values()];
      const transport = reports.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
      const pair = transport
        ? stats.get(transport.selectedCandidatePairId)
        : reports.find((item) => item.type === 'candidate-pair' && item.state === 'succeeded' && (item.selected || item.nominated));

      if (!pair) return;
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      const localType = local?.candidateType || 'unknown';
      const remoteType = remote?.candidateType || 'unknown';

      setCandidateLabel(`${localType} ↔ ${remoteType}`);
      const rttMs = Math.round((pair.currentRoundTripTime || 0) * 1000);
      const isRelay = localType === 'relay' || remoteType === 'relay';

      const label = rttMs
        ? `${rttMs} ms · ${isRelay ? 'relay (TURN)' : 'direct (P2P)'}`
        : isRelay
        ? 'Connected · relay'
        : 'Connected · direct';

      setQualityLabel(label);
    } catch {
      setQualityLabel('Connected · stats unavailable');
    }
  };

  const toggleFullscreen = async () => {
    if (!stageRef.current) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stageRef.current.requestFullscreen();
      }
    } catch {
      // Ignored
    }
  };

  const handleReconnect = () => {
    setErrorMessage('');
    setIsStopped(false);
    if (!socketRef.current?.connected) {
      socketRef.current?.disconnect();
      // Triggers reconnect effect
      setSessionId((prev) => `${prev}`);
      return;
    }
    closePeer();
    socketRef.current.emit('request-offer');
  };

  const handleStopViewing = () => {
    setIsStopped(true);
    closePeer();
    socketRef.current?.disconnect();
    setMobileStatus({ connected: false, cameraActive: false });
    setQualityLabel('Viewing stopped');
  };

  const getMobileStatusBadge = () => {
    if (!mobileStatus.connected) {
      return { text: 'Mobile disconnected', dot: 'bad' };
    }
    if (mobileStatus.cameraActive) {
      return { text: 'Camera streaming', dot: 'good', pulse: true };
    }
    return { text: 'Mobile connected · camera off', dot: 'warn' };
  };

  const mobileBadge = getMobileStatusBadge();

  return (
    <div className="min-h-screen bg-[#0c1015] text-slate-100 flex flex-col font-sans">
      <Header subtitle="LIVE VIEWER" />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 flex flex-col">
        {/* Heading */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
          <div>
            <p className="text-xs font-mono font-semibold tracking-wider text-sky-400 uppercase">
              PRIVATE CAMERA SESSION
            </p>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-1">
              Live camera
            </h1>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono">
            <StatusDot status={mobileBadge.dot} pulse={mobileBadge.pulse} />
            <span className="text-slate-200">{mobileBadge.text}</span>
          </div>
        </div>

        {/* Video Stage */}
        <div
          ref={stageRef}
          className="relative w-full aspect-[16/9] max-h-[65vh] bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl flex items-center justify-center group"
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-contain transition-opacity duration-300 ${
              isVideoActive ? 'opacity-100' : 'opacity-0'
            }`}
          />

          {/* Placeholder when stream is inactive */}
          {!isVideoActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-radial from-slate-900/90 to-slate-950">
              <div className="w-16 h-16 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-center text-slate-400 mb-3 shadow-inner">
                <Smartphone className="w-8 h-8 text-sky-400" />
              </div>
              <strong className="text-base font-semibold text-slate-200">Waiting for phone stream</strong>
              <span className="text-xs text-slate-400 mt-1 max-w-sm">
                Open the invitation link on your phone and tap "Allow camera" to start streaming video here.
              </span>
            </div>
          )}

          {/* Video Badge */}
          <div className="absolute top-4 left-4 z-10 flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-950/80 border border-slate-800/80 text-[11px] font-mono backdrop-blur-md">
            <StatusDot status={isVideoActive ? 'good' : 'neutral'} pulse={isVideoActive} />
            <span className="text-slate-200 font-medium tracking-wider">
              {isVideoActive ? 'LIVE' : 'NO VIDEO'}
            </span>
          </div>

          {/* Fullscreen Button */}
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="Toggle Fullscreen"
            className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-slate-950/80 border border-slate-800/80 text-slate-300 hover:text-white hover:bg-slate-900 backdrop-blur-md transition shadow-md"
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>
        </div>

        {/* Quality & Connection Details Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6 py-4 border-b border-slate-800">
          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center gap-2 text-sky-400 text-[11px] font-mono uppercase tracking-wider mb-1">
              <Activity className="w-3.5 h-3.5" />
              <span>CONNECTION QUALITY</span>
            </div>
            <strong className="text-sm font-semibold text-white block truncate">{qualityLabel}</strong>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center gap-2 text-sky-400 text-[11px] font-mono uppercase tracking-wider mb-1">
              <Layers className="w-3.5 h-3.5" />
              <span>SELECTED ICE CANDIDATES</span>
            </div>
            <strong className="text-sm font-mono font-semibold text-slate-300 block truncate">
              {candidateLabel}
            </strong>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center gap-2 text-sky-400 text-[11px] font-mono uppercase tracking-wider mb-1">
              <Clock className="w-3.5 h-3.5" />
              <span>SESSION TIMING</span>
            </div>
            <strong className="text-sm font-semibold text-white block truncate">{expiryLabel}</strong>
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="mt-4 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mt-5">
          <button
            type="button"
            onClick={handleReconnect}
            className="py-2.5 px-4 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 active:scale-[0.99] transition border border-slate-700 flex items-center gap-2"
          >
            <RotateCw className="w-3.5 h-3.5 text-sky-400" />
            Reconnect
          </button>

          <button
            type="button"
            onClick={handleStopViewing}
            className="py-2.5 px-4 rounded-xl text-xs font-semibold text-slate-400 hover:text-white bg-slate-900/80 hover:bg-slate-800 transition border border-slate-800 flex items-center gap-2"
          >
            <PowerOff className="w-3.5 h-3.5 text-slate-400" />
            Stop viewing
          </button>
        </div>

        {/* Notices */}
        <div className="mt-6 space-y-1.5 text-xs text-slate-400 leading-relaxed">
          {turnWarning && (
            <p className="flex items-center gap-1.5 text-amber-400/90 font-mono text-[11px]">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{turnWarning}</span>
            </p>
          )}
          <p>
            The media stream is end-to-end encrypted (DTLS-SRTP) directly between devices. Restrictive networks require a TURN relay server to route encrypted packets.
          </p>
        </div>
      </main>
    </div>
  );
}
