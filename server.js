'use strict';
// 스도쿠 듀얼 서버 — 외부 패키지 없이 Node.js만으로 동작합니다.
// 실행: node server.js  (기본 포트 3000, PORT 환경변수로 변경)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const RANK_FILE = path.join(process.env.DATA_DIR || __dirname, 'rankings.json');
const FREEZE_MS = 3000;
const COUNTDOWN_MS = 3500;
const DISCONNECT_FORFEIT_MS = 20000;
const BONUS = 3;
const LIVES = 3;
const GIVENS = { easy: 40, normal: 32, hard: 26 };

/* ---------- 랭킹 ---------- */
let ranks = {};
try { ranks = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch {}
function saveRanks() { fs.writeFile(RANK_FILE, JSON.stringify(ranks), () => {}); }
function bump(nick, key) {
  if (!ranks[nick]) ranks[nick] = { wins: 0, losses: 0 };
  ranks[nick][key]++;
}
function rankingList() {
  return Object.entries(ranks)
    .map(([nick, r]) => ({ nick, wins: r.wins, losses: r.losses }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.nick.localeCompare(b.nick))
    .slice(0, 20);
}

/* ---------- 스도쿠 생성 ---------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function canPlace(g, i, v) {
  const r = Math.floor(i / 9), c = i % 9;
  for (let k = 0; k < 9; k++) if (g[r * 9 + k] === v || g[k * 9 + c] === v) return false;
  const br = r - (r % 3), bc = c - (c % 3);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (g[(br + a) * 9 + bc + b] === v) return false;
  return true;
}
function fillGrid(g) {
  const i = g.indexOf(0);
  if (i < 0) return true;
  for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    if (canPlace(g, i, v)) {
      g[i] = v;
      if (fillGrid(g)) return true;
      g[i] = 0;
    }
  }
  return false;
}
function countSolutions(g, limit) {
  let best = -1, bestC = null;
  for (let i = 0; i < 81; i++) {
    if (g[i] !== 0) continue;
    const c = [];
    for (let v = 1; v <= 9; v++) if (canPlace(g, i, v)) c.push(v);
    if (c.length === 0) return 0;
    if (!bestC || c.length < bestC.length) { best = i; bestC = c; if (c.length === 1) break; }
  }
  if (best < 0) return 1;
  let n = 0;
  for (const v of bestC) {
    g[best] = v;
    n += countSolutions(g, limit - n);
    g[best] = 0;
    if (n >= limit) break;
  }
  return n;
}
function generate(difficulty) {
  const solution = new Array(81).fill(0);
  fillGrid(solution);
  const puzzle = solution.slice();
  let givens = 81;
  const target = GIVENS[difficulty] || GIVENS.normal;
  for (const idx of shuffle([...Array(81).keys()])) {
    if (givens <= target) break;
    const v = puzzle[idx];
    puzzle[idx] = 0;
    if (countSolutions(puzzle.slice(), 2) !== 1) puzzle[idx] = v;
    else givens--;
  }
  return { solution, puzzle };
}

/* ---------- 방 ---------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanNick(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
}
function newPlayer(idx, nick) {
  return {
    id: crypto.randomBytes(16).toString('hex'), idx, nick, res: null,
    connected: false, lastSeen: Date.now(), left: false,
    lives: LIVES, score: 0, cells: 0, itemUsed: false, frozenUntil: 0, rematch: false, cursor: -1,
  };
}
function unitsOf(i) {
  const r = Math.floor(i / 9), c = i % 9, b = Math.floor(r / 3) * 3 + Math.floor(c / 3);
  return [['r' + r, '행'], ['c' + c, '열'], ['b' + b, '블록']];
}
function unitCells(key) {
  const t = key[0], k = +key.slice(1), out = [];
  if (t === 'r') for (let c = 0; c < 9; c++) out.push(k * 9 + c);
  else if (t === 'c') for (let r = 0; r < 9; r++) out.push(r * 9 + k);
  else {
    const br = Math.floor(k / 3) * 3, bc = (k % 3) * 3;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) out.push((br + a) * 9 + bc + b);
  }
  return out;
}

function startGame(room) {
  const { solution, puzzle } = generate(room.difficulty);
  room.solution = solution;
  room.puzzle = puzzle;
  room.owner = new Array(81).fill(0);
  room.claimed = new Set();
  room.winner = null;
  room.reason = '';
  room.status = 'countdown';
  room.startsAt = Date.now() + COUNTDOWN_MS;
  room.startedAt = room.startsAt;
  room.endedAt = 0;
  room.last = { seq: 0 };
  room.gameId = (room.gameId || 0) + 1;
  for (const p of room.players) {
    Object.assign(p, { lives: LIVES, score: 0, cells: 0, itemUsed: false, frozenUntil: 0, rematch: false, cursor: -1 });
  }
  const gid = room.gameId;
  setTimeout(() => {
    if (room.gameId === gid && room.status === 'countdown') {
      room.status = 'playing';
      broadcast(room);
    }
  }, COUNTDOWN_MS);
  broadcast(room);
}

function finish(room, winner, reason) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  room.winner = winner;
  room.reason = reason;
  room.endedAt = Date.now();
  if (winner) {
    const w = room.players.find((p) => p.idx === winner);
    const l = room.players.find((p) => p.idx !== winner);
    if (w && l) { bump(w.nick, 'wins'); bump(l.nick, 'losses'); saveRanks(); }
  }
  room.players.forEach((p) => (p.rematch = false));
  broadcast(room);
}

function view(room, me) {
  const now = Date.now();
  const playing = room.puzzle && room.status !== 'waiting';
  const values = new Array(81).fill(0);
  if (playing) {
    for (let i = 0; i < 81; i++) if (room.puzzle[i] || room.owner[i]) values[i] = room.solution[i];
  }
  return {
    code: room.code, status: room.status, difficulty: room.difficulty,
    now, startsAt: room.startsAt || 0, startedAt: room.startedAt || 0, endedAt: room.endedAt || 0,
    you: me.idx,
    players: room.players.map((p) => ({
      idx: p.idx, nick: p.nick, lives: p.lives, score: p.score, cells: p.cells,
      itemUsed: p.itemUsed, frozenUntil: p.frozenUntil > now ? p.frozenUntil : 0,
      connected: p.connected, rematch: p.rematch, cursor: p.idx === me.idx ? -1 : p.cursor,
    })),
    puzzle: playing ? room.puzzle : null,
    owner: playing ? room.owner : null,
    values: playing ? values : null,
    winner: room.winner, reason: room.reason, last: room.last,
  };
}
function send(p, data) {
  if (p.res && !p.res.writableEnded) {
    try { p.res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch {}
  }
}
function broadcast(room) {
  room.updated = Date.now();
  for (const p of room.players) send(p, view(room, p));
}

/* ---------- 게임 규칙 ---------- */
function doMove(room, p, i, v) {
  if (room.status !== 'playing') throw new Error('지금은 입력할 수 없어요');
  if (p.frozenUntil > Date.now()) throw new Error('얼어붙었어요!');
  if (!Number.isInteger(i) || i < 0 || i > 80 || !Number.isInteger(v) || v < 1 || v > 9) throw new Error('잘못된 입력');
  if (room.puzzle[i] || room.owner[i]) throw new Error('이미 채워진 칸이에요');
  const opp = room.players.find((x) => x !== p);

  if (room.solution[i] === v) {
    room.owner[i] = p.idx;
    p.cells++;
    p.score++;
    const bonuses = [];
    for (const [key, label] of unitsOf(i)) {
      const ck = p.idx + key;
      if (room.claimed.has(ck)) continue;
      const empties = unitCells(key).filter((c) => !room.puzzle[c]);
      if (empties.length && empties.every((c) => room.owner[c] === p.idx)) {
        room.claimed.add(ck);
        p.score += BONUS;
        bonuses.push(label);
      }
    }
    room.last = { seq: (room.last.seq || 0) + 1, type: bonuses.length ? 'bonus' : 'capture', by: p.idx, cell: i, bonuses };
    const remaining = room.owner.some((o, k) => !room.puzzle[k] && !o);
    if (!remaining) {
      const [a, b] = room.players;
      const winner = a.score === b.score ? 0 : a.score > b.score ? a.idx : b.idx;
      finish(room, winner, 'board');
      return { correct: true };
    }
    broadcast(room);
    return { correct: true };
  }
  p.lives--;
  room.last = { seq: (room.last.seq || 0) + 1, type: 'wrong', by: p.idx, cell: i };
  if (p.lives <= 0) { finish(room, opp.idx, 'lives'); return { correct: false }; }
  broadcast(room);
  return { correct: false };
}

/* ---------- HTTP ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function lookup(code, pid) {
  const room = rooms.get(String(code || '').toUpperCase());
  const p = room && room.players.find((x) => x.id === pid);
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/ranking') return json(res, 200, rankingList());

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const { room, p } = lookup(url.searchParams.get('code'), url.searchParams.get('pid'));
      if (!room || !p) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      if (p.res && !p.res.writableEnded) { try { p.res.end(); } catch {} }
      p.res = res; p.connected = true; p.lastSeen = Date.now();
      res.write('retry: 1500\n\n');
      broadcast(room);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
      req.on('close', () => {
        clearInterval(ka);
        if (p.res === res) { p.connected = false; p.lastSeen = Date.now(); p.res = null; broadcast(room); }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const action = url.pathname.slice(5);

      if (action === 'create') {
        const nick = cleanNick(body.nick);
        if (!nick) return json(res, 400, { error: '닉네임을 입력해 주세요' });
        const difficulty = GIVENS[body.difficulty] ? body.difficulty : 'normal';
        const code = makeCode();
        const p = newPlayer(1, nick);
        rooms.set(code, { code, difficulty, players: [p], status: 'waiting', updated: Date.now(), last: { seq: 0 } });
        return json(res, 200, { code, pid: p.id });
      }
      if (action === 'join') {
        const room = rooms.get(String(body.code || '').toUpperCase().trim());
        const nick = cleanNick(body.nick);
        if (!nick) return json(res, 400, { error: '닉네임을 입력해 주세요' });
        if (!room) return json(res, 404, { error: '해당 코드의 방이 없어요' });
        if (room.players.length >= 2) return json(res, 400, { error: '이미 두 명이 있는 방이에요' });
        if (room.players[0].nick === nick) return json(res, 400, { error: '상대와 같은 닉네임이에요. 바꿔 주세요' });
        const p = newPlayer(2, nick);
        room.players.push(p);
        startGame(room);
        return json(res, 200, { code: room.code, pid: p.id });
      }

      if (action === 'match') {
        const nick = cleanNick(body.nick);
        if (!nick) return json(res, 400, { error: '닉네임을 입력해 주세요' });
        const t = Date.now();
        for (const room of rooms.values()) {
          const host = room.players[0];
          if (room.isPublic && room.status === 'waiting' && room.players.length === 1 && host.nick !== nick &&
              (host.connected || t - room.updated < 5000)) {
            const p = newPlayer(2, nick);
            room.players.push(p);
            startGame(room);
            return json(res, 200, { code: room.code, pid: p.id, matched: true });
          }
        }
        const code = makeCode();
        const p = newPlayer(1, nick);
        rooms.set(code, { code, difficulty: 'normal', isPublic: true, players: [p], status: 'waiting', updated: t, last: { seq: 0 } });
        return json(res, 200, { code, pid: p.id, matched: false });
      }

      const { room, p } = lookup(body.code, body.pid);
      if (!room || !p) return json(res, 404, { error: '방을 찾을 수 없어요' });

      if (action === 'move') {
        try { return json(res, 200, doMove(room, p, body.i, body.v)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'cursor') {
        const i = body.i;
        p.cursor = Number.isInteger(i) && i >= 0 && i < 81 ? i : -1;
        const opp = room.players.find((x) => x !== p);
        if (opp) send(opp, view(room, opp));
        return json(res, 200, { ok: true });
      }
      if (action === 'item') {
        if (room.status !== 'playing') return json(res, 400, { error: '지금은 쓸 수 없어요' });
        if (p.itemUsed) return json(res, 400, { error: '이미 사용했어요' });
        const opp = room.players.find((x) => x !== p);
        p.itemUsed = true;
        opp.frozenUntil = Date.now() + FREEZE_MS;
        room.last = { seq: (room.last.seq || 0) + 1, type: 'freeze', by: p.idx };
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      if (action === 'rematch') {
        if (room.status !== 'finished' || room.players.length < 2) return json(res, 400, { error: '재대결할 수 없어요' });
        const opp = room.players.find((x) => x !== p);
        if (!opp.connected || opp.left) return json(res, 400, { error: '상대가 나갔어요' });
        p.rematch = true;
        if (room.players.every((x) => x.rematch)) startGame(room); else broadcast(room);
        return json(res, 200, { ok: true });
      }
      if (action === 'leave') {
        p.left = true;
        const opp = room.players.find((x) => x !== p);
        if (room.status === 'playing' || room.status === 'countdown') finish(room, opp ? opp.idx : 0, 'left');
        if (room.status === 'waiting') rooms.delete(room.code);
        else broadcast(room);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'unknown' });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: '요청을 처리할 수 없어요' });
  }
});

/* 주기 작업: 연결 끊긴 대결 기권 처리, 오래된 방 정리 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === 'playing' || room.status === 'countdown') {
      const gone = room.players.find((p) => !p.connected && now - p.lastSeen > DISCONNECT_FORFEIT_MS);
      if (gone) finish(room, room.players.find((p) => p !== gone).idx, 'disconnect');
    }
    if (now - room.updated > 30 * 60 * 1000 && room.players.every((p) => !p.connected)) rooms.delete(code);
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => console.log('스도쿠 듀얼 서버 실행 중: http://localhost:' + PORT));
