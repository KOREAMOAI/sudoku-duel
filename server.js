'use strict';
// 스도쿠 듀얼 서버 — 외부 패키지 없이 Node.js만으로 동작합니다.
// 실행: node server.js  (기본 포트 3000, PORT 환경변수로 변경)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const RANK_FILE = path.join(DATA_DIR, 'rankings.json');
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
const FREEZE_MS = 3000;
const COUNTDOWN_MS = 3500;
const DISCONNECT_FORFEIT_MS = 20000;
const BONUS = 3;
const LIVES = 3;
const GIVENS = { easy: 40, normal: 32, hard: 26 };

/* ---------- 통계/랭킹 ---------- */
const DIFFS = ['easy', 'normal', 'hard'];
let stats = {};
try { stats = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch {}
for (const [n, r] of Object.entries(stats)) {
  if (r && r.wins !== undefined && !r.race) stats[n] = { race: { wins: r.wins, losses: r.losses } };
}
function saveRanks() { fs.writeFile(RANK_FILE, JSON.stringify(stats), () => {}); }
function st(nick) {
  const u = stats[nick] || (stats[nick] = {});
  u.race = u.race || { wins: 0, losses: 0 };
  u.territory = u.territory || { wins: 0, losses: 0 };
  u.solo = u.solo || {};
  for (const d of DIFFS) u.solo[d] = u.solo[d] || { done: 0, over: 0, bestTime: 0, bestScore: 0, totalTime: 0 };
  return u;
}
function bump(nick, mode, key) { st(nick)[mode === 'territory' ? 'territory' : 'race'][key]++; }
function rankingList(mode, diff, by) {
  const rows = [];
  for (const nick of Object.keys(stats)) {
    const u = st(nick);
    if (mode === 'solo') {
      const s = u.solo[DIFFS.includes(diff) ? diff : 'normal'];
      if (by === 'score') { if (s.bestScore > 0) rows.push({ nick, value: s.bestScore, done: s.done }); }
      else if (s.bestTime > 0) rows.push({ nick, value: s.bestTime, done: s.done });
    } else {
      const r = u[mode === 'territory' ? 'territory' : 'race'];
      if (r.wins + r.losses > 0) rows.push({ nick, wins: r.wins, losses: r.losses });
    }
  }
  if (mode === 'solo') rows.sort((a, b) => (by === 'score' ? b.value - a.value : a.value - b.value) || a.nick.localeCompare(b.nick));
  else rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.nick.localeCompare(b.nick));
  return rows.slice(0, 20);
}

/* ---------- 계정 ---------- */
let accounts = { users: {}, sessions: {} };
try {
  accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'));
  accounts.users = accounts.users || {}; accounts.sessions = accounts.sessions || {};
} catch {}
let accTimer = null;
function saveAcc() {
  clearTimeout(accTimer);
  accTimer = setTimeout(() => fs.writeFile(ACC_FILE, JSON.stringify(accounts), () => {}), 200);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const NICK_RE = /^[0-9A-Za-z\uAC00-\uD7A3_-]{2,12}$/;
const SESSION_MS = 90 * 24 * 3600 * 1000;
const fails = new Map();
function newSession(nick) {
  const tok = crypto.randomBytes(24).toString('hex');
  accounts.sessions[sha(tok)] = { nick, at: Date.now() };
  saveAcc();
  return tok;
}
function nickFromToken(tok) {
  if (!tok) return null;
  const k = sha(String(tok)), ses = accounts.sessions[k];
  if (!ses) return null;
  if (Date.now() - ses.at > SESSION_MS) { delete accounts.sessions[k]; saveAcc(); return null; }
  const u = accounts.users[ses.nick.toLowerCase()];
  return u ? u.nick : null;
}
function signup(nick, pw) {
  nick = String(nick || '').trim(); pw = String(pw || '');
  if (!NICK_RE.test(nick)) throw new Error('닉네임은 2~12자의 한글/영문/숫자/_/- 만 쓸 수 있어요');
  if (pw.length < 4 || pw.length > 64) throw new Error('비밀번호는 4자 이상으로 입력해 주세요');
  const key = nick.toLowerCase();
  if (accounts.users[key]) throw new Error('이미 사용 중인 닉네임이에요');
  const salt = crypto.randomBytes(16).toString('hex');
  accounts.users[key] = { nick, salt, hash: hashPw(pw, salt), created: Date.now() };
  return { token: newSession(nick), nick };
}
function login(nick, pw) {
  nick = String(nick || '').trim(); pw = String(pw || '');
  const key = nick.toLowerCase(), f = fails.get(key) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new Error('시도가 너무 많아요. 잠시 후 다시 해 주세요');
  const u = accounts.users[key];
  let okPw = false;
  if (u) {
    const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
    okPw = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!okPw) {
    f.n++; if (f.n >= 8) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
    fails.set(key, f);
    throw new Error('닉네임 또는 비밀번호가 맞지 않아요');
  }
  fails.delete(key);
  return { token: newSession(u.nick), nick: u.nick };
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
  room.total = puzzle.filter((v) => !v).length;
  for (const p of room.players) {
    Object.assign(p, {
      lives: LIVES, score: 0, cells: 0, itemUsed: false, frozenUntil: 0, rematch: false, cursor: -1,
      hints: 0, grid: puzzle.slice(), wrong: new Array(81).fill(false),
    });
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
    if (w && l) { bump(w.nick, room.mode, 'wins'); bump(l.nick, room.mode, 'losses'); saveRanks(); }
  }
  room.players.forEach((p) => (p.rematch = false));
  broadcast(room);
}

function view(room, me) {
  const now = Date.now();
  const playing = room.puzzle && room.status !== 'waiting';
  const race = room.mode === 'race';
  let values = new Array(81).fill(0), wrong = null;
  if (playing && race) {
    values = me.grid.slice();
    wrong = me.wrong.map((x) => (x ? 1 : 0));
  } else if (playing) {
    for (let i = 0; i < 81; i++) if (room.puzzle[i] || room.owner[i]) values[i] = room.solution[i];
  }
  return {
    code: room.code, status: room.status, difficulty: room.difficulty, mode: room.mode, total: room.total || 0,
    now, startsAt: room.startsAt || 0, startedAt: room.startedAt || 0, endedAt: room.endedAt || 0,
    you: me.idx,
    players: room.players.map((p) => ({
      idx: p.idx, nick: p.nick, lives: p.lives, score: race ? p.cells : p.score, cells: p.cells, hints: p.hints || 0,
      itemUsed: p.itemUsed, frozenUntil: p.frozenUntil > now ? p.frozenUntil : 0,
      connected: p.connected, rematch: p.rematch, cursor: race || p.idx === me.idx ? -1 : p.cursor,
    })),
    puzzle: playing ? room.puzzle : null,
    owner: playing && !race ? room.owner : null,
    values: playing ? values : null,
    wrong: playing ? wrong : null,
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

/* ---------- 레이스 모드 규칙 ---------- */
function raceCheck(room, p) {
  if (p.cells >= room.total) finish(room, p.idx, 'complete');
}
function raceActive(room, p) {
  if (room.mode !== 'race') throw new Error('레이스 모드가 아니에요');
  if (room.status !== 'playing') throw new Error('지금은 입력할 수 없어요');
}
function raceMove(room, p, i, v) {
  raceActive(room, p);
  if (!Number.isInteger(i) || i < 0 || i > 80 || !Number.isInteger(v) || v < 1 || v > 9) throw new Error('잘못된 입력');
  if (room.puzzle[i]) throw new Error('처음부터 주어진 칸이에요');
  if (p.grid[i] && !p.wrong[i]) throw new Error('이미 맞힌 칸이에요');
  if (p.wrong[i] && p.grid[i] === v) return { correct: false, same: true };
  const opp = room.players.find((x) => x !== p);
  if (room.solution[i] === v) {
    p.grid[i] = v; p.wrong[i] = false; p.cells++;
    if (p.cells >= room.total) { finish(room, p.idx, 'complete'); return { correct: true }; }
    broadcast(room);
    return { correct: true };
  }
  p.grid[i] = v; p.wrong[i] = true; p.lives--;
  if (p.lives <= 0) { finish(room, opp.idx, 'lives'); return { correct: false }; }
  broadcast(room);
  return { correct: false };
}
function raceErase(room, p, i) {
  raceActive(room, p);
  if (!Number.isInteger(i) || i < 0 || i > 80 || !p.wrong[i]) throw new Error('지울 수 있는 칸이 아니에요');
  p.grid[i] = 0; p.wrong[i] = false;
  broadcast(room);
  return { ok: true };
}
function raceHint(room, p, i) {
  raceActive(room, p);
  if (p.hints >= 3) throw new Error('힌트를 모두 사용했어요');
  const open = (k) => !room.puzzle[k] && (!p.grid[k] || p.wrong[k]);
  if (!(Number.isInteger(i) && i >= 0 && i < 81 && open(i))) {
    const list = [...Array(81).keys()].filter(open);
    if (!list.length) throw new Error('힌트를 줄 칸이 없어요');
    i = list[crypto.randomInt(list.length)];
  }
  p.grid[i] = room.solution[i]; p.wrong[i] = false; p.cells++; p.hints++;
  if (p.cells >= room.total) { finish(room, p.idx, 'complete'); return { i, v: p.grid[i] }; }
  broadcast(room);
  return { i, v: p.grid[i] };
}

/* ---------- 솔로 모드 ---------- */
const solos = new Map();
const SOLO_CFG = { easy: { base: 1000, par: 480, k: 2 }, normal: { base: 2000, par: 720, k: 3 }, hard: { base: 3000, par: 1080, k: 4 } };
function soloScore(g, sec) {
  const c = SOLO_CFG[g.difficulty];
  return Math.max(0, c.base + Math.max(0, c.par - sec) * c.k - g.hints * 150 - g.mistakes * 200);
}
function soloStart(nick, difficulty) {
  const d = GIVENS[difficulty] ? difficulty : 'normal';
  const { solution, puzzle } = generate(d);
  const g = {
    nick, difficulty: d, solution, puzzle, grid: puzzle.slice(), wrong: new Array(81).fill(false),
    mistakes: 0, hints: 0, cells: 0, total: puzzle.filter((v) => !v).length,
    status: 'playing', startedAt: Date.now(), endedAt: 0, result: null, updated: Date.now(),
  };
  solos.set(nick, g);
  return g;
}
function soloView(g) {
  const fin = g.status === 'finished';
  return {
    mode: 'solo', status: g.status, difficulty: g.difficulty, total: g.total,
    startedAt: g.startedAt, endedAt: g.endedAt, now: Date.now(), startsAt: 0, you: 1, code: '',
    players: [{ idx: 1, nick: g.nick, lives: LIVES - g.mistakes, score: g.cells, cells: g.cells, hints: g.hints,
      itemUsed: false, frozenUntil: 0, connected: true, rematch: false, cursor: -1 }],
    puzzle: g.puzzle, owner: null, values: g.grid.slice(), wrong: g.wrong.map((x) => (x ? 1 : 0)),
    winner: fin ? (g.result.won ? 1 : 2) : null, reason: fin ? (g.result.won ? 'complete' : 'lives') : '',
    result: g.result, last: { seq: 0 },
  };
}
function soloFinish(g, won) {
  g.status = 'finished';
  g.endedAt = Date.now();
  const time = g.endedAt - g.startedAt, sec = Math.floor(time / 1000);
  const s = st(g.nick).solo[g.difficulty];
  const r = { won, time, mistakes: g.mistakes, hints: g.hints, score: 0, newBestTime: false, newBestScore: false, hinted: g.hints > 0 };
  if (won) {
    r.score = soloScore(g, sec);
    s.done++; s.totalTime += time;
    if (!g.hints && (!s.bestTime || time < s.bestTime)) { s.bestTime = time; r.newBestTime = true; }
    if (r.score > s.bestScore) { s.bestScore = r.score; r.newBestScore = true; }
  } else s.over++;
  g.result = r;
  saveRanks();
}
function soloActive(g) {
  if (g.status !== 'playing') throw new Error('이미 끝난 게임이에요');
  g.updated = Date.now();
}
function soloMove(g, i, v) {
  soloActive(g);
  if (!Number.isInteger(i) || i < 0 || i > 80 || !Number.isInteger(v) || v < 1 || v > 9) throw new Error('잘못된 입력');
  if (g.puzzle[i]) throw new Error('처음부터 주어진 칸이에요');
  if (g.grid[i] && !g.wrong[i]) throw new Error('이미 맞힌 칸이에요');
  if (g.wrong[i] && g.grid[i] === v) return { correct: false, same: true, state: soloView(g) };
  if (g.solution[i] === v) {
    g.grid[i] = v; g.wrong[i] = false; g.cells++;
    if (g.cells >= g.total) soloFinish(g, true);
    return { correct: true, state: soloView(g) };
  }
  g.grid[i] = v; g.wrong[i] = true; g.mistakes++;
  if (g.mistakes >= LIVES) soloFinish(g, false);
  return { correct: false, state: soloView(g) };
}
function soloErase(g, i) {
  soloActive(g);
  if (!Number.isInteger(i) || i < 0 || i > 80 || !g.wrong[i]) throw new Error('지울 수 있는 칸이 아니에요');
  g.grid[i] = 0; g.wrong[i] = false;
  return { ok: true, state: soloView(g) };
}
function soloHint(g, i) {
  soloActive(g);
  if (g.hints >= 3) throw new Error('힌트를 모두 사용했어요');
  const open = (k) => !g.puzzle[k] && (!g.grid[k] || g.wrong[k]);
  if (!(Number.isInteger(i) && i >= 0 && i < 81 && open(i))) {
    const list = [...Array(81).keys()].filter(open);
    if (!list.length) throw new Error('힌트를 줄 칸이 없어요');
    i = list[crypto.randomInt(list.length)];
  }
  g.grid[i] = g.solution[i]; g.wrong[i] = false; g.cells++; g.hints++;
  if (g.cells >= g.total) soloFinish(g, true);
  return { i, v: g.solution[i], state: soloView(g) };
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
    if (req.method === 'GET' && url.pathname === '/api/ranking') {
      return json(res, 200, rankingList(url.searchParams.get('mode') || 'race', url.searchParams.get('diff') || 'normal', url.searchParams.get('by') || 'time'));
    }

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

      if (action === 'signup' || action === 'login') {
        try { return json(res, 200, (action === 'signup' ? signup : login)(body.nick, body.pw)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'me') {
        const nick = nickFromToken(body.token);
        return nick ? json(res, 200, { nick }) : json(res, 401, { error: '로그인이 필요해요' });
      }
      if (action === 'logout') {
        if (body.token) { delete accounts.sessions[sha(String(body.token))]; saveAcc(); }
        return json(res, 200, { ok: true });
      }
      const authNick = nickFromToken(body.token);
      if (['create', 'join', 'match'].includes(action) && !authNick) return json(res, 401, { error: '로그인이 필요해요' });

      if (action === 'mystats') {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        return json(res, 200, st(authNick));
      }
      if (action.startsWith('solo/')) {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        try {
          const a = action.slice(5);
          if (a === 'start') return json(res, 200, { state: soloView(soloStart(authNick, body.difficulty)) });
          if (a === 'leave') { solos.delete(authNick); return json(res, 200, { ok: true }); }
          const g = solos.get(authNick);
          if (!g) throw new Error('진행 중인 솔로 게임이 없어요');
          if (a === 'state') return json(res, 200, { state: soloView(g) });
          if (a === 'move') return json(res, 200, soloMove(g, body.i, body.v));
          if (a === 'erase') return json(res, 200, soloErase(g, body.i));
          if (a === 'hint') return json(res, 200, soloHint(g, body.i));
          return json(res, 404, { error: 'unknown' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }

      if (action === 'create') {
        const nick = authNick;
        const mode = body.mode === 'territory' ? 'territory' : 'race';
        const difficulty = GIVENS[body.difficulty] ? body.difficulty : 'normal';
        const code = makeCode();
        const p = newPlayer(1, nick);
        rooms.set(code, { code, difficulty, mode, players: [p], status: 'waiting', updated: Date.now(), last: { seq: 0 } });
        return json(res, 200, { code, pid: p.id });
      }
      if (action === 'join') {
        const room = rooms.get(String(body.code || '').toUpperCase().trim());
        const nick = authNick;
        if (!room) return json(res, 404, { error: '해당 코드의 방이 없어요' });
        if (room.players.length >= 2) return json(res, 400, { error: '이미 두 명이 있는 방이에요' });
        if (room.players[0].nick === nick) return json(res, 400, { error: '상대와 같은 닉네임이에요. 바꿔 주세요' });
        const p = newPlayer(2, nick);
        room.players.push(p);
        startGame(room);
        return json(res, 200, { code: room.code, pid: p.id });
      }

      if (action === 'match') {
        const nick = authNick;
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
        rooms.set(code, { code, difficulty: 'normal', mode: 'race', isPublic: true, players: [p], status: 'waiting', updated: t, last: { seq: 0 } });
        return json(res, 200, { code, pid: p.id, matched: false });
      }

      const { room, p } = lookup(body.code, body.pid);
      if (!room || !p) return json(res, 404, { error: '방을 찾을 수 없어요' });

      if (action === 'move') {
        try { return json(res, 200, room.mode === 'race' ? raceMove(room, p, body.i, body.v) : doMove(room, p, body.i, body.v)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'erase') {
        try { return json(res, 200, raceErase(room, p, body.i)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'hint') {
        try { return json(res, 200, raceHint(room, p, body.i)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'cursor') {
        if (room.mode === 'race') return json(res, 200, { ok: true });
        const i = body.i;
        p.cursor = Number.isInteger(i) && i >= 0 && i < 81 ? i : -1;
        const opp = room.players.find((x) => x !== p);
        if (opp) send(opp, view(room, opp));
        return json(res, 200, { ok: true });
      }
      if (action === 'item') {
        if (room.status !== 'playing' || room.mode === 'race') return json(res, 400, { error: '지금은 쓸 수 없어요' });
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
  for (const [n, g] of solos) if (now - g.updated > 3 * 3600 * 1000) solos.delete(n);
}, 5000);

server.listen(PORT, '0.0.0.0', () => console.log('스도쿠 듀얼 서버 실행 중: http://localhost:' + PORT));
