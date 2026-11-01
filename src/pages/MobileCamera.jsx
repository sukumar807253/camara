import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Header from '../components/Header';
import StatusDot from '../components/StatusDot';
import { 
  Camera, 
  CameraOff, 
  SwitchCamera, 
  PowerOff, 
  Wifi, 
  WifiOff, 
  AlertTriangle, 
  Info, 
  ShieldAlert,
  Radio,
  Mic,
  MicOff,
  PictureInPicture,
  Sun
} from 'lucide-react';

export default function MobileCamera() {
  const [sessionId, setSessionId] = useState('');
  const [token, setToken] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const isCameraActiveRef = useRef(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [isWakeLockActive, setIsWakeLockActive] = useState(false);
  const [isPipActive, setIsPipActive] = useState(false);
  const wakeLockRef = useRef(null);
  const [facingMode, setFacingMode] = useState('environment'); // 'environment' (back) | 'user' (front)
  const facingModeRef = useRef('environment');
  const [torchActive, setTorchActive] = useState(false);
  const torchActiveRef = useRef(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const isMicMutedRef = useRef(false);
  const [connectionStatus, setConnectionStatus] = useState({ connected: false, text: 'Checking invitation…' });
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [errorMessage, setErrorMessage] = useState('');
  const [isDisconnected, setIsDisconnected] = useState(false);

  const videoRef = useRef(null);
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const streamRef = useRef(null);
  const iceServersRef = useRef([{ urls: 'stun:stun.l.google.com:19302' }]);
  const pendingCandidatesRef = useRef([]);
  const makingOfferRef = useRef(false);
  const viewerConnectedRef = useRef(false);
  const promptAttemptedRef = useRef(false);
  const controlHandlersRef = useRef({});

  // Parse session and token from URL hash, search params, or sessionStorage on load
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const searchParams = new URLSearchParams(window.location.search);
    const sId = hashParams.get('session') || searchParams.get('session') || sessionStorage.getItem('fieldlink_mobile_session');
    const tok = hashParams.get('token') || searchParams.get('token') || sessionStorage.getItem('fieldlink_mobile_token');

    if (sId && tok) {
      sessionStorage.setItem('fieldlink_mobile_session', sId);
      sessionStorage.setItem('fieldlink_mobile_token', tok);
      setSessionId(sId);
      setToken(tok);
    } else {
      setErrorMessage('This invitation link is incomplete or missing credentials. Please create a new session.');
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const handlePageHide = () => {
      // Release wake lock when backgrounded, but preserve stream & socket so it can resume
      releaseWakeLock();
    };
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('pagehide', handlePageHide);
      releaseWakeLock();
      cleanupStream();
      socketRef.current?.disconnect();
    };
  }, []);

  // Connect socket once session and token are available
  useEffect(() => {
    if (!sessionId || !token) return;

    const socket = io({
      auth: { sessionId, token, role: 'mobile' },
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionStatus({ connected: true, text: 'Secure signaling connected' });
      if (streamRef.current) {
        socket.emit('camera-state', { active: true });
      } else if (!promptAttemptedRef.current) {
        promptAttemptedRef.current = true;
        handleStartCamera();
      }
    });

    socket.on('connect_error', (err) => {
      setConnectionStatus({
        connected: false,
        text: err.message === 'unauthorized' ? 'Invitation invalid or expired' : 'Could not connect to signaling',
      });
      if (err.message === 'unauthorized') {
        setErrorMessage('This session invitation is invalid or has expired.');
      }
    });

    socket.on('disconnect', () => {
      viewerConnectedRef.current = false;
      closePeer();
      setConnectionStatus({ connected: false, text: 'Signaling disconnected' });
    });

    socket.on('peer-status', (status) => {
      viewerConnectedRef.current = Boolean(status.viewerConnected);
      if (!status.mobileConnected) return;

      if (viewerConnectedRef.current) {
        controlHandlersRef.current.sendCameraInfo?.();
      }

      if (streamRef.current && viewerConnectedRef.current) {
        if (!peerRef.current || peerRef.current.signalingState === 'closed') {
          createPeer();
        }
        maybeOffer();
      } else if (!viewerConnectedRef.current) {
        closePeer();
        setConnectionStatus({
          connected: true,
          text: streamRef.current ? 'Camera ready · waiting for viewer' : 'Connected · camera off',
        });
      }
    });

    socket.on('camera-control', async (payload) => {
      if (!payload?.action) return;
      if (payload.action === 'switch-camera') {
        await controlHandlersRef.current.switchCamera?.(payload.facingMode);
      } else if (payload.action === 'toggle-camera') {
        if (streamRef.current) {
          controlHandlersRef.current.stopCamera?.();
        } else {
          await controlHandlersRef.current.startCamera?.();
        }
      } else if (payload.action === 'toggle-torch') {
        await controlHandlersRef.current.toggleTorch?.();
      } else if (payload.action === 'toggle-mic') {
        controlHandlersRef.current.toggleMic?.();
      }
    });

    socket.on('answer', async ({ description } = {}) => {
      if (!peerRef.current || description?.type !== 'answer') return;
      try {
        await peerRef.current.setRemoteDescription(description);
        await applyPendingCandidates();
      } catch (err) {
        setErrorMessage(`Could not complete video connection: ${err.message}`);
      }
    });

    socket.on('ice-candidate', async ({ candidate } = {}) => {
      if (!peerRef.current || !candidate) return;
      if (!peerRef.current.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
      } else {
        try {
          await peerRef.current.addIceCandidate(candidate);
        } catch {
          // Stale candidate during reconnect
        }
      }
    });

    socket.on('renegotiate', () => {
      maybeOffer();
    });

    socket.on('session-expired', () => {
      handleStopCamera();
      socket.disconnect();
      setErrorMessage('This camera session has expired.');
      setIsDisconnected(true);
    });

    socket.on('signaling-error', ({ message }) => {
      setErrorMessage(message || 'Signaling error.');
    });

    return () => {
      socket.disconnect();
    };
  }, [sessionId, token]);

  const loadIceServers = async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ice`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch ICE configuration.');
      iceServersRef.current = data.iceServers;
    } catch {
      // Fallback to default STUN
    }
  };

  const createPeer = () => {
    if (!streamRef.current || !viewerConnectedRef.current || !window.RTCPeerConnection) return null;
    closePeer();

    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peerRef.current = peer;

    streamRef.current.getTracks().forEach((track) => {
      peer.addTrack(track, streamRef.current);
    });

    peer.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current?.connected) {
        socketRef.current.emit('ice-candidate', { candidate: candidate.toJSON() });
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setConnectionStatus({ connected: true, text: 'Connected to viewer · streaming live' });
      } else if (['failed', 'disconnected'].includes(peer.connectionState)) {
        setConnectionStatus({ connected: false, text: 'Viewer connection interrupted' });
      }
    };

    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed') {
        setErrorMessage('Network path failed. Check TURN relay configuration and reconnect.');
      }
    };

    return peer;
  };

  const closePeer = () => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }
    pendingCandidatesRef.current = [];
    makingOfferRef.current = false;
  };

  const maybeOffer = async () => {
    if (!streamRef.current || !viewerConnectedRef.current || !socketRef.current?.connected || makingOfferRef.current) {
      return;
    }
    if (!peerRef.current || peerRef.current.signalingState === 'closed') {
      createPeer();
    }
    if (!peerRef.current || peerRef.current.signalingState !== 'stable') return;

    makingOfferRef.current = true;
    try {
      const offer = await peerRef.current.createOffer();
      await peerRef.current.setLocalDescription(offer);
      socketRef.current.emit('offer', { description: peerRef.current.localDescription.toJSON() });
      setConnectionStatus({ connected: true, text: 'Connecting to viewer…' });
    } catch (err) {
      setErrorMessage(`Could not start video connection: ${err.message}`);
    } finally {
      makingOfferRef.current = false;
    }
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

  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator && (!wakeLockRef.current || wakeLockRef.current.released)) {
        const lock = await navigator.wakeLock.request('screen');
        wakeLockRef.current = lock;
        setIsWakeLockActive(true);
        lock.addEventListener('release', () => {
          wakeLockRef.current = null;
          setIsWakeLockActive(false);
        });
        console.log('💡 Screen Wake Lock active - screen will not sleep');
      }
    } catch (err) {
      console.warn('Wake Lock request warning:', err);
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      setIsWakeLockActive(false);
    }
  };

  const togglePictureInPicture = async () => {
    try {
      if (!videoRef.current) return;
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch (err) {
      console.warn('PiP error:', err);
    }
  };

  const cleanupStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const sendCameraInfo = (
    fMode = facingModeRef.current,
    active = Boolean(streamRef.current),
    torch = torchActiveRef.current,
    micMuted = isMicMutedRef.current
  ) => {
    if (!socketRef.current?.connected) return;
    const vTrack = streamRef.current?.getVideoTracks()[0];
    const aTrack = streamRef.current?.getAudioTracks()[0];
    const capabilities = vTrack?.getCapabilities?.() || {};
    socketRef.current.emit('camera-info', {
      facingMode: fMode,
      cameraActive: active,
      torchSupported: Boolean(capabilities.torch),
      torchActive: torch,
      micSupported: Boolean(aTrack),
      micActive: Boolean(aTrack && !micMuted),
      micMuted: Boolean(micMuted),
    });
  };

  const handleToggleMic = () => {
    const audioTrack = streamRef.current?.getAudioTracks()[0];
    const nextMuted = !isMicMutedRef.current;
    if (audioTrack) {
      audioTrack.enabled = !nextMuted;
    }
    isMicMutedRef.current = nextMuted;
    setIsMicMuted(nextMuted);
    sendCameraInfo(facingModeRef.current, Boolean(streamRef.current), torchActiveRef.current, nextMuted);
  };

  const handleStartCamera = async () => {
    if (!sessionId || !token) {
      setErrorMessage('This invitation link is incomplete. Create a new session from the dashboard.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Camera and microphone access requires HTTPS and a supported mobile browser.');
      return;
    }

    setErrorMessage('');
    setCameraLoading(true);

    try {
      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingModeRef.current } },
          audio: true,
        });
      } catch (audioErr) {
        console.warn('Audio capture failed, falling back to video-only:', audioErr);
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingModeRef.current } },
          audio: false,
        });
      }

      cleanupStream();
      streamRef.current = newStream;
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }

      setIsCameraActive(true);
      isCameraActiveRef.current = true;
      await requestWakeLock();
      torchActiveRef.current = false;
      setTorchActive(false);
      isMicMutedRef.current = false;
      setIsMicMuted(false);
      await loadIceServers();

      if (socketRef.current?.connected) {
        socketRef.current.emit('camera-state', { active: true });
        sendCameraInfo(facingModeRef.current, true, false, false);
        if (viewerConnectedRef.current) {
          createPeer();
          await maybeOffer();
        } else {
          setConnectionStatus({ connected: true, text: 'Camera & mic ready · waiting for viewer' });
        }
      }
    } catch (err) {
      cleanupStream();
      setIsCameraActive(false);
      isCameraActiveRef.current = false;
      releaseWakeLock();
      sendCameraInfo(facingModeRef.current, false, false, true);

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage('Camera/microphone permission was denied. Please allow access in browser settings and try again.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('No camera or microphone hardware was found on this device.');
      } else if (err.name === 'NotReadableError') {
        setErrorMessage('The camera or microphone is already in use by another app.');
      } else {
        setErrorMessage(err.message || 'Could not start camera. Verify browser permissions.');
      }
    } finally {
      setCameraLoading(false);
    }
  };

  const handleStopCamera = () => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('camera-state', { active: false });
      socketRef.current.emit('camera-stopped');
      sendCameraInfo(facingModeRef.current, false, false, true);
    }
    closePeer();
    cleanupStream();
    setIsCameraActive(false);
    isCameraActiveRef.current = false;
    releaseWakeLock();
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    torchActiveRef.current = false;
    setTorchActive(false);
    setConnectionStatus({
      connected: Boolean(socketRef.current?.connected),
      text: socketRef.current?.connected ? 'Connected · camera off' : 'Disconnected',
    });
  };

  const handleSwitchCamera = async (targetFacing) => {
    const nextFacing = targetFacing || (facingModeRef.current === 'environment' ? 'user' : 'environment');
    setErrorMessage('');
    setCameraLoading(true);

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
        audio: false,
      });

      const nextTrack = nextStream.getVideoTracks()[0];
      const sender = peerRef.current?.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(nextTrack);
      }

      const prev = streamRef.current;
      const audioTracks = prev?.getAudioTracks() || [];
      const newCombinedStream = new MediaStream([nextTrack, ...audioTracks]);
      streamRef.current = newCombinedStream;
      if (videoRef.current) {
        videoRef.current.srcObject = newCombinedStream;
      }
      setFacingMode(nextFacing);
      facingModeRef.current = nextFacing;
      torchActiveRef.current = false;
      setTorchActive(false);
      prev?.getVideoTracks().forEach((track) => track.stop());

      sendCameraInfo(nextFacing, true, false, isMicMutedRef.current);

      if (!sender && viewerConnectedRef.current) {
        createPeer();
        await maybeOffer();
      }
    } catch (err) {
      setErrorMessage(
        err.name === 'NotAllowedError'
          ? 'Camera permission is needed to switch cameras.'
          : `Could not switch camera: ${err.message}`
      );
    } finally {
      setCameraLoading(false);
    }
  };

  const handleToggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const capabilities = track.getCapabilities?.() || {};
      if (!capabilities.torch) return;
      const nextTorch = !torchActiveRef.current;
      await track.applyConstraints({
        advanced: [{ torch: nextTorch }],
      });
      torchActiveRef.current = nextTorch;
      setTorchActive(nextTorch);
      sendCameraInfo(facingModeRef.current, true, nextTorch, isMicMutedRef.current);
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  };

  // Handle visibility changes and automatic recovery when returning to tab
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        console.log('👁️ Mobile page resumed / visible');
        // 1. Re-acquire screen wake lock if camera should be active
        if (isCameraActiveRef.current) {
          await requestWakeLock();
        }

        // 2. Reconnect signaling socket if dropped in background
        if (socketRef.current && !socketRef.current.connected) {
          console.log('🔄 Reconnecting signaling socket...');
          socketRef.current.connect();
        }

        // 3. Check if camera track was stopped or muted by mobile OS in background
        const vTrack = streamRef.current?.getVideoTracks()[0];
        const isTrackDead = !vTrack || vTrack.readyState === 'ended';

        if (isCameraActiveRef.current && isTrackDead) {
          console.log('🔄 Camera track ended while in background, auto-restarting...');
          await handleStartCamera();
        } else if (isCameraActiveRef.current && streamRef.current && viewerConnectedRef.current) {
          // If WebRTC connection was interrupted in background, renegotiate offer
          if (!peerRef.current || ['failed', 'disconnected', 'closed'].includes(peerRef.current.connectionState)) {
            console.log('🔄 Re-establishing WebRTC connection with viewer...');
            createPeer();
            await maybeOffer();
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, []);

  controlHandlersRef.current = {
    switchCamera: handleSwitchCamera,
    startCamera: handleStartCamera,
    stopCamera: handleStopCamera,
    toggleTorch: handleToggleTorch,
    toggleMic: handleToggleMic,
    sendCameraInfo,
  };

  const handleDisconnect = () => {
    handleStopCamera();
    socketRef.current?.disconnect();
    setConnectionStatus({ connected: false, text: 'Session disconnected' });
    setIsDisconnected(true);
  };

  return (
    <div className="min-h-screen bg-[#0c1015] text-slate-100 flex flex-col font-sans">
      <Header subtitle="PHONE CAMERA" />

      <main className="flex-1 max-w-xl w-full mx-auto px-4 py-6 sm:py-8 flex flex-col">
        {/* Title */}
        <div className="mb-5">
          <p className="text-xs font-mono font-semibold tracking-wider text-sky-400 uppercase">
            PRIVATE CAMERA SESSION
          </p>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white mt-1">
            Your phone camera
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Camera stays off until you tap "Allow camera". Video streams directly to your paired viewer.
          </p>
        </div>

        {/* Video Preview Frame */}
        <div className="relative w-full aspect-[4/3] sm:aspect-[16/10] bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden shadow-2xl flex items-center justify-center">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onEnterPictureInPicture={() => setIsPipActive(true)}
            onLeavePictureInPicture={() => setIsPipActive(false)}
            className={`w-full h-full object-cover transition-opacity duration-300 ${
              isCameraActive ? 'opacity-100' : 'opacity-0'
            } ${facingMode === 'user' ? '-scale-x-100' : ''}`}
          />

          {/* Off / Placeholder Screen */}
          {!isCameraActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 bg-radial from-slate-900/90 to-slate-950">
              <div className="w-16 h-16 rounded-2xl bg-slate-800/80 border border-slate-700/80 flex items-center justify-center text-slate-400 mb-3 shadow-inner">
                <CameraOff className="w-8 h-8 text-slate-400" />
              </div>
              <strong className="text-sm font-semibold text-slate-200">Camera is off</strong>
              <span className="text-xs text-slate-400 mt-1 max-w-xs">
                Live camera preview will appear here after you approve access.
              </span>
            </div>
          )}

          {/* Status Badge */}
          <div className="absolute top-3 left-3 z-10 flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-950/80 border border-slate-800/80 text-[11px] font-mono backdrop-blur-md">
            <StatusDot status={isCameraActive ? 'good' : 'neutral'} pulse={isCameraActive} />
            <span className="text-slate-200 font-medium tracking-wider">
              {isCameraActive ? 'LIVE PREVIEW' : 'OFF'}
            </span>
          </div>

          {/* Facing Mode, Wake Lock & PiP */}
          {isCameraActive && (
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
              {/* Screen Awake (Wake Lock) Indicator */}
              {isWakeLockActive && (
                <div
                  title="Screen is kept awake so stream will not sleep"
                  className="px-2 py-0.5 rounded text-[10px] font-mono border backdrop-blur-md flex items-center gap-1 bg-amber-950/80 border-amber-800 text-amber-300"
                >
                  <Sun className="w-3 h-3 text-amber-400" />
                  <span className="hidden sm:inline">Awake</span>
                </div>
              )}

              {/* Picture-in-Picture Button */}
              {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
                <button
                  type="button"
                  onClick={togglePictureInPicture}
                  title={isPipActive ? 'Exit Picture-in-Picture' : 'Keep streaming in a mini floating window while using other apps'}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono border backdrop-blur-md transition flex items-center gap-1 ${
                    isPipActive
                      ? 'bg-sky-500/30 border-sky-400 text-sky-200'
                      : 'bg-slate-900/80 border-slate-800 text-slate-300 hover:text-white'
                  }`}
                >
                  <PictureInPicture className="w-3 h-3 text-sky-400" />
                  <span>{isPipActive ? 'In PiP' : 'PiP'}</span>
                </button>
              )}

              <div
                className={`px-2 py-0.5 rounded text-[10px] font-mono border backdrop-blur-md flex items-center gap-1 ${
                  isMicMuted
                    ? 'bg-rose-950/80 border-rose-800 text-rose-300'
                    : 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                }`}
              >
                {isMicMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
                {isMicMuted ? 'Mic Muted' : 'Mic Live'}
              </div>

              <div className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900/80 border border-slate-800 text-slate-300 backdrop-blur-md">
                {facingMode === 'environment' ? 'Rear' : 'Front'}
              </div>
            </div>
          )}
        </div>

        {/* Device Status Cards */}
        <div className="mt-4 rounded-xl bg-slate-900/70 border border-slate-800 p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Radio className="w-4 h-4 text-sky-400" />
              <div>
                <div className="text-xs font-semibold text-slate-200">Session connection</div>
                <div className="text-[11px] text-slate-400">{connectionStatus.text}</div>
              </div>
            </div>
            <StatusDot status={connectionStatus.connected ? 'good' : 'bad'} />
          </div>

          <div className="border-t border-slate-800/70 pt-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              {isOnline ? (
                <Wifi className="w-4 h-4 text-emerald-400" />
              ) : (
                <WifiOff className="w-4 h-4 text-rose-400" />
              )}
              <div>
                <div className="text-xs font-semibold text-slate-200">Internet connection</div>
                <div className="text-[11px] text-slate-400">{isOnline ? 'Online' : 'Offline'}</div>
              </div>
            </div>
            <StatusDot status={isOnline ? 'good' : 'bad'} />
          </div>

          {errorMessage && (
            <div className="pt-2">
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            </div>
          )}
        </div>

        {/* Keep-Alive & Consent Note */}
        <div className="my-4 p-3.5 rounded-xl bg-sky-500/10 border-l-4 border-sky-400 text-xs text-slate-300 space-y-2">
          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              <strong className="text-white font-medium">Keep-Alive Active:</strong> Screen Wake Lock keeps your phone screen on so streaming doesn't sleep or disconnect.
            </p>
          </div>
          <p className="text-[11px] text-slate-400 pl-6.5 leading-relaxed">
            💡 <em>Tip:</em> To use other apps on this phone while streaming, tap the <strong>PiP</strong> button on the video preview to keep streaming in a floating mini-window.
          </p>
        </div>

        {/* Action Controls */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-auto">
          {!isCameraActive ? (
            <button
              type="button"
              onClick={handleStartCamera}
              disabled={cameraLoading || isDisconnected}
              className="sm:col-span-3 py-3.5 px-4 rounded-xl font-semibold text-sm text-slate-950 bg-sky-400 hover:bg-sky-300 active:scale-[0.99] transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(56,189,248,0.3)]"
            >
              {cameraLoading ? (
                <>
                  <span className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                  Requesting camera & mic…
                </>
              ) : (
                <>
                  <Camera className="w-4 h-4" />
                  Allow camera & mic
                </>
              )}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleToggleMic}
                disabled={isDisconnected}
                className={`py-3 px-3 rounded-xl font-medium text-xs transition border flex items-center justify-center gap-1.5 ${
                  isMicMuted
                    ? 'bg-rose-500/10 border-rose-500/40 text-rose-300 hover:bg-rose-500/20'
                    : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                }`}
              >
                {isMicMuted ? <MicOff className="w-4 h-4 text-rose-400" /> : <Mic className="w-4 h-4 text-emerald-400" />}
                {isMicMuted ? 'Unmute Mic' : 'Mute Mic'}
              </button>

              <button
                type="button"
                onClick={handleSwitchCamera}
                disabled={isDisconnected}
                className="py-3 px-3 rounded-xl font-medium text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 active:scale-[0.99] transition border border-slate-700 flex items-center justify-center gap-1.5"
              >
                <SwitchCamera className="w-4 h-4 text-sky-400" />
                Switch camera
              </button>

              <button
                type="button"
                onClick={handleStopCamera}
                disabled={isDisconnected}
                className="py-3 px-3 rounded-xl font-medium text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 active:scale-[0.99] transition border border-slate-700 flex items-center justify-center gap-1.5"
              >
                <CameraOff className="w-4 h-4 text-amber-400" />
                Stop
              </button>
            </>
          )}
        </div>

        {/* Disconnect Button */}
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={isDisconnected}
          className="mt-3 w-full py-2.5 px-4 rounded-xl text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition border border-transparent hover:border-rose-500/20 disabled:opacity-40 flex items-center justify-center gap-1.5"
        >
          <PowerOff className="w-3.5 h-3.5" />
          {isDisconnected ? 'Session Disconnected' : 'Disconnect session'}
        </button>
      </main>
    </div>
  );
}
