'use strict';

// ===== State =====
let ws = null;
let pc = null;
let dc = null;
let faceStream = null;
let tabletopStream = null;
let faceVideoSender = null;    // RTCRtpSender for face video — used for mid-game replaceTrack()
let tabletopVideoSender = null;
let camsReady = false;
let isInitiator = false;
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
    case 'ROOM_CREATED':
      hide('lobby');
      show('waiting');
      $('room-code-display').textContent = msg.roomCode;
      break;

    case 'JOIN_SUCCESS':
      await startGame(false).catch(e => { alert(`Failed to start game: ${e.message}`); location.reload(); });
      break;

    case 'PEER_JOINED':
      await startGame(true).catch(e => { alert(`Failed to start game: ${e.message}`); location.reload(); });
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
      alert('Your opponent has disconnected.');
      location.reload();
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
  }));
}

function restoreCameraSelections() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAM_STORAGE_KEY));
    if (!saved) return;
    const faceOpt = $('face-cam-select').querySelector(`option[value="${saved.faceDeviceId}"]`);
    const tabOpt  = $('tabletop-cam-select').querySelector(`option[value="${saved.tabletopDeviceId}"]`);
    if (faceOpt) $('face-cam-select').value = saved.faceDeviceId;
    if (tabOpt)  $('tabletop-cam-select').value = saved.tabletopDeviceId;
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

async function populateCameraSelects() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');

  ['face-cam-select', 'tabletop-cam-select'].forEach(id => buildCameraOptions($(id), videoDevices));

  // Defaults: face = first cam, tabletop = second (if available)
  if (videoDevices.length > 0) $('face-cam-select').value = videoDevices[0].deviceId;
  if (videoDevices.length > 1) $('tabletop-cam-select').value = videoDevices[1].deviceId;
  else if (videoDevices.length > 0) $('tabletop-cam-select').value = videoDevices[0].deviceId;
}

async function populateGameCameraSelects() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');

  ['game-face-cam-select', 'game-tabletop-cam-select'].forEach(id => buildCameraOptions($(id), videoDevices));

  // Set to whatever is currently streaming (or disabled)
  const faceId = faceStream?.getVideoTracks()[0]?.getSettings().deviceId ?? 'disabled';
  const tabId  = tabletopStream?.getVideoTracks()[0]?.getSettings().deviceId ?? 'disabled';
  if ($('game-face-cam-select').querySelector(`option[value="${faceId}"]`))
    $('game-face-cam-select').value = faceId;
  if ($('game-tabletop-cam-select').querySelector(`option[value="${tabId}"]`))
    $('game-tabletop-cam-select').value = tabId;
}

// ===== Game setup =====
async function startGame(initiator) {
  isInitiator = initiator;
  hide('lobby');
  hide('waiting');
  show('game');
  setConnectionStatus('connecting');

  await startLocalStreams();
  populateGameCameraSelects();
  setupPeerConnection();

  if (isInitiator) {
    dc = pc.createDataChannel('meta');
    setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'OFFER', sdp: offer });
  }
}

async function startLocalStreams() {
  if (!camsReady) {
    showVideoError('local-face', 'No camera');
    showVideoError('local-tabletop', 'No camera');
    return;
  }

  const faceCamId = $('face-cam-select').value;
  const tabletopCamId = $('tabletop-cam-select').value;

  // Each stream attempt is independent — failure shows an overlay but never blocks the game

  // Face stream
  if (faceCamId === 'disabled') {
    showVideoError('local-face', 'Disabled');
    faceStream = null;
  } else {
    try {
      try {
        faceStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: faceCamId } },
          audio: true,
        });
      } catch {
        faceStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: faceCamId } },
        });
      }
      clearVideoError('local-face');
      $('local-face').srcObject = faceStream;
    } catch (e) {
      console.warn('Face cam failed:', e.message);
      showVideoError('local-face');
      faceStream = null;
    }
  }

  // Tabletop stream
  if (tabletopCamId === 'disabled') {
    showVideoError('local-tabletop', 'Disabled');
    tabletopStream = null;
  } else {
    try {
      if (tabletopCamId === faceCamId && faceStream) {
        // Same device selected — clone the track so each stream has a distinct ID
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
}

// ===== WebRTC =====
function setupPeerConnection() {
  pc = new RTCPeerConnection(ICE_SERVERS);

  // Add our tracks — track video senders so we can replaceTrack() mid-game
  faceVideoSender = null;
  tabletopVideoSender = null;
  if (faceStream) faceStream.getTracks().forEach(t => {
    const s = pc.addTrack(t, faceStream);
    if (t.kind === 'video') faceVideoSender = s;
  });
  if (tabletopStream) tabletopStream.getTracks().forEach(t => {
    const s = pc.addTrack(t, tabletopStream);
    if (t.kind === 'video') tabletopVideoSender = s;
  });

  pc.ontrack = e => {
    const stream = e.streams[0];
    remoteStreams[stream.id] = stream;
    applyRemoteStreams();
  };

  pc.onicecandidate = e => {
    if (e.candidate) wsSend({ type: 'ICE_CANDIDATE', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    setConnectionStatus(pc.connectionState);
  };

  // Joiner receives the data channel created by the host
  pc.ondatachannel = e => {
    dc = e.channel;
    setupDataChannel();
  };
}

async function handleOffer(sdp) {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'ANSWER', sdp: answer });
}

function setupDataChannel() {
  dc.onopen = () => {
    // null means that stream failed to start on our end
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

// Called whenever either remoteStreams or remoteStreamMapping is updated —
// whichever arrives last will complete the assignment.
function applyRemoteStreams() {
  if (!remoteStreamMapping) return;
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
    showVideoError('remote-tabletop', 'No tabletop cam');
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

function applyLayout(layout) {
  currentLayout = layout;
  $('game').dataset.layout = layout;

  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === layout);
  });

  const isSplit = layout !== 'default';
  $('secondary-panel').classList.toggle('hidden', !isSplit);
  $('local-tabletop-preview').classList.toggle('hidden', isSplit);

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

async function applyGameCameras() {
  const newFaceId = $('game-face-cam-select').value;
  const newTabId  = $('game-tabletop-cam-select').value;

  await switchGameCamera('face', newFaceId);
  await switchGameCamera('tabletop', newTabId);

  // Always re-send STREAM_MAPPING so remote reflects any disabled/enabled changes
  if (dc?.readyState === 'open') {
    dc.send(JSON.stringify({
      type: 'STREAM_MAPPING',
      faceStreamId: faceStream?.id ?? null,
      tabletopStreamId: tabletopStream?.id ?? null,
    }));
  }

  syncSecondaryPanel();

  localStorage.setItem(CAM_STORAGE_KEY, JSON.stringify({
    faceDeviceId: newFaceId,
    tabletopDeviceId: newTabId,
  }));
}

// ===== Camera swap =====
function swapCameras() {
  // Swap stream and sender variables so they stay aligned
  [faceStream, tabletopStream] = [tabletopStream, faceStream];
  [faceVideoSender, tabletopVideoSender] = [tabletopVideoSender, faceVideoSender];

  // Update local previews
  if (faceStream) { clearVideoError('local-face'); $('local-face').srcObject = faceStream; }
  else showVideoError('local-face');
  if (tabletopStream) { clearVideoError('local-tabletop'); $('local-tabletop').srcObject = tabletopStream; }
  else showVideoError('local-tabletop');

  // Tell the remote to re-assign which stream ID maps to face vs tabletop.
  // The tracks stay in their original streams — we're just updating the semantic
  // labels so the remote's video elements re-bind to the correct streams.
  if (dc?.readyState === 'open') {
    dc.send(JSON.stringify({
      type: 'STREAM_MAPPING',
      faceStreamId: faceStream?.id ?? null,
      tabletopStreamId: tabletopStream?.id ?? null,
    }));
  }

  // Transform states travel with their camera when swapping
  const tmp = videoTransforms['face-cam'];
  videoTransforms['face-cam'] = videoTransforms['tabletop-cam'];
  videoTransforms['tabletop-cam'] = tmp;

  syncSecondaryPanel();
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
  if (!pc) return;
  const audioSenders = pc.getSenders().filter(s => s.track?.kind === 'audio');
  if (!audioSenders.length) return;

  const nowMuted = audioSenders[0].track.enabled; // toggling: if currently enabled, we're about to mute
  audioSenders.forEach(s => { s.track.enabled = !nowMuted; });

  const btn = $('local-mic-mute');
  btn.textContent = nowMuted ? '🔇' : '🎤'; // 🔇 or 🎤
  btn.title = nowMuted ? 'Unmute mic' : 'Mute mic';
  btn.classList.toggle('muted', nowMuted);
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

// ===== Draggable overlay =====
function makeDraggable(el) {
  const handle = el.querySelector('.overlay-header');
  let startX, startY, startLeft, startTop;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = el.offsetLeft;
    startTop = el.offsetTop;

    const onMove = e => {
      const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, startLeft + e.clientX - startX));
      const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop + e.clientY - startY));
      el.style.left = newLeft + 'px';
      el.style.top  = newTop + 'px';
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

  tryAutoPopulateCameras();

  $('cam-access-btn').addEventListener('click', requestCameraAccess);

  $('face-cam-select').addEventListener('change', saveCameraSelections);
  $('tabletop-cam-select').addEventListener('change', saveCameraSelections);

  $('create-btn').addEventListener('click', () => {
    const password = $('create-password').value.trim();
    if (!password) return showLobbyError('Please enter a room password.');
    clearLobbyError();
    wsSend({ type: 'CREATE_ROOM', password });
  });

  $('join-btn').addEventListener('click', () => {
    const code = $('join-code').value.trim().toUpperCase();
    const password = $('join-password').value.trim();
    if (code.length !== 4) return showLobbyError('Enter the 4-character room code.');
    if (!password) return showLobbyError('Please enter the room password.');
    clearLobbyError();
    wsSend({ type: 'JOIN_ROOM', roomCode: code, password });
  });

  $('join-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });

  $('swap-btn').addEventListener('click', swapCameras);

  $('controls-btn').addEventListener('click', () => {
    $('controls-toggle').classList.toggle('open');
  });

  document.querySelectorAll('.layout-btn').forEach(btn => {
    btn.addEventListener('click', () => applyLayout(btn.dataset.layout));
  });

  $('face-overlay-minimize').addEventListener('click', () => {
    const isMin = $('face-overlay').classList.toggle('minimized');
    $('face-overlay-minimize').textContent = isMin ? '+' : '−';
  });

  $('local-face-vid').addEventListener('click', () => toggleLocalCam(faceStream, 'local-face-vid'));
  $('local-tabletop-vid').addEventListener('click', () => toggleLocalCam(tabletopStream, 'local-tabletop-vid'));

  $('remote-face-rotate').addEventListener('click', () => rotateVideo('remote-face'));

  setupCamControls('remote-tabletop-controls');
  setupCamControls('local-tabletop-main-controls');

  $('apply-cams-btn').addEventListener('click', applyGameCameras);

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

  makeDraggable($('face-overlay'));
}

document.addEventListener('DOMContentLoaded', init);
