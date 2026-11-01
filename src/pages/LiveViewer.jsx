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
  ShieldCheck,
  SwitchCamera,
  Camera,
  CameraOff,
  Zap,
  FlipHorizontal,
  Download,
  X
} from 'lucide-react';

export default function LiveViewer() {
  const [sessionId, setSessionId] = useState('');
  const [token, setToken] = useState('');
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [mobileStatus, setMobileStatus] = useState({ connected: false, cameraActive: false });
  const [remoteCameraInfo, setRemoteCameraInfo] = useState({
    facingMode: 'environment', // 'environment' (back) | 'user' (front)
    torchSupported: false,
    torchActive: false,
    cameraActive: false,
    isSwitching: false,
  });
  const [isMirrored, setIsMirrored] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState(null);
  const [qualityLabel, setQualityLabel] = useState('Not connected');
  const [candidateLabel, setCandidateLabel] = useState('Not connected');
  const [expiryLabel, setExpiryLabel] = useState('Checking invitation…');
  const [turnWarning, setTurnWarning] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isStopped, setIsStopped] = useState(false);

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const iceServersRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const statsTimerRef = useRef(null);
  const turnConfiguredRef = useRef(false);

  // Extract credentials from hash, query params, or sessionStorage on load
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const searchParams = new URLSearchParams(window.location.search);
    const sId = hashParams.get('session') || searchParams.get('session') || sessionStorage.getItem('fieldlink_viewer_session');
    const tok = hashParams.get('token') || searchParams.get('token') || sessionStorage.getItem('fieldlink_viewer_token');

    if (sId && tok) {
      sessionStorage.setItem('fieldlink_viewer_session', sId);
      sessionStorage.setItem('fieldlink_viewer_token', tok);
      setSessionId(sId);
      setToken(tok);
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

      if (status.cameraActive !== undefined) {
        setRemoteCameraInfo((prev) => ({ ...prev, cameraActive: Boolean(status.cameraActive) }));
      }

      if (status.expiresAt) {
        setExpiryLabel(
          `Expires ${new Date(status.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        );
      }

      if (status.mobileConnected && status.cameraActive) {
        socket.emit('request-offer');
      }
    });

    socket.on('camera-info', (info) => {
      setRemoteCameraInfo((prev) => ({
        ...prev,
        ...info,
        isSwitching: false,
      }));
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

    peer.ontrack = (event) => {
      console.log('🎥 LiveViewer ontrack event received!', event.streams, event.track);
      const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
      remoteStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        setIsVideoActive(true);
        videoRef.current.play().catch((err) => console.warn('Autoplay error:', err));
      }
    };

    peer.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current?.connected) {
        console.log('🧊 LiveViewer sending ICE candidate');
        socketRef.current.emit('ice-candidate', { candidate: candidate.toJSON() });
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      console.log('🔗 LiveViewer connectionState:', state);
      if (state === 'connected') {
        setQualityLabel('Connected · measuring…');
        setIsVideoActive(true);
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

  const handleRemoteSwitchCamera = () => {
    if (!socketRef.current?.connected) return;
    setRemoteCameraInfo((prev) => ({ ...prev, isSwitching: true }));
    socketRef.current.emit('camera-control', { action: 'switch-camera' });
    setTimeout(() => {
      setRemoteCameraInfo((prev) => ({ ...prev, isSwitching: false }));
    }, 4000);
  };

  const handleRemoteToggleCamera = () => {
    if (!socketRef.current?.connected) return;
    socketRef.current.emit('camera-control', { action: 'toggle-camera' });
  };

  const handleRemoteToggleTorch = () => {
    if (!socketRef.current?.connected) return;
    socketRef.current.emit('camera-control', { action: 'toggle-torch' });
  };

  const handleCaptureSnapshot = () => {
    const video = videoRef.current;
    if (!video || !isVideoActive) return;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (isMirrored) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      setSnapshotUrl(dataUrl);
    } catch (err) {
      console.warn('Failed to capture snapshot:', err);
    }
  };

  const handleDownloadSnapshot = () => {
    if (!snapshotUrl) return;
    const a = document.createElement('a');
    a.href = snapshotUrl;
    a.download = `mobile-camera-${Date.now()}.png`;
    a.click();
  };

  const toggleMirror = () => {
    setIsMirrored((prev) => !prev);
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
            muted
            onLoadedMetadata={() => {
              console.log('🎬 Video onLoadedMetadata, playing...');
              videoRef.current?.play().catch(() => {});
            }}
            onCanPlay={() => {
              console.log('🎬 Video onCanPlay!');
              setIsVideoActive(true);
            }}
            className={`w-full h-full object-contain transition-all duration-300 ${
              isVideoActive ? 'opacity-100' : 'opacity-0'
            } ${isMirrored ? '-scale-x-100' : ''}`}
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

        {/* Remote Mobile Camera Controls Bar */}
        <div className="mt-4 p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-sky-900/40 shadow-xl backdrop-blur-md flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700/80 flex items-center justify-center text-sky-400 flex-shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono font-semibold text-sky-400 uppercase tracking-wider">
                  MOBILE CAMERA CONTROLS
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-800 border border-slate-700 text-slate-300">
                  {remoteCameraInfo.facingMode === 'user' ? 'FRONT CAMERA' : 'REAR / BACK CAMERA'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Switch camera orientation, power, or capture photos remotely from this laptop viewer.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Switch Camera Button (Front ↔ Back) */}
            <button
              type="button"
              onClick={handleRemoteSwitchCamera}
              disabled={!mobileStatus.connected || remoteCameraInfo.isSwitching}
              title="Switch between front (selfie) and back camera"
              className="py-2.5 px-4 rounded-xl text-xs font-bold text-slate-950 bg-sky-400 hover:bg-sky-300 active:scale-[0.98] transition shadow-[0_0_15px_rgba(56,189,248,0.3)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <SwitchCamera className={`w-4 h-4 ${remoteCameraInfo.isSwitching ? 'animate-spin' : ''}`} />
              <span>
                {remoteCameraInfo.isSwitching
                  ? 'Switching…'
                  : `Switch to ${remoteCameraInfo.facingMode === 'user' ? 'Back' : 'Front'} Camera`}
              </span>
            </button>

            {/* Toggle Camera On/Off */}
            <button
              type="button"
              onClick={handleRemoteToggleCamera}
              disabled={!mobileStatus.connected}
              title={mobileStatus.cameraActive ? 'Turn Off Phone Camera' : 'Turn On Phone Camera'}
              className="py-2.5 px-3.5 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 active:scale-[0.98] transition border border-slate-700 disabled:opacity-40 flex items-center gap-2"
            >
              {mobileStatus.cameraActive ? (
                <>
                  <CameraOff className="w-3.5 h-3.5 text-rose-400" />
                  <span>Turn Off Camera</span>
                </>
              ) : (
                <>
                  <Camera className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Turn On Camera</span>
                </>
              )}
            </button>

            {/* Flashlight / Torch */}
            {remoteCameraInfo.torchSupported && (
              <button
                type="button"
                onClick={handleRemoteToggleTorch}
                disabled={!mobileStatus.cameraActive}
                title="Toggle phone flashlight"
                className={`py-2.5 px-3.5 rounded-xl text-xs font-semibold transition border flex items-center gap-1.5 ${
                  remoteCameraInfo.torchActive
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>{remoteCameraInfo.torchActive ? 'Torch On' : 'Torch Off'}</span>
              </button>
            )}

            {/* Take Snapshot */}
            <button
              type="button"
              onClick={handleCaptureSnapshot}
              disabled={!isVideoActive}
              title="Take a photo snapshot from the live stream"
              className="py-2.5 px-3.5 rounded-xl text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 active:scale-[0.98] transition border border-slate-700 disabled:opacity-40 flex items-center gap-1.5"
            >
              <Camera className="w-3.5 h-3.5 text-sky-400" />
              <span>Take Photo</span>
            </button>

            {/* Mirror View Toggle */}
            <button
              type="button"
              onClick={toggleMirror}
              title={isMirrored ? 'Disable video mirror' : 'Mirror video horizontally'}
              className={`p-2.5 rounded-xl text-xs font-semibold transition border ${
                isMirrored
                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
              }`}
            >
              <FlipHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
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

        {/* Snapshot Modal */}
        {snapshotUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Camera className="w-4 h-4 text-sky-400" />
                  Captured Photo
                </h3>
                <button
                  type="button"
                  onClick={() => setSnapshotUrl(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <img
                src={snapshotUrl}
                alt="Camera snapshot"
                className="w-full rounded-xl border border-slate-800 mb-4 object-contain max-h-[60vh] bg-black"
              />
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setSnapshotUrl(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:bg-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDownloadSnapshot}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-950 bg-sky-400 hover:bg-sky-300 transition flex items-center gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Photo
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
