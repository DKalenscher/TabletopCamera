const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CERT_DIR = path.join(__dirname, 'certs');
const tlsOptions = {
  key:  fs.readFileSync(path.join(CERT_DIR, 'server.key')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'server.cert')),
};

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

// rooms: code -> { password, host: ws|null, joiner: ws|null, roomCode }
// Rooms persist until the last player leaves.
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.random() * chars.length | 0]).join('');
  } while (rooms.has(code));
  return code;
}

const server = https.createServer(tlsOptions, (req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const send = (ws, msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function getRoomFor(ws) {
  for (const room of rooms.values()) {
    if (room.host === ws || room.joiner === ws) return room;
  }
  return null;
}

function relay(fromWs, msg) {
  const room = getRoomFor(fromWs);
  if (!room) return;
  const peer = room.host === fromWs ? room.joiner : room.host;
  send(peer, msg);
}

function onDisconnect(ws) {
  const room = getRoomFor(ws);
  if (!room) return;

  if (room.host === ws) {
    const hostName = room.hostName;
    room.host = null;
    if (room.joiner) {
      // Promote joiner to host; they stay in the room waiting for a new joiner
      room.hostName = room.joinerName;
      room.host = room.joiner;
      room.joiner = null;
      room.joinerName = null;
      send(room.host, { type: 'HOST_TRANSFERRED', roomCode: room.roomCode });
      send(room.host, { type: 'CHAT', system: true, text: `${hostName} left — you are now the host.` });
      console.log(`Room ${room.roomCode}: ${hostName} left, transferred to ${room.hostName}`);
    } else {
      rooms.delete(room.roomCode);
      console.log(`Room ${room.roomCode} closed (last player left)`);
    }
  } else {
    // Joiner disconnected; host stays, room stays open
    const joinerName = room.joinerName;
    room.joiner = null;
    room.joinerName = null;
    send(room.host, { type: 'PEER_DISCONNECTED' });
    send(room.host, { type: 'CHAT', system: true, text: `${joinerName} left.` });
    console.log(`Room ${room.roomCode}: ${joinerName} left, host waiting`);
  }
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_ROOM') {
      const password = String(msg.password || '');
      if (!password) return send(ws, { type: 'ERROR', message: 'Password required' });
      const name = String(msg.name || '').trim().slice(0, 32) || 'Player';
      const code = genCode();
      rooms.set(code, { password, host: ws, joiner: null, hostName: name, joinerName: null, roomCode: code });
      send(ws, { type: 'ROOM_JOINED', roomCode: code, isHost: true });
      send(ws, { type: 'CHAT', system: true, text: `Room ${code} created. Share this code with your opponent.` });
      console.log(`Room ${code} created by ${name}`);
    }

    else if (msg.type === 'JOIN_ROOM') {
      const code = String(msg.roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'ERROR', message: 'Room not found' });
      if (room.password !== String(msg.password || '')) return send(ws, { type: 'ERROR', message: 'Incorrect password' });
      if (room.joiner) return send(ws, { type: 'ERROR', message: 'Room is full' });
      if (room.host === ws) return send(ws, { type: 'ERROR', message: 'You are already in this room' });
      const name = String(msg.name || '').trim().slice(0, 32) || 'Player';
      room.joiner = ws;
      room.joinerName = name;
      send(ws, { type: 'ROOM_JOINED', roomCode: code, isHost: false, hostName: room.hostName });
      send(ws, { type: 'CHAT', system: true, text: `You joined room ${code}.` });
      send(room.host, { type: 'PEER_JOINED', name });
      send(room.host, { type: 'CHAT', system: true, text: `${name} joined.` });
      console.log(`Room ${code}: ${name} joined`);
    }

    else if (msg.type === 'CHAT') {
      const text = String(msg.text || '').trim().slice(0, 1000);
      if (!text) return;
      const room = getRoomFor(ws);
      if (!room) return;
      const senderName = room.host === ws ? room.hostName : room.joinerName;
      relay(ws, { type: 'CHAT', text, name: senderName });
    }

    else if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(msg.type)) {
      relay(ws, msg);
    }
  });

  ws.on('close', () => onDisconnect(ws));
  ws.on('error', () => onDisconnect(ws));
});

server.listen(PORT, () => console.log(`TabletopCamera running on port ${PORT}`));
