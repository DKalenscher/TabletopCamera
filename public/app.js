'use strict';

// ===== State =====
let ws = null;
let pc = null;
let dc = null;
let faceStream = null;
let tabletopStream = null;
let micStream = null;
let faceVideoSender = null;
let tabletopVideoSender = null;
let micSender = null;
let micMuted = false;
let camsReady = false;
let isInitiator = false;
let isHost = false;
let currentRoomCode = null;
let myName = 'Player';
let opponentName = 'Opponent';
let currentRoomPassword = null;
const NAME_STORAGE_KEY = 'tc-display-name';
let remoteStreamMapping = null; // { faceStreamId, tabletopStreamId }
const remoteStreams = {};       // streamId -> MediaStream
let currentLayout = 'default';

// TURN server runs on the same Pi as the signaling server.
// location.hostname resolves correctly whether on LAN or internet.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: `turn:${location.hostname}:49152`,
      username: 'tabletop',
      credential: 'tc_turn_pw_9f2k',
    },
  ],
};

// ===== DOM helpers =====
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

function showWaitingOverlay() {
  const video = $('remote-tabletop');
  const overlay = $('remote-tabletop-error');
  if (video) video.style.visibility = 'hidden';
  if (!overlay) return;
  overlay.innerHTML = '';

  const waiting = document.createElement('div');
  waiting.className = 'waiting-overlay-content';

  const label = document.createElement('div');
  label.className = 'waiting-label';
  label.textContent = 'Waiting for opponent';
  waiting.appendChild(label);

  if (currentRoomCode) {
    const shareLabel = document.createElement('div');
    shareLabel.className = 'waiting-share-label';
    shareLabel.textContent = 'Share this room code:';
    waiting.appendChild(shareLabel);

    const code = document.createElement('div');
    code.className = 'waiting-room-code';
    code.textContent = currentRoomCode;
    waiting.appendChild(code);
  }

  overlay.appendChild(waiting);
  overlay.classList.remove('hidden');
}

function showPeerNoTabletop() {
  const video = $('remote-tabletop');
  const overlay = $('remote-tabletop-error');
  if (video) video.style.visibility = 'hidden';
  if (!overlay) return;
  overlay.innerHTML = '';
  const content = document.createElement('div');
  content.className = 'peer-no-cam-content';
  const name = document.createElement('div');
  name.className = 'peer-no-cam-name';
  name.textContent = opponentName;
  const msg = document.createElement('div');
  msg.className = 'peer-no-cam-msg';
  msg.textContent = 'No tabletop camera';
  content.appendChild(name);
  content.appendChild(msg);
  overlay.appendChild(content);
  overlay.classList.remove('hidden');
}

function showVideoError(videoId, msg = 'Could not start video') {
  const video = $(videoId);
  const overlay = $(`${videoId}-error`);
  if (video) video.style.visibility = 'hidden';
  if (overlay) {
    overlay.textContent = msg;
    overlay.classList.remove('hidden');
  }
}

function clearVideoError(videoId) {
  const video = $(videoId);
  const overlay = $(`${videoId}-error`);
  if (video) video.style.visibility = '';
  if (overlay) overlay.classList.add('hidden');
}

// ===== WebSocket =====
function connectWS() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = e => handleSignal(JSON.parse(e.data));
    ws.onclose = () => {
      if ($('game').classList.contains('hidden')) return;
      alert('Lost connection to the server.');
      location.reload();
    };
  });
}

function wsSend(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ===== Signaling =====
async function handleSignal(msg) {
  switch (msg.type) {
    case 'ROOM_JOINED':
      // Joiner learns the host's name here; host already knows their own
      if (!msg.isHost && msg.hostName) setOpponentName(msg.hostName);
      enterGame(msg.isHost, msg.roomCode);
      break;

    case 'PEER_JOINED':
      // Host receives this when a joiner connects — learn their name, start WebRTC
      setOpponentName(msg.name || 'Opponent');
      await startWebRTC(true).catch(e => console.error('WebRTC start failed:', e));
      break;

    case 'HOST_TRANSFERRED':
      // We were the joiner; original host left. We are now the host.
      isHost = true;
      isInitiator = true;
      currentRoomCode = msg.roomCode;
      $('room-code-game-value').textContent = msg.roomCode;
      peerDisconnected();
      break;

    case 'OFFER':
      await handleOffer(msg.sdp);
      break;

    case 'ANSWER':
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;

    case 'ICE_CANDIDATE':
      if (pc && msg.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      }
      break;

    case 'PEER_DISCONNECTED':
      peerDisconnected();
      break;

    case 'CHAT':
      if (msg.system) appendSystemMessage(msg.text);
      else appendChatMessage(msg.text, msg.name || opponentName, false);
      break;

    case 'ERROR':
      showLobbyError(msg.message);
      break;
  }
}

// ===== Camera setup =====
const CAM_STORAGE_KEY = 'tc-cam-selections';

function saveCameraSelections() {
  localStorage.setItem(CAM_STORAGE_KEY, JSON.stringify({
    faceDeviceId: $('face-cam-select').value,
    tabletopDeviceId: $('tabletop-cam-select').value,
    micDeviceId: $('mic-select').value,
  }));
}

function restoreCameraSelections() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAM_STORAGE_KEY));
    if (!saved) return;
    const faceOpt = $('face-cam-select').querySelector(`option[value="${saved.faceDeviceId}"]`);
    const tabOpt  = $('tabletop-cam-select').querySelector(`option[value="${saved.tabletopDeviceId}"]`);
    const micOpt  = $('mic-select').querySelector(`option[value="${saved.micDeviceId}"]`);
    if (faceOpt) $('face-cam-select').value = saved.faceDeviceId;
    if (tabOpt)  $('tabletop-cam-select').value = saved.tabletopDeviceId;
    if (micOpt)  $('mic-select').value = saved.micDeviceId;
  } catch {}
}

async function tryAutoPopulateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    // Labels are only present when permission was already granted
    if (videoDevices.length > 0 && videoDevices.some(d => d.label)) {
      await populateCameraSelects();
      restoreCameraSelections();
      hide('cam-permission');
      show('cam-selects');
      camsReady = true;
    }
  } catch {}
}

async function requestCameraAccess() {
  try {
    // Trigger permission prompt — try with audio, fall back to video-only if no mic
    let tmp;
    try {
      tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    tmp.getTracks().forEach(t => t.stop());
    await populateCameraSelects();
    restoreCameraSelections();
    hide('cam-permission');
    show('cam-selects');
    camsReady = true;
  } catch (e) {
    showLobbyError(
      `Camera error: ${e.message}. ` +
      `Click the lock/info icon in your address bar → Site settings → Reset permissions, then reload.`
    );
  }
}

function buildCameraOptions(sel, videoDevices) {
  sel.innerHTML = '';
  const disabledOpt = document.createElement('option');
  disabledOpt.value = 'disabled';
  disabledOpt.textContent = '— Disabled —';
  sel.appendChild(disabledOpt);
  videoDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(opt);
  });
}

function buildMicOptions(sel, audioDevices) {
  sel.innerHTML = '';
  const disabledOpt = document.createElement('option');
  disabledOpt.value = 'disabled';
  disabledOpt.textContent = '— Disabled —';
  sel.appendChild(disabledOpt);
  audioDevices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${i + 1}`;
    sel.appendChild(opt);
  });
}

async function populateCameraSelects() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  const audioDevices = devices.filter(d => d.kind === 'audioinput');

  ['face-cam-select', 'tabletop-cam-select'].forEach(id => buildCameraOptions($(id), videoDevices));
  buildMicOptions($('mic-select'), audioDevices);

  // Defaults: face = first cam, tabletop = second (if available), mic = first audio
  if (videoDevices.length > 0) $('face-cam-select').value = videoDevices[0].deviceId;
  if (videoDevices.length > 1) $('tabletop-cam-select').value = videoDevices[1].deviceId;
  else if (videoDevices.length > 0) $('tabletop-cam-select').value = videoDevices[0].deviceId;
  if (audioDevices.length > 0) $('mic-select').value = audioDevices[0].deviceId;
}

async function populateGameCameraSelects() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');
  const audioDevices = devices.filter(d => d.kind === 'audioinput');

  ['game-face-cam-select', 'game-tabletop-cam-select'].forEach(id => buildCameraOptions($(id), videoDevices));
  buildMicOptions($('game-mic-select'), audioDevices);

  // Set to whatever is currently streaming (or disabled)
  const faceId = faceStream?.getVideoTracks()[0]?.getSettings().deviceId ?? 'disabled';
  const tabId  = tabletopStream?.getVideoTracks()[0]?.getSettings().deviceId ?? 'disabled';
  const micId  = micStream?.getAudioTracks()[0]?.getSettings().deviceId ?? 'disabled';
  if ($('game-face-cam-select').querySelector(`option[value="${faceId}"]`))
    $('game-face-cam-select').value = faceId;
  if ($('game-tabletop-cam-select').querySelector(`option[value="${tabId}"]`))
    $('game-tabletop-cam-select').value = tabId;
  if ($('game-mic-select').querySelector(`option[value="${micId}"]`))
    $('game-mic-select').value = micId;
}

// ===== Game setup =====

// Enter the game UI immediately. Called for both host and joiner on ROOM_JOINED.
// Streams are already open (started before wsSend in the button handlers).
// WebRTC is not started here — it waits until a peer is present.
function enterGame(host, roomCode) {
  isHost = host;
  isInitiator = host;
  currentRoomCode = roomCode;

  hide('lobby');
  show('game');
  $('room-code-game-value').textContent = roomCode;
  setConnectionStatus('waiting');
  showWaitingOverlay();
  showVideoError('remote-face', 'Waiting for opponent…');

  populateGameCameraSelects();
}

// Tear down the peer connection and return to "waiting" state in-game.
// The local cameras and game UI remain; the room stays open on the server.
function peerDisconnected() {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  dc = null;
  faceVideoSender = null;
  tabletopVideoSender = null;
  micSender = null;
  remoteStreamMapping = null;
  Object.keys(remoteStreams).forEach(k => delete remoteStreams[k]);

  $('remote-face').srcObject = null;
  $('remote-tabletop').srcObject = null;
  showWaitingOverlay();
  showVideoError('remote-face', 'Waiting for opponent…');

  setOpponentName('Opponent');
  setConnectionStatus('waiting');
}

async function startLocalStreams() {
  if (!camsReady) {
    showVideoError('local-face', 'No camera');
    showVideoError('local-tabletop', 'No camera');
    return;
  }

  const faceCamId    = $('face-cam-select').value;
  const tabletopCamId = $('tabletop-cam-select').value;
  const micId        = $('mic-select').value;

  // Each stream attempt is independent — failure shows an overlay but never blocks the game

  // Face: video only
  if (faceCamId === 'disabled') {
    showVideoError('local-face', 'Disabled');
    faceStream = null;
  } else {
    try {
      faceStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: faceCamId } },
      });
      clearVideoError('local-face');
      $('local-face').srcObject = faceStream;
    } catch (e) {
      console.warn('Face cam failed:', e.message);
      showVideoError('local-face');
      faceStream = null;
    }
  }

  // Tabletop: video only
  if (tabletopCamId === 'disabled') {
    showVideoError('local-tabletop', 'Disabled');
    tabletopStream = null;
  } else {
    try {
      if (tabletopCamId === faceCamId && faceStream) {
        // Same device — clone so each stream has a distinct ID
        tabletopStream = new MediaStream([faceStream.getVideoTracks()[0].clone()]);
      } else {
        tabletopStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: tabletopCamId } },
        });
      }
      clearVideoError('local-tabletop');
      $('local-tabletop').srcObject = tabletopStream;
    } catch (e) {
      console.warn('Tabletop cam failed:', e.message);
      tabletopStream = null;
      showVideoError('local-tabletop');
    }
  }

  // Microphone: audio only, independent of cameras
  micStream = null;
  if (micId !== 'disabled') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: micId } },
      });
    } catch (e) {
      console.warn('Mic failed:', e.message);
    }
  }
}

// ===== WebRTC =====
function setupPeerConnection() {
  const faceTracks = faceStream ? faceStream.getTracks().length : 0;
  const tabTracks = tabletopStream ? tabletopStream.getTracks().length : 0;
  console.log(`[WebRTC] setupPeerConnection — faceStream tracks: ${faceTracks}, tabletopStream tracks: ${tabTracks}`);

  pc = new RTCPeerConnection(ICE_SERVERS);

  // Add our tracks — track video senders so we can replaceTrack() mid-game
  faceVideoSender = null;
  tabletopVideoSender = null;
  if (faceStream) faceStream.getTracks().forEach(t => {
    const s = pc.addTrack(t, faceStream);
    if (t.kind === 'video') faceVideoSender = s;
    console.log(`[WebRTC] added local face track: ${t.kind} (${t.label})`);
  });
  if (tabletopStream) tabletopStream.getTracks().forEach(t => {
    const s = pc.addTrack(t, tabletopStream);
    if (t.kind === 'video') tabletopVideoSender = s;
    console.log(`[WebRTC] added local tabletop track: ${t.kind} (${t.label})`);
  });

  // Mic audio — bundled with face stream so the remote hears it through the face video element.
  // Falls back to tabletop stream if face is disabled.
  micSender = null;
  if (micStream) {
    const audioTrack = micStream.getAudioTracks()[0];
    const assocStream = faceStream || tabletopStream;
    if (audioTrack && assocStream) {
      micSender = pc.addTrack(audioTrack, assocStream);
      console.log(`[WebRTC] added mic audio (${audioTrack.label})`);
    }
  }

  pc.ontrack = e => {
    const stream = e.streams[0];
    console.log(`[WebRTC] ontrack — kind: ${e.track.kind}, streamId: ${stream?.id}`);
    if (!stream) return;
    remoteStreams[stream.id] = stream;
    applyRemoteStreams();

    if (e.track.kind === 'video') {
      e.track.onmute = () => {
        const videoId = remoteVideoIdForStream(stream.id);
        if (!videoId) return;
        const vid = $(videoId);
        if (vid.srcObject === stream) showVideoError(videoId, 'Camera off');
      };
      e.track.onunmute = () => {
        applyRemoteStreams();
      };
      e.track.onended = () => {
        if (pc) peerDisconnected();
      };
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate) wsSend({ type: 'ICE_CANDIDATE', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] connectionState: ${pc.connectionState}`);
    setConnectionStatus(pc.connectionState);
    if (pc.connectionState === 'failed') peerDisconnected();
  };

  pc.onicegatheringstatechange = () => {
    console.log(`[WebRTC] iceGatheringState: ${pc.iceGatheringState}`);
  };

  // Joiner receives the data channel created by the host
  pc.ondatachannel = e => {
    dc = e.channel;
    setupDataChannel();
  };
}

async function startWebRTC(initiator) {
  console.log(`[WebRTC] startWebRTC — initiator: ${initiator}`);
  isInitiator = initiator;
  setupPeerConnection();

  if (initiator) {
    dc = pc.createDataChannel('meta');
    setupDataChannel();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log('[WebRTC] sending OFFER');
    wsSend({ type: 'OFFER', sdp: offer });
  }
}

async function handleOffer(sdp) {
  console.log('[WebRTC] handleOffer — faceStream:', !!faceStream, 'tabletopStream:', !!tabletopStream);
  if (!pc) setupPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  console.log('[WebRTC] sending ANSWER');
  wsSend({ type: 'ANSWER', sdp: answer });
}

function setupDataChannel() {
  dc.onopen = () => {
    dc.send(JSON.stringify({
      type: 'STREAM_MAPPING',
      faceStreamId: faceStream?.id ?? null,
      tabletopStreamId: tabletopStream?.id ?? null,
    }));
  };

  dc.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'STREAM_MAPPING') {
      remoteStreamMapping = msg;
      applyRemoteStreams();
    }
  };
}

function remoteVideoIdForStream(streamId) {
  if (!remoteStreamMapping) return null;
  if (streamId === remoteStreamMapping.faceStreamId) return 'remote-face';
  if (streamId === remoteStreamMapping.tabletopStreamId) return 'remote-tabletop';
  return null;
}

// Called whenever either remoteStreams or remoteStreamMapping is updated —
// whichever arrives last will complete the assignment.
function applyRemoteStreams() {
  if (!remoteStreamMapping) {
    console.log('[WebRTC] applyRemoteStreams — no mapping yet, known streams:', Object.keys(remoteStreams));
    return;
  }
  console.log('[WebRTC] applyRemoteStreams — mapping:', remoteStreamMapping, 'known streams:', Object.keys(remoteStreams));
  const { faceStreamId, tabletopStreamId } = remoteStreamMapping;

  if (faceStreamId === null) {
    showVideoError('remote-face', 'No face cam');
  } else {
    const face = remoteStreams[faceStreamId];
    if (face && $('remote-face').srcObject !== face) {
      clearVideoError('remote-face');
      $('remote-face').srcObject = face;
    }
  }

  if (tabletopStreamId === null) {
    showPeerNoTabletop();
  } else {
    const tabletop = remoteStreams[tabletopStreamId];
    if (tabletop && $('remote-tabletop').srcObject !== tabletop) {
      clearVideoError('remote-tabletop');
      $('remote-tabletop').srcObject = tabletop;
    }
  }
}

// ===== Layout =====
function syncSecondaryPanel() {
  if (currentLayout === 'default') return;
  const vid = $('local-tabletop-main');
  if (tabletopStream) {
    clearVideoError('local-tabletop-main');
    vid.srcObject = tabletopStream;
  } else {
    vid.srcObject = null;
    showVideoError('local-tabletop-main', 'No tabletop cam');
  }
  applyVideoTransform('tabletop-cam');
}

function resetPanelSizes() {
  const mv = $('main-view');
  mv.style.flexBasis = '';
  mv.style.flexGrow  = '';
  mv.style.flexShrink = '';
}

function applyLayout(layout) {
  currentLayout = layout;
  $('game').dataset.layout = layout;

  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });

  const isSplit = layout !== 'default';
  $('secondary-panel').classList.toggle('hidden', !isSplit);
  $('split-divider').classList.toggle('hidden', !isSplit);
  $('local-tabletop-preview').classList.toggle('hidden', isSplit);

  resetPanelSizes(); // always reset when layout is applied or re-selected

  if (isSplit) {
    syncSecondaryPanel();
  } else {
    $('local-tabletop-main').srcObject = null;
  }
}

// ===== Mid-game camera change =====
async function switchGameCamera(slot, newDeviceId) {
  const isface = slot === 'face';
  const stream  = isface ? faceStream : tabletopStream;
  const sender  = isface ? faceVideoSender : tabletopVideoSender;
  const videoElId = isface ? 'local-face' : 'local-tabletop';
  const isDisabled = newDeviceId === 'disabled';

  const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? 'disabled';
  if (currentId === newDeviceId) return;

  // Stop and remove the current video track (keeps stream object alive for sender stability)
  const oldTrack = stream?.getVideoTracks()[0];
  if (oldTrack) { oldTrack.stop(); stream.removeTrack(oldTrack); }

  let newTrack = null;
  if (!isDisabled) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: newDeviceId } } });
      newTrack = tmp.getVideoTracks()[0];
      if (stream) stream.addTrack(newTrack);
      clearVideoError(videoElId);
    } catch (e) {
      console.warn(`${slot} cam switch failed:`, e.message);
      showVideoError(videoElId, 'Could not start');
    }
  } else {
    showVideoError(videoElId, 'Disabled');
  }

  if (!newTrack && !stream) {
    // Camera was disabled at game start and still no stream — can't add tracks without reconnecting
    if (!isDisabled) showVideoError(videoElId, 'Leave and rejoin to enable');
  }

  if (sender) {
    try { await sender.replaceTrack(newTrack ?? null); } catch {}
  }

  if (isface) faceStream = stream;  // stream object unchanged (tracks swapped within it)
  else tabletopStream = stream;
}

async function switchGameMic(newDeviceId) {
  const currentId = micStream?.getAudioTracks()[0]?.getSettings().deviceId ?? 'disabled';
  if (currentId === newDeviceId) return;

  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;

  if (newDeviceId !== 'disabled') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: newDeviceId } },
      });
      // Respect current mute state on the new track
      if (micMuted) micStream.getAudioTracks().forEach(t => { t.enabled = false; });
    } catch (e) {
      console.warn('Mic switch failed:', e.message);
    }
  }

  if (micSender) {
    try { await micSender.replaceTrack(micStream?.getAudioTracks()[0] ?? null); } catch {}
  }
}


// ===== Video transforms (pan / zoom / rotate) =====
// Transforms are keyed by a logical slot name, not DOM element ID.
// 'tabletop-cam' and 'face-cam' travel with the camera when the user swaps.
// 'remote-tabletop' and 'remote-face' are stable element-based keys.
const videoTransforms = {};

// Maps logical slot → DOM element ID where they differ
const SLOT_TO_ELEMENT = { 'tabletop-cam': 'local-tabletop-main', 'face-cam': 'local-face' };

const ZOOM_STEP = 0.25;
const PAN_STEP  = 5; // percent of element size per click

function getTransform(slot) {
  if (!videoTransforms[slot]) videoTransforms[slot] = { rotation: 0, scale: 1, tx: 0, ty: 0 };
  return videoTransforms[slot];
}

function applyVideoTransform(slot) {
  const elementId = SLOT_TO_ELEMENT[slot] ?? slot;
  const video = $(elementId);
  if (!video) return;
  const { rotation, scale, tx, ty } = getTransform(slot);
  // translate outermost → always screen-space, independent of rotation
  video.style.transform = `translate(${tx}%, ${ty}%) scale(${scale}) rotate(${rotation}deg)`;
}

function rotateVideo(slot) {
  const t = getTransform(slot);
  t.rotation = (t.rotation + 90) % 360;
  applyVideoTransform(slot);
}

function zoomVideo(slot, dir) {
  const t = getTransform(slot);
  t.scale = Math.max(1, Math.min(8, t.scale + dir * ZOOM_STEP));
  const maxPan = (1 - 1 / t.scale) * 50;
  t.tx = Math.max(-maxPan, Math.min(maxPan, t.tx));
  t.ty = Math.max(-maxPan, Math.min(maxPan, t.ty));
  applyVideoTransform(slot);
}

function panVideo(slot, dx, dy) {
  const t = getTransform(slot);
  if (t.scale <= 1) return;
  const maxPan = (1 - 1 / t.scale) * 50;
  t.tx = Math.max(-maxPan, Math.min(maxPan, t.tx + dx * PAN_STEP));
  t.ty = Math.max(-maxPan, Math.min(maxPan, t.ty + dy * PAN_STEP));
  applyVideoTransform(slot);
}

function resetVideoTransform(slot) {
  videoTransforms[slot] = { rotation: 0, scale: 1, tx: 0, ty: 0 };
  applyVideoTransform(slot);
}

function setupCamControls(groupId) {
  const group = $(groupId);
  if (!group) return;
  group.querySelector('.cam-controls-toggle').addEventListener('click', () => {
    group.querySelector('.cam-controls-panel').classList.toggle('hidden');
  });
  group.querySelectorAll('.cc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.dataset.video;
      switch (btn.dataset.action) {
        case 'zoom-in':   zoomVideo(slot,  1);    break;
        case 'zoom-out':  zoomVideo(slot, -1);    break;
        case 'rotate':    rotateVideo(slot);       break;
        case 'reset':     resetVideoTransform(slot); break;
        case 'pan-up':    panVideo(slot,  0,  1); break; // positive ty = content moves down = view pans up
        case 'pan-down':  panVideo(slot,  0, -1); break;
        case 'pan-left':  panVideo(slot, -1,  0); break;
        case 'pan-right': panVideo(slot,  1,  0); break;
      }
    });
  });
}

// ===== Chat =====
function appendSystemMessage(text) {
  const msgs = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  if ($('chat-box').classList.contains('collapsed')) show('chat-unread');
}

function appendChatMessage(text, senderName, mine) {
  const msgs = $('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;

  const name = document.createElement('div');
  name.className = 'chat-msg-name';
  name.textContent = senderName;
  div.appendChild(name);

  const body = document.createTextNode(text);
  div.appendChild(body);

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  if ($('chat-box').classList.contains('collapsed')) {
    show('chat-unread');
  }
}

function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  wsSend({ type: 'CHAT', text });
  appendChatMessage(text, myName, true);
  input.value = '';
}

// ===== Camera video toggle =====
function toggleLocalCam(stream, btnId) {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = $(btnId);
  btn.classList.toggle('muted', !track.enabled);
  btn.title = track.enabled ? 'Disable camera' : 'Enable camera';
}

// ===== Mic mute =====
function toggleLocalMic() {
  micMuted = !micMuted;
  if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  const btn = $('local-mic-mute');
  btn.textContent = micMuted ? '🔇' : '🎤';
  btn.title = micMuted ? 'Unmute mic' : 'Mute mic';
  btn.classList.toggle('muted', micMuted);
}

// ===== Remote audio controls =====
function updateRemoteMuteBtn(muted) {
  const btn = $('remote-face-mute');
  btn.textContent = muted ? '🔇' : '🔊'; // 🔇 or 🔊
  btn.title = muted ? 'Unmute opponent audio' : 'Mute opponent audio';
  btn.classList.toggle('muted', muted);
}

// ===== UI helpers =====
function setConnectionStatus(state) {
  const dot = $('connection-status').querySelector('.status-dot');
  const label = $('connection-status').querySelector('span');
  dot.className = 'status-dot';

  if (state === 'connected') {
    dot.classList.add('connected');
    label.textContent = 'Connected';
  } else if (state === 'waiting') {
    dot.classList.add('connecting');
    label.textContent = 'Waiting for opponent…';
  } else if (['connecting', 'new', 'checking'].includes(state)) {
    dot.classList.add('connecting');
    label.textContent = 'Connecting…';
  } else {
    dot.classList.add('failed');
    label.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }
}

function showLobbyError(msg) {
  const el = $('lobby-status');
  el.textContent = msg;
  el.className = 'status-msg error';
}

function clearLobbyError() {
  const el = $('lobby-status');
  el.textContent = '';
  el.className = 'status-msg';
}

// ===== Opponent name =====
function setOpponentName(name) {
  opponentName = name;
  $('face-overlay-title').textContent = `⋮ ${name}`;
  $('remote-tabletop-label').textContent = `${name}'s Tabletop`;
}

// ===== Draggable overlay =====
// Works for any element + handle. On first drag converts bottom/right CSS to top/left
// so subsequent moves are always in the same coordinate space.
function makeDraggable(el, handle, getEffectiveHeight) {
  handle = handle ?? el.querySelector('.overlay-header');

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const parent = el.offsetParent || document.body;
    let startLeft, startTop, normalised = false;

    const onMove = e => {
      if (!normalised) {
        // Normalise bottom/right → top/left on the first actual drag movement,
        // not on mousedown, so plain clicks don't disturb CSS-based positioning.
        el.style.top = el.offsetTop + 'px'; el.style.bottom = 'auto';
        el.style.left = el.offsetLeft + 'px'; el.style.right = 'auto';
        startLeft = el.offsetLeft;
        startTop  = el.offsetTop;
        normalised = true;
      }
      const effectiveH = getEffectiveHeight ? getEffectiveHeight() : el.offsetHeight;
      const newLeft = Math.max(0, Math.min(parent.clientWidth  - el.offsetWidth,  startLeft + e.clientX - startX));
      const newTop  = Math.max(0, Math.min(parent.clientHeight - effectiveH,       startTop  + e.clientY - startY));
      el.style.left = newLeft + 'px';
      el.style.top  = newTop  + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ===== Init =====
async function init() {
  try {
    await connectWS();
  } catch {
    showLobbyError('Could not connect to server. Is it running?');
    return;
  }

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      clearLobbyError();
    });
  });

  // Display name — restore from localStorage, save on change
  const savedName = localStorage.getItem(NAME_STORAGE_KEY);
  if (savedName) $('display-name').value = savedName;
  $('display-name').addEventListener('input', e => {
    localStorage.setItem(NAME_STORAGE_KEY, e.target.value.trim());
  });

  tryAutoPopulateCameras();

  $('cam-access-btn').addEventListener('click', requestCameraAccess);

  $('face-cam-select').addEventListener('change', saveCameraSelections);
  $('tabletop-cam-select').addEventListener('change', saveCameraSelections);
  $('mic-select').addEventListener('change', saveCameraSelections);

  $('create-btn').addEventListener('click', async () => {
    const name = $('display-name').value.trim();
    const password = $('create-password').value.trim();
    if (!name) return showLobbyError('Please enter a display name.');
    if (!password) return showLobbyError('Please enter a room password.');
    myName = name;
    currentRoomPassword = password;
    localStorage.setItem(NAME_STORAGE_KEY, name);
    clearLobbyError();
    $('create-btn').disabled = true;
    console.log('[Init] Starting local streams before CREATE_ROOM');
    await startLocalStreams();
    console.log('[Init] Streams ready — faceStream:', !!faceStream, 'tabletopStream:', !!tabletopStream);
    $('create-btn').disabled = false;
    wsSend({ type: 'CREATE_ROOM', password, name });
  });

  $('join-btn').addEventListener('click', async () => {
    const name = $('display-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    const password = $('join-password').value.trim();
    if (!name) return showLobbyError('Please enter a display name.');
    if (code.length !== 4) return showLobbyError('Enter the 4-character room code.');
    if (!password) return showLobbyError('Please enter the room password.');
    myName = name;
    currentRoomPassword = password;
    localStorage.setItem(NAME_STORAGE_KEY, name);
    clearLobbyError();
    $('join-btn').disabled = true;
    console.log('[Init] Starting local streams before JOIN_ROOM');
    await startLocalStreams();
    console.log('[Init] Streams ready — faceStream:', !!faceStream, 'tabletopStream:', !!tabletopStream);
    $('join-btn').disabled = false;
    wsSend({ type: 'JOIN_ROOM', roomCode: code, password, name });
  });

  $('join-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });


  $('controls-btn').addEventListener('click', () => {
    $('controls-toggle').classList.toggle('open');
  });

  const SVG_EYE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const SVG_EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

  $('room-password-toggle').innerHTML = SVG_EYE;

  let passwordVisible = false;
  $('room-password-toggle').addEventListener('click', () => {
    passwordVisible = !passwordVisible;
    $('room-password-value').textContent = passwordVisible
      ? (currentRoomPassword ?? '')
      : '•'.repeat(currentRoomPassword?.length ?? 4);
    $('room-password-toggle').innerHTML = passwordVisible ? SVG_EYE_OFF : SVG_EYE;
    $('room-password-toggle').title = passwordVisible ? 'Hide password' : 'Show password';
  });

  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => applyLayout(btn.dataset.layout));
  });

  let savedOverlayHeight = null;
  $('face-overlay-minimize').addEventListener('click', () => {
    const el = $('face-overlay');
    const isMin = el.classList.toggle('minimized');
    $('face-overlay-minimize').textContent = isMin ? '+' : '−';
    if (isMin) {
      savedOverlayHeight = el.style.height || null;
      el.style.height = '';
    } else {
      if (savedOverlayHeight) el.style.height = savedOverlayHeight;
    }
  });

  $('local-face-vid').addEventListener('click', () => toggleLocalCam(faceStream, 'local-face-vid'));
  $('local-tabletop-vid').addEventListener('click', () => toggleLocalCam(tabletopStream, 'local-tabletop-vid'));

  $('remote-face-rotate').addEventListener('click', () => rotateVideo('remote-face'));

  setupCamControls('remote-tabletop-controls');
  setupCamControls('local-tabletop-main-controls');

  $('game-face-cam-select').addEventListener('change', async e => {
    await switchGameCamera('face', e.target.value);
    syncSecondaryPanel();
    saveCameraSelections();
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'STREAM_MAPPING', faceStreamId: faceStream?.id ?? null, tabletopStreamId: tabletopStream?.id ?? null }));
  });
  $('game-tabletop-cam-select').addEventListener('change', async e => {
    await switchGameCamera('tabletop', e.target.value);
    syncSecondaryPanel();
    saveCameraSelections();
    if (dc?.readyState === 'open') dc.send(JSON.stringify({ type: 'STREAM_MAPPING', faceStreamId: faceStream?.id ?? null, tabletopStreamId: tabletopStream?.id ?? null }));
  });
  $('game-mic-select').addEventListener('change', async e => {
    await switchGameMic(e.target.value);
    saveCameraSelections();
  });

  // Draggable split divider
  $('split-divider').addEventListener('mousedown', e => {
    e.preventDefault();
    const divider = $('split-divider');
    divider.classList.add('dragging');
    const isTB = currentLayout === 'split-tb';
    const mainView = $('main-view');

    const onMove = e => {
      const rect = $('video-area').getBoundingClientRect();
      const areaSize  = isTB ? rect.height : rect.width;
      const areaStart = isTB ? rect.top    : rect.left;
      const pos = isTB ? e.clientY : e.clientX;
      const newSize = Math.max(areaSize * 0.1, Math.min(areaSize * 0.9, pos - areaStart));
      mainView.style.flexBasis  = `${newSize}px`;
      mainView.style.flexGrow   = '0';
      mainView.style.flexShrink = '0';
    };

    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  $('local-previews-toggle').addEventListener('click', () => {
    const collapsed = $('local-previews').classList.toggle('collapsed');
    $('local-previews-toggle').textContent = collapsed ? '▴' : '▾';
  });

  $('local-mic-mute').addEventListener('click', toggleLocalMic);

  $('remote-face-volume').addEventListener('input', e => {
    const video = $('remote-face');
    video.volume = parseFloat(e.target.value);
    if (video.muted && video.volume > 0) {
      video.muted = false;
      updateRemoteMuteBtn(false);
    }
  });

  $('remote-face-mute').addEventListener('click', () => {
    const video = $('remote-face');
    video.muted = !video.muted;
    updateRemoteMuteBtn(video.muted);
  });

  $('leave-btn').addEventListener('click', () => {
    if (confirm('Leave the game?')) location.reload();
  });

  // Chat
  $('chat-toggle-btn').addEventListener('click', () => {
    const box = $('chat-box');
    const collapsed = box.classList.toggle('collapsed');
    $('chat-toggle-btn').textContent = collapsed ? '▴' : '▾';
    if (!collapsed) {
      hide('chat-unread');
      $('chat-input').focus();
    }
  });

  // Chat font size (rem, clamped 0.6–1.2)
  let chatFontSize = 0.8;
  const setChatFont = size => {
    chatFontSize = Math.min(1.2, Math.max(0.6, size));
    $('chat-messages').style.fontSize = `${chatFontSize}rem`;
  };
  $('chat-font-plus') .addEventListener('click', () => setChatFont(chatFontSize + 0.1));
  $('chat-font-minus').addEventListener('click', () => setChatFont(chatFontSize - 0.1));

  $('chat-send-btn').addEventListener('click', sendChat);

  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  makeDraggable($('face-overlay'));

  // Chat box uses bottom-anchored drag so the header stays fixed and body expands upward.
  $('chat-header').addEventListener('mousedown', e => {
    if (e.target.closest('button, input, select')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const box = $('chat-box');
    const parent = box.offsetParent || document.body;
    let startLeft, startBottom, normalised = false;
    const onMove = e => {
      if (!normalised) {
        box.style.right  = 'auto';
        box.style.top    = 'auto';
        box.style.left   = box.offsetLeft + 'px';
        box.style.bottom = Math.max(0, parent.clientHeight - box.offsetTop - box.offsetHeight) + 'px';
        startLeft   = box.offsetLeft;
        startBottom = parseFloat(box.style.bottom);
        normalised  = true;
      }
      const newLeft   = Math.max(0, Math.min(parent.clientWidth  - box.offsetWidth,  startLeft   + e.clientX - startX));
      const newBottom = Math.max(0, Math.min(parent.clientHeight - box.offsetHeight, startBottom - (e.clientY - startY)));
      box.style.left   = newLeft   + 'px';
      box.style.bottom = newBottom + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Resize handle for face overlay
  $('face-overlay-resize').addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const el = $('face-overlay');
    if (el.classList.contains('minimized')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;

    const onMove = e => {
      el.style.width  = Math.max(140, startW + e.clientX - startX) + 'px';
      el.style.height = Math.max(80,  startH + e.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

document.addEventListener('DOMContentLoaded', init);
