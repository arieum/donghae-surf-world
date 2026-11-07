'use strict';
/*
 * 동해 서프 월드 실시간 서버
 * - 정적 파일(public/)과 three.js를 제공합니다.
 * - /ws 경로의 WebSocket으로 해변별 방(채널)을 운영합니다.
 * - 파도는 서버가 생성 시각과 크기만 정하고, 위치는 각 클라이언트가 같은 공식으로 계산합니다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_PER_CHANNEL = Number(process.env.MAX_PER_CHANNEL) || 40;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 6;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const THREE_PATH = require.resolve('three/build/three.min.js');

// 클라이언트의 SPOTS 값과 반드시 같아야 합니다(amp, period, peel, peelVar).
const SPOTS = {
  sokcho:    { amp: 1.8, period: 12, peel: 4.8, peelVar: 0.25 },
  yangyang:  { amp: 1.9, period: 11, peel: 5.2, peelVar: 0.30 },
  gangneung: { amp: 2.1, period: 11, peel: 5.8, peelVar: 0.35 },
  pohang:    { amp: 2.4, period: 10, peel: 6.6, peelVar: 0.45 },
  busan:     { amp: 2.0, period: 11, peel: 5.5, peelVar: 0.30 },
};
const Z_BREAK = 22;
const LINEUP_Z = 19;
const waveSpeed = z => 0.75 + 0.04 * z + (z > 30 ? 0.12 * (z - 30) : 0);

function waveZ(age) {
  let z = 78;
  if (age <= 0) return z;
  const st = 1 / 30, n = Math.floor(age / st), rem = age - n * st;
  for (let i = 0; i < n; i++) z -= waveSpeed(z) * st;
  z -= waveSpeed(z) * rem;
  return z;
}

/* ---------- 채팅 필터 ---------- */
// 기본적인 욕설만 가립니다. 실제 서비스에서는 신고, 차단, 금칙어 관리 기능을 추가하는 것이 좋습니다.
const BAD_WORDS = ['씨발', '시발', '씨팔', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '존나', 'ㅈㄴ', '개새끼', '새끼', '꺼져', '닥쳐', 'fuck', 'shit', 'bitch'];
function cleanText(t, max) {
  if (typeof t !== 'string') return '';
  let s = t.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  for (const w of BAD_WORDS) {
    if (!w) continue;
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, '*'.repeat(w.length));
  }
  return s;
}
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const r2 = v => Math.round(v * 100) / 100;

/* ---------- 방 관리 ---------- */
const rooms = new Map();
const clients = new Set();
let nextId = 1;

function counts() {
  const c = {};
  for (const k in SPOTS) c[k] = 0;
  for (const r of rooms.values()) c[r.spot] += r.players.size;
  return c;
}
function createRoom(spot, ch) {
  const r = { key: spot + ':' + ch, spot, ch, players: new Map(), waves: [], wid: 0, next: Date.now() + 2500 };
  const now = Date.now();
  [26, 14, 3].forEach(a => spawnWave(r, now - a * 1000));
  updateRoomWaves(r, now, false);
  rooms.set(r.key, r);
  return r;
}
function pickRoom(spot) {
  for (let ch = 1; ch < 1000; ch++) {
    const r = rooms.get(spot + ':' + ch);
    if (!r) return createRoom(spot, ch);
    if (r.players.size < MAX_PER_CHANNEL) return r;
  }
  return null;
}
function spawnWave(r, t0) {
  const cfg = SPOTS[r.spot];
  const w = { id: ++r.wid, t0, A: r2(cfg.amp * (0.88 + Math.random() * 0.24)), seed: Math.round(Math.random() * 10000) / 1000, peak: null, locked: false, z: 78 };
  r.waves.push(w);
  return w;
}
const pubWave = w => ({ id: w.id, t0: w.t0, A: w.A, seed: w.seed, peak: w.peak, locked: w.locked });
function choosePeak(r) {
  const cand = [];
  for (const p of r.players.values()) if (p.s && p.s.m === 1 && p.s.z > LINEUP_Z - 4) cand.push(p.s);
  if (cand.length) {
    const s = cand[Math.floor(Math.random() * cand.length)];
    const dir = s.x > 0 ? -1 : 1;
    return r2(Math.max(-80, Math.min(80, s.x - dir * 5)));
  }
  return r2((Math.random() - 0.5) * 80);
}
function updateRoomWaves(r, now, announce) {
  const cfg = SPOTS[r.spot];
  if (now >= r.next) {
    const w = spawnWave(r, now);
    if (announce) broadcast(r, { t: 'wave', w: pubWave(w) });
    r.next = now + cfg.period * 1000 * (0.8 + Math.random() * 0.4);
  }
  for (let i = r.waves.length - 1; i >= 0; i--) {
    const w = r.waves[i];
    w.z = waveZ((now - w.t0) / 1000);
    if (w.peak === null && w.z < 44) {
      w.peak = choosePeak(r);
      if (announce) broadcast(r, { t: 'peak', id: w.id, peak: w.peak, locked: false });
    }
    if (w.z < -2) r.waves.splice(i, 1);
  }
}
function broadcast(r, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of r.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(data);
}
function sendTo(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
const snapOf = p => (p.s ? [p.id, p.s.x, p.s.z, p.s.yaw, p.s.m, p.s.fl, p.s.rd, p.s.rf, p.s.rl, p.s.rc] : null);
const pubPlayer = p => ({ id: p.id, name: p.name, look: p.look, s: snapOf(p) });

function leaveRoom(p) {
  const r = p.room;
  if (!r) return;
  r.players.delete(p.id);
  p.room = null;
  p.s = null;
  broadcast(r, { t: 'pleave', id: p.id });
  if (r.players.size === 0) rooms.delete(r.key);
}

/* ---------- 메시지 처리 ---------- */
function handle(p, m) {
  if (!m || typeof m.t !== 'string') return;
  const now = Date.now();
  switch (m.t) {
    case 'join': {
      if (!SPOTS[m.spot]) return;
      leaveRoom(p);
      p.name = cleanText(m.name, 12) || '이름 없는 서퍼';
      p.look = Math.floor(num(m.look, 0, 23, 0));
      const r = pickRoom(m.spot);
      if (!r) return sendTo(p, { t: 'notice', text: '지금은 이 바다에 들어갈 수 없습니다. 잠시 후 다시 시도해 주세요.' });
      const others = [...r.players.values()].map(pubPlayer);
      r.players.set(p.id, p);
      p.room = r;
      sendTo(p, { t: 'joined', now, spot: r.spot, ch: r.ch, players: others, waves: r.waves.map(pubWave) });
      broadcast(r, { t: 'pjoin', p: pubPlayer(p) }, p);
      break;
    }
    case 'leave':
      leaveRoom(p);
      break;
    case 's': {
      if (!p.room) return;
      if (now - p.stateWin > 1000) { p.stateWin = now; p.stateN = 0; }
      if (++p.stateN > 25) return;
      p.s = {
        x: r2(num(m.x, -90, 90)), z: r2(num(m.z, -30, 60)), yaw: r2(num(m.yaw, -100, 100)),
        m: Math.floor(num(m.m, 0, 4)), fl: Math.floor(num(m.fl, 0, 7)),
        rd: m.rd === -1 ? -1 : 1, rf: r2(num(m.rf, 0, 1, 0.5)), rl: r2(num(m.rl, -1, 1)), rc: r2(num(m.rc, 0, 1, 0.3)),
      };
      break;
    }
    case 'chat': {
      if (!p.room) return;
      p.chatT = p.chatT.filter(t => now - t < 10000);
      if (p.chatT.length >= 5 || now - (p.chatT[p.chatT.length - 1] || 0) < 700) {
        return sendTo(p, { t: 'notice', text: '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 보내 주세요.' });
      }
      const text = cleanText(m.text, 120);
      if (!text) return;
      p.chatT.push(now);
      broadcast(p.room, { t: 'chat', id: p.id, name: p.name, text });
      break;
    }
    case 'emote':
      if (!p.room || now - p.emoteT < 1000) return;
      p.emoteT = now;
      broadcast(p.room, { t: 'emote', id: p.id, k: 'wave' }, p);
      break;
    case 'claim': {
      if (!p.room) return;
      const w = p.room.waves.find(x => x.id === m.id);
      if (!w) return;
      if (!w.locked && w.z > Z_BREAK + 0.3) {
        w.peak = r2(num(m.peak, -80, 80));
        w.locked = true;
        broadcast(p.room, { t: 'peak', id: w.id, peak: w.peak, locked: true });
      } else {
        sendTo(p, { t: 'peak', id: w.id, peak: w.peak, locked: w.locked });
      }
      break;
    }
    case 'ride': {
      if (!p.room || now - p.rideT < 3000) return;
      p.rideT = now;
      const d = Math.round(num(m.d, 0, 1000));
      if (d >= 30) broadcast(p.room, { t: 'ride', id: p.id, name: p.name, d });
      break;
    }
  }
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('찾을 수 없는 페이지입니다.'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); return res.end(); }
  if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (pathname === '/api/rooms') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(counts())); }
  if (pathname === '/three.min.js') return serveFile(res, THREE_PATH, 'public, max-age=604800');
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  serveFile(res, file, pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600');
});

/* ---------- WebSocket ---------- */
const ipCount = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  const n = (ipCount.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.close(1008, 'too many connections'); return; }
  ipCount.set(ip, n);
  const p = { id: nextId++, ws, ip, name: '', look: 0, room: null, s: null, chatT: [], emoteT: 0, rideT: 0, stateN: 0, stateWin: Date.now() };
  clients.add(p);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  sendTo(p, { t: 'welcome', id: p.id, now: Date.now(), counts: counts() });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    try { handle(p, m); } catch (e) { console.error('handle error', e); }
  });
  ws.on('close', () => {
    leaveRoom(p);
    clients.delete(p);
    const c = (ipCount.get(ip) || 1) - 1;
    if (c <= 0) ipCount.delete(ip); else ipCount.set(ip, c);
  });
  ws.on('error', () => {});
});

// 파도 갱신과 위치 묶음 전송: 0.1초마다
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    updateRoomWaves(r, now, true);
    const p = [];
    for (const pl of r.players.values()) { const s = snapOf(pl); if (s) p.push(s); }
    broadcast(r, { t: 'snap', n: r.players.size, p });
  }
}, 100);
// 로비 인원수: 5초마다
setInterval(() => {
  const data = JSON.stringify({ t: 'counts', counts: counts() });
  for (const p of clients) if (p.ws.readyState === 1) p.ws.send(data);
}, 5000);
// 끊긴 연결 정리: 25초마다
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* 무시 */ }
  }
}, 25000);

server.listen(PORT, () => console.log(`동해 서프 월드 서버가 ${PORT}번 포트에서 실행 중입니다.`));
