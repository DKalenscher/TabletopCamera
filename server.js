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

// rooms: code -> { password, players: [ws, ws?] }
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

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const send = (ws, msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const peer = (room, ws) => room?.players.find(p => p !== ws);

wss.on('connection', ws => {
  ws.roomCode = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'CREATE_ROOM') {
      const password = String(msg.password || '');
      if (!password) return send(ws, { type: 'ERROR', message: 'Password required' });
      const code = genCode();
      rooms.set(code, { password, players: [ws] });
      ws.roomCode = code;
      send(ws, { type: 'ROOM_CREATED', roomCode: code });
      console.log(`Room ${code} created`);
    }

    else if (msg.type === 'JOIN_ROOM') {
      const code = String(msg.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'ERROR', message: 'Room not found' });
      if (room.password !== String(msg.password || '')) return send(ws, { type: 'ERROR', message: 'Incorrect password' });
      if (room.players.length >= 2) return send(ws, { type: 'ERROR', message: 'Room is full' });
      room.players.push(ws);
      ws.roomCode = code;
      send(ws, { type: 'JOIN_SUCCESS' });
      send(room.players[0], { type: 'PEER_JOINED' });
      console.log(`Room ${code} is now full — signaling WebRTC`);
    }

    else if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(msg.type)) {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const p = peer(room, ws);
      if (p) send(p, msg);
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = peer(room, ws);
    if (p) send(p, { type: 'PEER_DISCONNECTED' });
    rooms.delete(ws.roomCode);
    console.log(`Room ${ws.roomCode} closed`);
  });
});

server.listen(PORT, () => console.log(`TabletopCamera running on port ${PORT}`));
