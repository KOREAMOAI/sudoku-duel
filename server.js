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


/* ---------- 영구 저장소 (Upstash Redis REST) ----------
   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 있으면 계정·코인·랭킹을 DB에 저장하고,
   없으면 기존처럼 파일에만 저장합니다. */
const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DB_ON = !!(DB_URL && DB_TOKEN);
const K_ACC = 'sd:accounts', K_STATS = 'sd:stats', BACKUP_TTL = 14 * 86400;
const dirty = { acc: false, stats: false, backup: false };
const dbInfo = { on: DB_ON, lastOk: 0, lastErr: '', saves: 0, lastBackupDay: '' };
async function dbCmd(args) {
  const r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'DB HTTP ' + r.status);
  return j.result;
}
let remoteTimer = null, remoteChain = Promise.resolve(), remoteReady = !DB_ON;
function scheduleRemote(ms = 2000) {
  if (!DB_ON || !remoteReady || remoteTimer) return;
  remoteTimer = setTimeout(() => { remoteTimer = null; flushRemote(); }, ms);
}
function flushRemote() {
  remoteChain = remoteChain.then(async () => {
    if (!DB_ON || !remoteReady) return;
    try {
      if (dirty.acc) { dirty.acc = false; try { await dbCmd(['SET', K_ACC, JSON.stringify(accounts)]); } catch (e) { dirty.acc = true; throw e; } }
      if (dirty.stats) { dirty.stats = false; try { await dbCmd(['SET', K_STATS, JSON.stringify(stats)]); } catch (e) { dirty.stats = true; throw e; } }
      dbInfo.lastOk = Date.now(); dbInfo.lastErr = ''; dbInfo.saves++;
    } catch (e) {
      dbInfo.lastErr = String(e.message || e); console.error('[db] 저장 실패, 곧 재시도:', dbInfo.lastErr);
      scheduleRemote(10000);
    }
  });
  return remoteChain;
}
async function backupNow() {
  if (!DB_ON || !remoteReady) return;
  const day = kstDay();
  if (!dirty.backup && dbInfo.lastBackupDay === day) return;
  try {
    await dbCmd(['SET', 'sd:backup:accounts:' + day, JSON.stringify(accounts), 'EX', BACKUP_TTL]);
    await dbCmd(['SET', 'sd:backup:stats:' + day, JSON.stringify(stats), 'EX', BACKUP_TTL]);
    dirty.backup = false; dbInfo.lastBackupDay = day;
  } catch (e) { console.error('[db] 백업 실패:', e.message); }
}
async function initDb() {
  if (!DB_ON) { console.log('[db] 외부 DB 미설정 — 파일에만 저장합니다 (재배포하면 초기화될 수 있어요)'); return; }
  let accRaw, statsRaw, ok = false;
  for (let i = 1; i <= 6 && !ok; i++) {
    try { accRaw = await dbCmd(['GET', K_ACC]); statsRaw = await dbCmd(['GET', K_STATS]); ok = true; }
    catch (e) { console.error('[db] 불러오기 실패 (' + i + '/6):', e.message); await new Promise((r) => setTimeout(r, (+process.env.DB_RETRY_MS || 1500) * i)); }
  }
  // 읽기에 실패한 채로 빈 데이터로 시작하면 DB를 덮어써서 전부 날아가므로, 끝내 못 읽으면 시작하지 않는다
  if (!ok) { console.error('[db] DB에 연결할 수 없어 서버를 시작하지 않습니다 (데이터 보호)'); process.exit(1); }
  if (accRaw) { accounts = JSON.parse(accRaw); accounts.users = accounts.users || {}; accounts.sessions = accounts.sessions || {}; } else dirty.acc = true;
  if (statsRaw) { stats = JSON.parse(statsRaw); migrateStats(); } else dirty.stats = true;
  remoteReady = true;
  console.log('[db] 불러오기 완료 — 계정 ' + Object.keys(accounts.users).length + '명, 랭킹 ' + Object.keys(stats).length + '명');
  if (dirty.acc || dirty.stats) { dirty.backup = true; flushRemote(); }
  setInterval(backupNow, 60 * 60 * 1000).unref();
  setTimeout(backupNow, +process.env.BACKUP_FIRST_MS || 30 * 1000).unref();
}
async function shutdown() {
  console.log('[db] 종료 신호 — 마지막 저장 중');
  const kill = setTimeout(() => process.exit(0), 7000);
  try { refundLiveEscrow(); persistAllSolos(); fs.writeFileSync(ACC_FILE, JSON.stringify(accounts)); fs.writeFileSync(RANK_FILE, JSON.stringify(stats)); } catch {}
  try { clearTimeout(remoteTimer); remoteTimer = null; if (DB_ON && remoteReady) { dirty.acc = dirty.stats = true; await flushRemote(); } } catch {}
  clearTimeout(kill); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

/* ---------- 통계/랭킹 ---------- */
const DIFFS = ['easy', 'normal', 'hard'];
let stats = {};
try { stats = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')); } catch {}
function migrateStats() {
  for (const [n, r] of Object.entries(stats)) {
    if (r && r.wins !== undefined && !r.race) stats[n] = { race: { wins: r.wins, losses: r.losses } };
  }
}
migrateStats();
function saveRanks() { fs.writeFile(RANK_FILE, JSON.stringify(stats), () => {}); dirty.stats = true; dirty.backup = true; scheduleRemote(); }
function st(nick) {
  const u = stats[nick] || (stats[nick] = {});
  u.race = u.race || { wins: 0, losses: 0 };
  u.territory = u.territory || { wins: 0, losses: 0 };
  u.solo = u.solo || {};
  for (const d of DIFFS) u.solo[d] = u.solo[d] || { done: 0, over: 0, bestTime: 0, bestScore: 0, totalTime: 0 };
  return u;
}
function bump(nick, mode, key) { st(nick)[mode === 'territory' ? 'territory' : 'race'][key]++; }
function rankingList(mode, diff, by, full) {
  const rows = [];
  for (const nick of Object.keys(stats)) {
    if (isBanned(nick)) continue;
    const u = st(nick);
    if (mode === 'solo') {
      const s = u.solo[DIFFS.includes(diff) ? diff : 'normal'];
      if (by === 'score') { if (s.bestScore > 0) rows.push({ nick, value: s.bestScore, done: s.done, ...cosm(nick) }); }
      else if (s.bestTime > 0) rows.push({ nick, value: s.bestTime, done: s.done, ...cosm(nick) });
    } else {
      const r = u[mode === 'territory' ? 'territory' : 'race'];
      if (r.wins + r.losses > 0) rows.push({ nick, wins: r.wins, losses: r.losses, ...cosm(nick) });
    }
  }
  if (mode === 'solo') rows.sort((a, b) => (by === 'score' ? b.value - a.value : a.value - b.value) || a.nick.localeCompare(b.nick));
  else rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.nick.localeCompare(b.nick));
  return full ? rows : rows.slice(0, 20);
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
  dirty.acc = true; dirty.backup = true; scheduleRemote();
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
  return u && !u.banned ? u.nick : null;
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
  if (u.banned) throw new Error('정지된 계정이에요');
  return { token: newSession(u.nick), nick: u.nick };
}

/* ---------- 부정행위 방어 ---------- */
const SIGNUP_CAP = +process.env.SIGNUP_PER_DAY || 5, PVP_MIN_MS = process.env.PVP_MIN_MS !== undefined ? +process.env.PVP_MIN_MS : 60000;
const AC_ON = process.env.ANTICHEAT !== 'off', STRIKES_TO_BAN = 2, ADMIN_KEY = process.env.ADMIN_KEY || '';
const moveLog = new Map(); // nick -> 최근 입력 시각들
const reqLog = new Map();  // nick -> 최근 1초 요청 시각들
const signupLog = new Map(); // ip -> 가입 시각들
const seen = new Map();      // nick -> 마지막 접속 시각 (로비 접속자 표시용)
const userOf = (nick) => accounts.users[String(nick).toLowerCase()];
const isBanned = (nick) => { const u = userOf(nick); return !!(u && u.banned); };
function clientIp(req) { return String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim(); }
function banAccount(nick, reason) {
  const u = userOf(nick); if (!u || u.banned) return;
  u.banned = { at: Date.now(), reason };
  for (const k of Object.keys(accounts.sessions)) if (accounts.sessions[k].nick.toLowerCase() === u.nick.toLowerCase()) delete accounts.sessions[k];
  solos.delete(u.nick); unpersistSolo(u.nick); seen.delete(u.nick);
  for (const [code, room] of rooms) {
    if (room.status === 'waiting' && room.players.length === 1 && room.players[0].nick === u.nick) rooms.delete(code);
  }
  for (const room of rooms.values()) {
    const p = room.players.find((x) => x.nick === u.nick);
    if (p && (room.status === 'playing' || room.status === 'countdown')) {
      const opp = room.players.find((x) => x !== p);
      p.left = true; finish(room, opp ? opp.idx : 0, 'cheat');
    }
  }
  saveAcc();
  console.log('[ban]', u.nick, reason);
}
function strike(nick, reason) {
  const u = userOf(nick); if (!u || u.banned) return;
  u.strikes = (u.strikes || 0) + 1;
  u.lastStrike = { at: Date.now(), reason };
  moveLog.delete(nick);
  console.log('[strike]', u.nick, u.strikes, reason);
  if (u.strikes >= STRIKES_TO_BAN) banAccount(u.nick, reason); else saveAcc();
  throw new Error(u.strikes >= STRIKES_TO_BAN ? '비정상적인 입력이 감지되어 계정이 정지되었어요' : '비정상적인 입력이 감지됐어요. 반복되면 계정이 정지돼요');
}
// 입력이 들어올 때마다 호출: 사람이 낼 수 없는 속도/규칙성이면 경고
function watchMove(nick) {
  if (isBanned(nick)) throw new Error('정지된 계정이에요');
  if (!AC_ON) return;
  const now = Date.now();
  const a = (moveLog.get(nick) || []).filter((t) => now - t < 60000); a.push(now);
  if (a.length > 16) a.shift();
  moveLog.set(nick, a);
  if (a.length >= 10 && now - a[a.length - 10] < 4000) strike(nick, '입력 속도가 사람의 한계를 넘음');
  if (a.length >= 14) {
    const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    const m = d.reduce((x, y) => x + y, 0) / d.length;
    const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / d.length);
    if (m < 2500 && sd / m < 0.15) strike(nick, '입력 간격이 기계처럼 일정함');
  }
}
// 완주 시간이 비현실적으로 짧으면 경고 (빈 칸당 최소 0.9초)
function watchFinish(nick, empties, startedAt) {
  if (!AC_ON) return;
  if (Date.now() - startedAt < empties * 900) strike(nick, '비현실적으로 빠른 완주');
}
function rateLimit(key) {
  if (!AC_ON) return true;
  const now = Date.now();
  const a = (reqLog.get(key) || []).filter((t) => now - t < 1000); a.push(now); reqLog.set(key, a);
  return a.length <= 10;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of moveLog) if (!a.length || now - a[a.length - 1] > 120000) moveLog.delete(k); for (const [k, a] of reqLog) if (!a.length || now - a[a.length - 1] > 5000) reqLog.delete(k); for (const [k, t] of seen) if (now - t > 300000) seen.delete(k); for (const [k, a] of signupLog) if (!a.some((t) => now - t < 86400000)) signupLog.delete(k); }, 60000).unref();

/* ---------- 코인/상점 ---------- */
const WELCOME_COINS = 100, MATCH_FEE = 10, MATCH_BONUS = 10, BETS = [0, 50, 100, 200, 500];
const SOLO_REWARD = { easy: 10, normal: 20, hard: 30 }, SOLO_DAILY_CAP = 100;
const SHOP = {
  theme: {
    light: { name: '기본 (라이트)', price: 0, base: 'light', vars: {} },
    dark: { name: '다크', price: 0, base: 'dark', vars: {} },
    ocean: { name: '바다', price: 380, base: 'light', vars: { '--bg': '#f0f9ff', '--edge': '#bae6fd', '--ink': '#0c4a6e', '--mute': '#5b8aa5', '--line': '#9cc7de', '--blue': '#0284c7', '--user': '#0369a1', '--sel': '#7dd3fc', '--rel': '#e0f2fe', '--same': '#bae6fd', '--me': '#0284c7', '--me-bg': '#cdeeff', '--card': '#e6f4fb' } },
    forest: { name: '숲', price: 380, base: 'light', vars: { '--bg': '#f3f8f1', '--edge': '#cfe3c8', '--ink': '#2b4a2f', '--mute': '#6b8a6e', '--line': '#b4cdb0', '--blue': '#2f7d3a', '--user': '#2e7d32', '--sel': '#b7e1b0', '--rel': '#e5f1e1', '--same': '#cfe8c9', '--me': '#2e7d32', '--me-bg': '#d4efcf', '--card': '#ecf4ea' } },
    sunset: { name: '노을', price: 500, base: 'light', vars: { '--bg': '#fff7ed', '--edge': '#fed7aa', '--ink': '#7c2d12', '--mute': '#a8694d', '--line': '#e8c3a5', '--blue': '#ea580c', '--user': '#c2410c', '--sel': '#fdba74', '--rel': '#ffedd5', '--same': '#fed7aa', '--me': '#ea580c', '--me-bg': '#ffe0c2', '--card': '#fff1e2' } },
    sakura: { name: '벚꽃', price: 620, base: 'light', vars: { '--bg': '#fff5f8', '--edge': '#fbcfe8', '--ink': '#831843', '--mute': '#b0668a', '--line': '#ebbad1', '--blue': '#db2777', '--user': '#be185d', '--sel': '#f9a8d4', '--rel': '#fce7f3', '--same': '#fbcfe8', '--me': '#db2777', '--me-bg': '#fbd5e8', '--card': '#fdeaf3' } },
    retro: { name: '레트로 터미널', price: 750, base: 'dark', vars: { '--bg': '#0a1a0a', '--paper': '#0f240f', '--edge': '#1d4a1d', '--ink': '#8ef08e', '--mute': '#5fae5f', '--line': '#2c6a2c', '--blue': '#22c55e', '--user': '#4ade80', '--sel': '#1f5a1f', '--rel': '#123312', '--same': '#1b4d1b', '--bad': '#ff6b6b', '--bad-bg': '#4a1f1f', '--me': '#4ade80', '--me-bg': '#164016', '--op': '#d1fae5', '--op-bg': '#1c3a1c', '--card': '#122a12', '--theirs-bg': '#2a4d2a', '--theirs-ink': '#eaffea', '--opcur': '#eaffea' } },
    neon: { name: '심야 네온', price: 1000, base: 'dark', vars: { '--bg': '#0b0620', '--paper': '#150d33', '--edge': '#3a2a7a', '--ink': '#e9e1ff', '--mute': '#9d8fd6', '--line': '#4a3a8f', '--blue': '#a855f7', '--user': '#22d3ee', '--sel': '#3b2a86', '--rel': '#1b1245', '--same': '#33257a', '--bad': '#ff4d8d', '--bad-bg': '#4a1233', '--me': '#22d3ee', '--me-bg': '#0f3a4d', '--op': '#f0abfc', '--op-bg': '#3a1a52', '--card': '#1d1342', '--theirs-bg': '#4a2a7a', '--theirs-ink': '#ffffff', '--opcur': '#f0abfc' } },
  },
  color: {
    red: { name: '빨강', price: 150, css: '#e11d48' }, blue: { name: '파랑', price: 150, css: '#2563eb' },
    green: { name: '초록', price: 150, css: '#16a34a' }, purple: { name: '보라', price: 200, css: '#9333ea' },
    pink: { name: '핑크', price: 200, css: '#ec4899' }, gold: { name: '황금', price: 380, css: '#d4a017' },
    rainbow: { name: '무지개', price: 750, css: 'rainbow' },
  },
  title: {
    newbie: { name: '🌱 새싹', price: 80 }, turtle: { name: '🐢 느긋한 고수', price: 200 },
    smart: { name: '🧠 두뇌파', price: 250 }, sniper: { name: '🎯 정확한 손', price: 300 },
    flash: { name: '⚡ 번개손', price: 380 }, fire: { name: '🔥 불꽃', price: 500 }, king: { name: '👑 스도쿠 왕', price: 1250 },
  },
  effect: {
    basic: { name: '기본 색종이', price: 0 }, confetti: { name: '풍성한 색종이', price: 250 },
    stars: { name: '별똥별', price: 380 }, hearts: { name: '하트 비', price: 380 },
    lightning: { name: '번개', price: 500 }, fireworks: { name: '불꽃놀이', price: 620 }, gold: { name: '황금 비', price: 750 },
  },
};
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const getItem = (kind, id) => {
  if (kind === 'title') { const t = seasonTitle(id); if (t) return t; }
  return hasOwn(SHOP, kind) && hasOwn(SHOP[kind], String(id)) ? SHOP[kind][String(id)] : null;
};
function eco(nick) {
  const u = userOf(nick);
  if (!u) return null;
  if (!u.eco) {
    u.eco = {
      coins: WELCOME_COINS, owned: { theme: [], color: [], effect: [], title: [] },
      eq: { theme: 'light', color: '', effect: 'basic', title: '' },
      daily: { last: '', streak: 0, soloDate: '', soloEarned: 0 },
    };
  }
  return u.eco;
}
const coinsOf = (nick) => { const e = eco(nick); return e ? e.coins : 0; };
function addCoins(nick, n) { const e = eco(nick); if (!e) return; e.coins = Math.max(0, e.coins + n); saveAcc(); }
const kstDay = (off = 0) => new Date(Date.now() + 9 * 3600e3 + off * 864e5).toISOString().slice(0, 10);
const dailyReward = (streak) => 30 + Math.min(streak - 1, 4) * 10;
function ownedItem(e, kind, id) { const it = getItem(kind, id); return !!it && (it.price === 0 || e.owned[kind].includes(id)); }
const PROFILE_ICONS = ['🙂','😎','🤓','😺','🐶','🦊','🐼','🐯','🐸','🐧','🦄','🐲','🦉','🐙','🔥','⭐','🌙','⚡','🍀','🎯','🧠','👑','🚀','🎲'];
const MSG_MAX = 30;
function profileOf(nick) {
  const u = userOf(nick), p = (u && u.profile) || {};
  return { icon: PROFILE_ICONS.includes(p.icon) ? p.icon : '', msg: typeof p.msg === 'string' ? p.msg : '' };
}
function setProfile(nick, icon, msg) {
  const u = userOf(nick); if (!u) throw new Error('계정을 찾을 수 없어요');
  icon = String(icon || '');
  if (icon && !PROFILE_ICONS.includes(icon)) throw new Error('고를 수 없는 아이콘이에요');
  msg = Array.from(String(msg || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, MSG_MAX).join('');
  u.profile = { icon, msg }; saveAcc();
  return u.profile;
}
function cosm(nick) {
  const e = eco(nick);
  const icon = profileOf(nick).icon;
  if (!e) return { color: '', title: '', effect: 'basic', icon };
  const c = getItem('color', e.eq.color), t = getItem('title', e.eq.title);
  return { color: c ? c.css : '', title: t ? t.name : '', effect: getItem('effect', e.eq.effect) ? e.eq.effect : 'basic', icon };
}
function shopState(nick) {
  const e = eco(nick), day = kstDay();
  const canClaim = e.daily.last !== day;
  const nextDay = e.daily.last === kstDay(-1) ? e.daily.streak + 1 : 1;
  const catalog = {};
  for (const k of Object.keys(SHOP)) catalog[k] = Object.entries(SHOP[k]).map(([id, it]) => ({ id, ...it, owned: ownedItem(e, k, id) }));
  catalog.title = catalog.title.concat(e.owned.title.filter((id) => seasonTitle(id)).map((id) => ({ id, ...seasonTitle(id), owned: true })));
  const th = getItem('theme', e.eq.theme) || SHOP.theme.light;
  return {
    coins: e.coins, eq: e.eq, cosm: cosm(nick), profile: profileOf(nick), catalog, quests: questView(nick), notes: e.notes || [], admin: isAdminNick(nick),
    eqTheme: { id: e.eq.theme, base: th.base, vars: th.vars },
    daily: { canClaim, reward: dailyReward(nextDay), day: nextDay },
    soloToday: e.daily.soloDate === day ? e.daily.soloEarned : 0, soloCap: SOLO_DAILY_CAP,
  };
}
function buyItem(nick, kind, id) {
  const e = eco(nick), it = getItem(kind, id);
  if (!it) throw new Error('없는 아이템이에요');
  if (it.special || it.price < 0) throw new Error('구매할 수 없는 한정 아이템이에요');
  if (ownedItem(e, kind, id)) throw new Error('이미 가지고 있어요');
  if (e.coins < it.price) throw new Error('코인이 부족해요');
  e.coins -= it.price; e.owned[kind].push(String(id)); saveAcc();
}
function equipItem(nick, kind, id) {
  const e = eco(nick);
  if (!hasOwn(SHOP, kind)) throw new Error('없는 항목이에요');
  if (id === '' || id == null) {
    if (kind === 'theme' || kind === 'effect') throw new Error('해제할 수 없는 항목이에요');
    e.eq[kind] = '';
  } else {
    if (!ownedItem(e, kind, String(id))) throw new Error('먼저 구매해 주세요');
    e.eq[kind] = String(id);
  }
  saveAcc();
}
function claimDaily(nick) {
  const e = eco(nick), day = kstDay();
  if (e.daily.last === day) throw new Error('오늘은 이미 받았어요');
  const streak = e.daily.last === kstDay(-1) ? e.daily.streak + 1 : 1, amt = dailyReward(streak);
  e.daily.last = day; e.daily.streak = streak; e.coins += amt; saveAcc();
  return amt;
}
function betCheck(room, extraNick) {
  if (!(room.bet > 0)) return null;
  const nicks = room.players.map((p) => p.nick);
  if (extraNick) nicks.push(extraNick);
  return nicks.find((n) => coinsOf(n) < room.bet) || null;
}

/* ---------- 알림 노트 / 판돈 보관 기록 ---------- */
function pushNote(nick, text) {
  const e = eco(nick); if (!e) return;
  e.notes = (e.notes || []).slice(-9); e.notes.push(text); saveAcc();
}
// 대결이 시작될 때 걸린 판돈을 계정 데이터에 같이 기록해 두어, 서버가 중간에 꺼져도 돌려줄 수 있게 한다
function escrowSet(room) {
  accounts.escrow = accounts.escrow || {};
  accounts.escrow[room.code] = { bet: room.bet, nicks: room.players.map((p) => p.nick), at: Date.now() };
  saveAcc();
}
function escrowClear(code) { if (accounts.escrow && accounts.escrow[code]) { delete accounts.escrow[code]; saveAcc(); } }
function refundEscrowEntry(code, why) {
  const r = accounts.escrow && accounts.escrow[code]; if (!r) return 0;
  let n = 0;
  for (const nick of r.nicks) { const e = eco(nick); if (!e) continue; e.coins += r.bet; n++; pushNote(nick, why + ' · 판돈 ' + r.bet + '🪙을 돌려받았어요'); }
  delete accounts.escrow[code]; saveAcc(); return n;
}
function refundOrphanEscrow() { // 서버 시작 직후: 이 서버의 메모리에는 없는 방의 판돈을 환불
  let n = 0;
  for (const code of Object.keys(accounts.escrow || {})) n += refundEscrowEntry(code, '서버가 다시 시작되어 끊긴 대결');
  if (n) console.log('[escrow] 끊긴 대결의 판돈을 환불했어요:', n, '명');
}
function refundLiveEscrow() { // 종료 신호(배포 등) 때: 진행 중인 대결의 판돈 환불
  for (const room of rooms.values()) {
    if (room.escrow > 0 && (room.status === 'countdown' || room.status === 'playing')) { refundEscrowEntry(room.code, '서버 점검으로 끊긴 대결'); room.escrow = 0; }
  }
}

/* ---------- 일일 퀘스트 ---------- */
const QUEST_POOL = [
  { id: 'solo1', fam: 'solo', ev: 'solo_clear', goal: 1, reward: 30, name: '솔로 1판 클리어' },
  { id: 'solo2', fam: 'solo', ev: 'solo_clear', goal: 2, reward: 50, name: '솔로 2판 클리어' },
  { id: 'clean', fam: 'clean', ev: 'solo_clean', goal: 1, reward: 60, name: '실수 없이 솔로 1판 클리어' },
  { id: 'nohint', fam: 'nohint', ev: 'solo_nohint', goal: 1, reward: 40, name: '힌트 없이 솔로 1판 클리어' },
  { id: 'hard', fam: 'hard', ev: 'solo_hard', goal: 1, reward: 60, name: '어려움 솔로 1판 클리어' },
  { id: 'play2', fam: 'play', ev: 'pvp_play', goal: 2, reward: 40, name: '대결 2판 플레이' },
  { id: 'win1', fam: 'win', ev: 'pvp_win', goal: 1, reward: 50, name: '대결 1승 거두기' },
  { id: 'rwin', fam: 'win', ev: 'race_win', goal: 1, reward: 50, name: '레이스에서 1승' },
  { id: 'twin', fam: 'win', ev: 'terr_win', goal: 1, reward: 50, name: '칸 차지에서 1승' },
];
const QUEST_BONUS = 50;
const questDef = (id) => QUEST_POOL.find((q) => q.id === id);
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pickQuests() { // 종류가 겹치지 않게 3개, 대결 퀘스트는 최대 1개 (상대가 없어도 깰 수 있게)
  const chosen = []; let pvp = 0;
  for (const f of shuffle([...new Set(QUEST_POOL.map((q) => q.fam))])) {
    const isPvp = f === 'play' || f === 'win';
    if (isPvp && pvp >= 1) continue;
    const m = QUEST_POOL.filter((q) => q.fam === f);
    chosen.push(m[crypto.randomInt(m.length)].id); if (isPvp) pvp++;
    if (chosen.length === 3) break;
  }
  return chosen;
}
function questState(nick) {
  const e = eco(nick), day = kstDay();
  if (!e.quest || e.quest.day !== day) { e.quest = { day, list: pickQuests().map((id) => ({ id, prog: 0, claimed: false })), bonus: false }; saveAcc(); }
  return e.quest;
}
function questEvent(nick, ev, n = 1) {
  if (!eco(nick)) return;
  const q = questState(nick); let ch = false;
  for (const it of q.list) { const d = questDef(it.id); if (d && d.ev === ev && it.prog < d.goal) { it.prog = Math.min(d.goal, it.prog + n); ch = true; } }
  if (ch) saveAcc();
}
function questView(nick) {
  const q = questState(nick);
  const list = q.list.map((it) => { const d = questDef(it.id); return { id: it.id, name: d.name, goal: d.goal, prog: it.prog, reward: d.reward, done: it.prog >= d.goal, claimed: it.claimed }; });
  return { list, bonus: { reward: QUEST_BONUS, ready: list.every((x) => x.done) && !q.bonus, claimed: q.bonus } };
}
function claimQuest(nick, id) {
  const q = questState(nick), e = eco(nick);
  if (id === 'bonus') {
    if (q.bonus) throw new Error('이미 받았어요');
    if (!q.list.every((it) => it.prog >= questDef(it.id).goal)) throw new Error('퀘스트를 모두 완료해야 해요');
    q.bonus = true; e.coins += QUEST_BONUS; saveAcc(); return QUEST_BONUS;
  }
  const it = q.list.find((x) => x.id === id);
  if (!it) throw new Error('없는 퀘스트예요');
  const d = questDef(id);
  if (it.claimed) throw new Error('이미 받았어요');
  if (it.prog < d.goal) throw new Error('아직 완료하지 않았어요');
  it.claimed = true; e.coins += d.reward; saveAcc(); return d.reward;
}

/* ---------- 시즌 랭킹 (월요일 0시 / 금요일 0시 KST 기준, 4일 + 3일) ---------- */
const SEASON_PRIZES = [500, 300, 150], SEASON_PART = 30, PAIR_CAP = 6;
function seasonBounds(ms = Date.now()) {
  const k = new Date(ms + 9 * 3600e3), dow = k.getUTCDay() || 7; // 월=1 … 일=7
  const back = dow >= 5 ? dow - 5 : dow - 1, days = dow >= 5 ? 3 : 4;
  const startK = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - back);
  const start = startK - 9 * 3600e3;
  return { id: new Date(startK).toISOString().slice(0, 10), start, end: start + days * 864e5 };
}
const newSeason = (b) => ({ id: b.id, start: b.start, end: b.end, solo: {}, wins: {}, plays: {}, pairs: {} });
function seasonBoards(s) {
  const ok = (n) => userOf(n) && !isBanned(n);
  const solo = Object.entries(s.solo).filter(([n]) => ok(n)).map(([n, v]) => ({ nick: userOf(n).nick, score: v.score, diff: v.diff, clears: v.clears }))
    .sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick));
  const wins = Object.entries(s.wins).filter(([n, c]) => c > 0 && ok(n)).map(([n, c]) => ({ nick: userOf(n).nick, wins: c }))
    .sort((a, b) => b.wins - a.wins || a.nick.localeCompare(b.nick));
  return { solo, wins };
}
const seasonTitleId = (sid, kind, rank) => 's_' + sid.replace(/-/g, '') + '_' + kind + '_' + rank;
const SEASON_T_RE = /^s_(\d{4})(\d{2})(\d{2})_(solo|win)_([123])$/;
function seasonTitle(id) {
  const m = SEASON_T_RE.exec(String(id)); if (!m) return null;
  return { name: ['🥇', '🥈', '🥉'][m[5] - 1] + ' ' + (+m[2]) + '/' + (+m[3]) + ' 시즌 ' + (m[4] === 'solo' ? '솔로' : '대결') + ' ' + m[5] + '위', price: -1, special: true };
}
function settleSeason(s) {
  const { solo, wins } = seasonBoards(s), awarded = new Set();
  const give = (rows, kind, label) => rows.slice(0, 3).forEach((r, i) => {
    const e = eco(r.nick), tid = seasonTitleId(s.id, kind, i + 1);
    e.coins += SEASON_PRIZES[i]; if (!e.owned.title.includes(tid)) e.owned.title.push(tid);
    pushNote(r.nick, '🏆 시즌 정산 · ' + label + ' ' + (i + 1) + '위! +' + SEASON_PRIZES[i] + '🪙 (한정 칭호 획득)');
    awarded.add(r.nick);
  });
  give(solo, 'solo', '솔로 최고점'); give(wins, 'win', '대결 승수');
  for (const n of new Set([...Object.keys(s.solo), ...Object.keys(s.wins), ...Object.keys(s.plays || {})])) {
    const u = userOf(n); if (!u || u.banned || awarded.has(u.nick)) continue;
    const clears = (s.solo[n] || {}).clears || 0, plays = (s.plays || {})[n] || 0;
    if (clears >= 3 || plays >= 2) { eco(u.nick).coins += SEASON_PART; pushNote(u.nick, '🎖️ 시즌 참여 보상 +' + SEASON_PART + '🪙'); }
  }
  accounts.seasonHist = accounts.seasonHist || [];
  accounts.seasonHist.unshift({ id: s.id, start: s.start, end: s.end, solo: solo.slice(0, 3), wins: wins.slice(0, 3) });
  accounts.seasonHist.length = Math.min(accounts.seasonHist.length, 8);
  saveAcc();
  console.log('[season] 정산 완료', s.id);
}
function ensureSeason() {
  const b = seasonBounds();
  if (!accounts.season) { accounts.season = newSeason(b); saveAcc(); }
  else if (accounts.season.id !== b.id) { settleSeason(accounts.season); accounts.season = newSeason(b); saveAcc(); }
  return accounts.season;
}
function seasonSolo(nick, score, diff) {
  const s = ensureSeason(), v = s.solo[nick] || (s.solo[nick] = { score: 0, diff: '', clears: 0 });
  v.clears++; if (score > v.score) { v.score = score; v.diff = diff; } saveAcc();
}
// 대결 종료 처리: 60초 이상 진행된 판만 퀘스트/시즌에 반영하고, 같은 상대와는 시즌당 6판까지만 인정
function onPvpEnd(room, winner, reason) {
  if (room.players.length < 2 || !room.startedAt || room.endedAt - room.startedAt < PVP_MIN_MS) return;
  const s = ensureSeason(), key = room.players.map((p) => p.nick).sort().join('|');
  s.pairs = s.pairs || {}; s.plays = s.plays || {};
  const counted = (s.pairs[key] = (s.pairs[key] || 0) + 1) <= PAIR_CAP;
  if (!counted) { saveAcc(); return; }
  for (const p of room.players) { s.plays[p.nick] = (s.plays[p.nick] || 0) + 1; questEvent(p.nick, 'pvp_play'); }
  if (winner && ['complete', 'board', 'lives'].includes(reason)) {
    const w = room.players.find((p) => p.idx === winner);
    if (w) { s.wins[w.nick] = (s.wins[w.nick] || 0) + 1; questEvent(w.nick, 'pvp_win'); questEvent(w.nick, room.mode === 'territory' ? 'terr_win' : 'race_win'); }
  }
  saveAcc();
}
const SNAP_MS = +process.env.SNAP_MS || 30 * 60 * 1000;
function rankMap(rows) { const m = {}; rows.forEach((r, i) => { m[r.nick] = i + 1; }); return m; }
function seasonView(me) {
  const s = ensureSeason(), b = seasonBoards(s), now = Date.now();
  // 순위 변동: 30분마다 스냅샷을 돌려서, 직전 스냅샷 대비 오르내림을 보여줌
  const live = { solo: rankMap(b.solo), wins: rankMap(b.wins) };
  const sn = s.snap || (s.snap = { at: now, cur: live, prev: null });
  if (now - sn.at >= SNAP_MS) { sn.prev = sn.cur; sn.cur = live; sn.at = now; saveAcc(); }
  const chg = (kind, nick, rank) => {
    if (!sn.prev) return null;
    const p = sn.prev[kind][nick];
    return p ? p - rank : 'new';
  };
  const dec = (kind) => (r, i) => ({ ...r, rank: i + 1, chg: chg(kind, r.nick, i + 1), ...cosm(r.nick) });
  const out = { id: s.id, start: s.start, end: s.end, now, remain: Math.max(0, s.end - now), prizes: SEASON_PRIZES, part: SEASON_PART,
    solo: b.solo.slice(0, 10).map(dec('solo')), wins: b.wins.slice(0, 10).map(dec('wins')), hist: (accounts.seasonHist || []).slice(0, 3) };
  const u = me && userOf(me);
  if (u && !u.banned) {
    const mk = (kind, rows, val) => {
      const i = rows.findIndex((r) => r.nick === u.nick);
      if (i < 0) return { rank: 0, total: rows.length, first: rows[0] ? val(rows[0]) : 0 };
      return { rank: i + 1, total: rows.length, value: val(rows[i]), first: val(rows[0]), gap: val(rows[0]) - val(rows[i]), chg: chg(kind, u.nick, i + 1) };
    };
    out.me = { solo: mk('solo', b.solo, (r) => r.score), wins: mk('wins', b.wins, (r) => r.wins) };
  }
  return out;
}

/* ---------- 공개 프로필 ---------- */
function publicProfile(nick) {
  const u = userOf(nick); if (!u || u.banned) return null;
  const k = u.nick, p = profileOf(k), c = cosm(k), t = st(k), s = ensureSeason(), b = seasonBoards(s);
  const e = eco(k), seasonTitles = ((e && e.owned.title) || []).map(seasonTitle).filter(Boolean).map((x) => x.name).slice(-6);
  const si = b.solo.findIndex((r) => r.nick === k), wi = b.wins.findIndex((r) => r.nick === k);
  return { nick: k, icon: p.icon, msg: p.msg, color: c.color, title: c.title, created: u.created || 0, online: (Date.now() - (seen.get(k) || 0)) < 60000,
    race: t.race, territory: t.territory, solo: t.solo, seasonTitles,
    season: { soloScore: (s.solo[k] || {}).score || 0, soloRank: si + 1, wins: s.wins[k] || 0, winRank: wi + 1, plays: (s.plays || {})[k] || 0 } };
}


/* ---------- 피드백 게시판 (로그인한 사람만 · 공감 투표) ---------- */
const BOARD_MAX_LEN = 300, BOARD_DAILY = 3, BOARD_KEEP = 300;
function boardList(me, sort) {
  const b = (accounts.board && accounts.board.posts) || [];
  const rows = b.filter((p) => { const u = userOf(p.nick); return u && !u.banned; }).map((p) => ({
    id: p.id, nick: p.nick, text: p.text, at: p.at, likes: p.likes.length, liked: p.likes.includes(me), mine: p.nick === me, ...cosm(p.nick) }));
  rows.sort(sort === 'hot' ? (x, y) => y.likes - x.likes || y.at - x.at : (x, y) => y.at - x.at);
  return rows.slice(0, 100);
}
function boardPost(nick, text) {
  text = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  text = Array.from(text).slice(0, BOARD_MAX_LEN).join('');
  if (Array.from(text).length < 5) throw new Error('5자 이상 적어 주세요');
  const bd = accounts.board = accounts.board || { seq: 0, posts: [] }, day = kstDay();
  const today = bd.posts.filter((p) => p.nick === nick && kstDay((p.at - Date.now()) / 864e5) === day).length;
  if (today >= BOARD_DAILY) throw new Error('하루에 ' + BOARD_DAILY + '개까지 쓸 수 있어요');
  if (bd.posts.some((p) => p.nick === nick && p.text === text)) throw new Error('같은 내용을 이미 올렸어요');
  bd.posts.unshift({ id: ++bd.seq, nick, text, at: Date.now(), likes: [] });
  bd.posts.length = Math.min(bd.posts.length, BOARD_KEEP);
  saveAcc();
}
function boardLike(nick, id) {
  const p = ((accounts.board && accounts.board.posts) || []).find((x) => x.id === +id);
  if (!p) throw new Error('없는 글이에요');
  if (p.nick === nick) throw new Error('내 글에는 공감할 수 없어요');
  const i = p.likes.indexOf(nick); if (i >= 0) p.likes.splice(i, 1); else p.likes.push(nick);
  saveAcc();
}
function boardDelete(nick, id, force) {
  const bd = accounts.board; const i = bd ? bd.posts.findIndex((x) => x.id === +id) : -1;
  if (i < 0) throw new Error('없는 글이에요');
  if (!force && bd.posts[i].nick !== nick) throw new Error('내 글만 지울 수 있어요');
  bd.posts.splice(i, 1); saveAcc();
}

/* ---------- 관리자 (닉네임 + 관리자 키, 둘 다 맞아야 함) ---------- */
const ADMIN_NICKS = (process.env.ADMIN_NICK || 'KOREAMOAI,KOROEAMOAI').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isAdminNick = (n) => !!n && ADMIN_NICKS.includes(String(n).toLowerCase());
const adminFails = new Map();
function adminAuth(nick, req, key) {
  if (!isAdminNick(nick)) return { s: 403, e: '권한이 없어요' };
  const ip = clientIp(req), f = adminFails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return { s: 429, e: '잠시 후 다시 시도해 주세요' };
  const h = (x) => crypto.createHash('sha256').update(String(x || '')).digest();
  if (!ADMIN_KEY || !crypto.timingSafeEqual(h(key), h(ADMIN_KEY))) {
    f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; } adminFails.set(ip, f);
    return { s: 403, e: '관리자 키가 맞지 않아요' };
  }
  adminFails.delete(ip); return null;
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
  room.payout = null; room.escrow = 0;
  if (room.bet > 0) {
    for (const p of room.players) addCoins(p.nick, -room.bet);
    room.escrow = room.bet * room.players.length;
    escrowSet(room);
  }
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
  if (room.escrow) {
    if (winner) {
      const w = room.players.find((p) => p.idx === winner), bonus = room.fixed ? MATCH_BONUS : 0;
      if (w) { addCoins(w.nick, room.escrow + bonus); room.payout = { winner, amount: room.escrow + bonus, bonus }; }
    } else {
      room.players.forEach((p) => addCoins(p.nick, room.bet));
      room.payout = { winner: 0, amount: 0, refund: true };
    }
    room.escrow = 0; escrowClear(room.code);
  }
  onPvpEnd(room, winner, reason);
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
    code: room.code, status: room.status, difficulty: room.difficulty, mode: room.mode, total: room.total || 0, bet: room.bet || 0, fixed: !!room.fixed, payout: room.payout || null,
    now, startsAt: room.startsAt || 0, startedAt: room.startedAt || 0, endedAt: room.endedAt || 0,
    you: me.idx,
    players: room.players.map((p) => ({
      idx: p.idx, nick: p.nick, ...cosm(p.nick), lives: p.lives, score: race ? p.cells : p.score, cells: p.cells, hints: p.hints || 0,
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
  watchMove(p.nick);
  if (room.puzzle[i]) throw new Error('처음부터 주어진 칸이에요');
  if (p.grid[i] && !p.wrong[i]) throw new Error('이미 맞힌 칸이에요');
  if (p.wrong[i] && p.grid[i] === v) return { correct: false, same: true };
  const opp = room.players.find((x) => x !== p);
  if (room.solution[i] === v) {
    if (p.cells + 1 >= room.total) watchFinish(p.nick, room.total, room.startedAt);
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
const SOLO_KEEP_MS = +process.env.SOLO_KEEP_MS || 3 * 3600e3, SOLO_IDLE_MS = +process.env.SOLO_IDLE_MS || 90e3;
const RESUME_RANKED = process.env.RESUME_RANKED !== 'off'; // off: 이어하기를 한 판은 랭킹/시즌 기록에서 제외
function persistSolo(g) { accounts.soloSaved = accounts.soloSaved || {}; accounts.soloSaved[g.nick] = g; saveAcc(); }
function unpersistSolo(nick) { if (accounts.soloSaved && accounts.soloSaved[nick]) { delete accounts.soloSaved[nick]; saveAcc(); } }
function soloPause(g, at) { if (g.status === 'playing' && !g.pausedAt) { g.pausedAt = at; g.updated = Date.now(); } }
// 이어하기: 자리를 비운 시간은 빼 준다 (startedAt을 그만큼 뒤로 민다). idle=true면 창만 닫고 나간 판도 마지막 입력 시각부터 멈춘 것으로 본다
function soloResume(g, idle) {
  if (g.status !== 'playing') return g;
  const now = Date.now();
  if (idle && !g.pausedAt && now - g.updated > SOLO_IDLE_MS) g.pausedAt = g.updated;
  if (g.pausedAt) { g.startedAt += now - g.pausedAt; g.pausedAt = 0; g.resumed = true; }
  g.updated = now; unpersistSolo(g.nick);
  return g;
}
function soloInfo(nick) {
  const g = solos.get(nick); if (!g || g.status !== 'playing') return null;
  const end = g.pausedAt || (Date.now() - g.updated > SOLO_IDLE_MS ? g.updated : Date.now());
  return { difficulty: g.difficulty, cells: g.cells, total: g.total, mistakes: g.mistakes, hints: g.hints, elapsed: Math.max(0, end - g.startedAt), savedAt: g.updated };
}
function persistAllSolos() { const now = Date.now(); for (const g of solos.values()) if (g.status === 'playing') { soloPause(g, g.pausedAt || now); persistSolo(g); } }
function loadSavedSolos() {
  const sv = accounts.soloSaved || {}, now = Date.now();
  for (const [n, g] of Object.entries(sv)) {
    if (!userOf(n) || now - g.updated > SOLO_KEEP_MS || g.status !== 'playing') { delete sv[n]; continue; }
    if (!g.pausedAt) g.pausedAt = g.updated;
    solos.set(n, g);
  }
}
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
  solos.set(nick, g); unpersistSolo(nick);
  return g;
}
function soloView(g) {
  const fin = g.status === 'finished';
  return {
    mode: 'solo', status: g.status, difficulty: g.difficulty, total: g.total,
    startedAt: g.startedAt, endedAt: g.endedAt, now: Date.now(), startsAt: 0, you: 1, code: '',
    players: [{ idx: 1, nick: g.nick, ...cosm(g.nick), lives: LIVES - g.mistakes, score: g.cells, cells: g.cells, hints: g.hints,
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
    const ranked = RESUME_RANKED || !g.resumed;
    if (ranked) seasonSolo(g.nick, r.score, g.difficulty);
    questEvent(g.nick, 'solo_clear');
    if (!g.mistakes) questEvent(g.nick, 'solo_clean');
    if (!g.hints) questEvent(g.nick, 'solo_nohint');
    if (g.difficulty === 'hard') questEvent(g.nick, 'solo_hard');
    if (ranked && !g.hints && (!s.bestTime || time < s.bestTime)) { s.bestTime = time; r.newBestTime = true; }
    if (ranked && r.score > s.bestScore) { s.bestScore = r.score; r.newBestScore = true; }
    const e = eco(g.nick), day = kstDay(), full = SOLO_REWARD[g.difficulty];
    if (e) {
      if (e.daily.soloDate !== day) { e.daily.soloDate = day; e.daily.soloEarned = 0; }
      const gain = Math.max(0, Math.min(full, SOLO_DAILY_CAP - e.daily.soloEarned));
      e.daily.soloEarned += gain; e.coins += gain; r.coins = gain; r.capped = gain < full;
    }
  } else s.over++;
  g.result = r;
  saveRanks();
}
function soloActive(g) {
  if (g.status !== 'playing') throw new Error('이미 끝난 게임이에요');
  if (g.pausedAt) soloResume(g, false);
  g.updated = Date.now();
}
function soloMove(g, i, v) {
  soloActive(g);
  if (!Number.isInteger(i) || i < 0 || i > 80 || !Number.isInteger(v) || v < 1 || v > 9) throw new Error('잘못된 입력');
  watchMove(g.nick);
  if (g.puzzle[i]) throw new Error('처음부터 주어진 칸이에요');
  if (g.grid[i] && !g.wrong[i]) throw new Error('이미 맞힌 칸이에요');
  if (g.wrong[i] && g.grid[i] === v) return { correct: false, same: true, state: soloView(g) };
  if (g.solution[i] === v) {
    if (g.cells + 1 >= g.total) watchFinish(g.nick, g.total, g.startedAt);
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
  watchMove(p.nick);
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
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/season') return json(res, 200, seasonView(url.searchParams.get('me')));
    if (req.method === 'GET' && url.pathname === '/api/ranking') {
      const mode = url.searchParams.get('mode') || 'race', diff = url.searchParams.get('diff') || 'normal', by = url.searchParams.get('by') || 'time', me = url.searchParams.get('me');
      if (!me) return json(res, 200, rankingList(mode, diff, by));
      const all = rankingList(mode, diff, by, true), i = all.findIndex((r) => r.nick.toLowerCase() === me.toLowerCase());
      return json(res, 200, { rows: all.slice(0, 20), me: i < 0 ? null : { rank: i + 1, total: all.length, row: all[i], first: all[0] } });
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') {
      const p = publicProfile(url.searchParams.get('nick') || '');
      return p ? json(res, 200, p) : json(res, 404, { error: '유저를 찾을 수 없어요' });
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
      const rkey = body.pid ? 'p' + body.pid : body.token ? 't' + sha(String(body.token)) : 'i' + clientIp(req);
      if (!rateLimit(rkey)) return json(res, 429, { error: '요청이 너무 빨라요. 잠시 후 다시 해 주세요' });

      if (action === 'signup') {
        const ip = clientIp(req), now = Date.now();
        const a = (signupLog.get(ip) || []).filter((t) => now - t < 86400000);
        if (a.length >= SIGNUP_CAP) return json(res, 429, { error: '오늘은 더 이상 이 네트워크에서 가입할 수 없어요' });
        try { const r = signup(body.nick, body.pw); a.push(now); signupLog.set(ip, a); return json(res, 200, r); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'login') {
        try { return json(res, 200, login(body.nick, body.pw)); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'me') {
        const nick = nickFromToken(body.token);
        return nick ? json(res, 200, { nick, coins: coinsOf(nick), admin: isAdminNick(nick), profile: profileOf(nick) }) : json(res, 401, { error: '로그인이 필요해요' });
      }
      if (action === 'logout') {
        if (body.token) { delete accounts.sessions[sha(String(body.token))]; saveAcc(); }
        return json(res, 200, { ok: true });
      }
      const authNick = nickFromToken(body.token);
      if (authNick) seen.set(authNick, Date.now());

      if (action.startsWith('admin/')) {
        const bad = adminAuth(authNick, req, body.key);
        if (bad) return json(res, bad.s, { error: bad.e });
        const a = action.slice(6);
        try {
          if (a === 'auth') return json(res, 200, { ok: true });
          if (a === 'users') {
            const t = Date.now();
            const users = Object.values(accounts.users).map((u) => ({
              nick: u.nick, coins: coinsOf(u.nick), strikes: u.strikes || 0, banned: u.banned ? (u.banned.reason || '정지') : '',
              created: u.created || 0, online: !!seen.get(u.nick) && t - seen.get(u.nick) < 45000, admin: isAdminNick(u.nick),
            })).sort((x, y) => y.created - x.created).slice(0, 500);
            const s = ensureSeason();
            return json(res, 200, { users, total: Object.keys(accounts.users).length, db: { ...dbInfo }, season: { id: s.id, end: s.end } });
          }
          if (a === 'board/delete') { boardDelete('', body.id, true); return json(res, 200, { ok: true }); }
          if (a === 'ban' || a === 'unban' || a === 'coins') {
            const u = userOf(body.nick || '');
            if (!u) throw new Error('없는 계정이에요');
            if (a === 'ban') {
              if (isAdminNick(u.nick)) throw new Error('관리자 계정은 정지할 수 없어요');
              banAccount(u.nick, '관리자 정지' + (body.reason ? ': ' + String(body.reason).slice(0, 60) : ''));
            } else if (a === 'unban') { delete u.banned; u.strikes = 0; delete u.lastStrike; moveLog.delete(u.nick); saveAcc(); }
            else {
              const d = Math.trunc(Number(body.delta));
              if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 100000) throw new Error('코인 변화량은 1~100000 사이의 정수로 입력해 주세요');
              addCoins(u.nick, d); pushNote(u.nick, '관리자가 코인 ' + Math.abs(d) + '🪙을 ' + (d > 0 ? '지급' : '회수') + '했어요');
            }
            return json(res, 200, { ok: true, coins: coinsOf(u.nick) });
          }
          if (a === 'season/settle') {
            settleSeason(accounts.season || ensureSeason()); accounts.season = newSeason(seasonBounds()); saveAcc();
            return json(res, 200, { ok: true });
          }
          if (a === 'dbstatus') return json(res, 200, { ...dbInfo, users: Object.keys(accounts.users).length, ranked: Object.keys(stats).length });
          if (a === 'restore') {
            if (!DB_ON) throw new Error('DB가 설정되지 않았어요');
            const day = String(body.day || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day는 YYYY-MM-DD 형식이에요');
            const ra = await dbCmd(['GET', 'sd:backup:accounts:' + day]), rt = await dbCmd(['GET', 'sd:backup:stats:' + day]);
            if (!ra || !rt) throw new Error('해당 날짜의 백업이 없어요');
            accounts = JSON.parse(ra); accounts.users = accounts.users || {}; accounts.sessions = accounts.sessions || {};
            stats = JSON.parse(rt); migrateStats();
            dirty.acc = dirty.stats = true; await flushRemote();
            return json(res, 200, { ok: true, users: Object.keys(accounts.users).length });
          }
          return json(res, 404, { error: 'unknown' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (['create', 'join', 'match'].includes(action) && !authNick) return json(res, 401, { error: '로그인이 필요해요' });

      if (action === 'lobby') {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        const t = Date.now(), online = new Set();
        for (const [n, ts] of seen) if (t - ts < 45000 && !isBanned(n)) online.add(n);
        for (const rm of rooms.values()) for (const pl of rm.players) if (pl.connected && !isBanned(pl.nick)) online.add(pl.nick);
        const list = [];
        for (const rm of rooms.values()) {
          const host = rm.players[0];
          if (rm.listed && rm.status === 'waiting' && rm.players.length === 1 && !isBanned(host.nick) && (host.connected || t - rm.updated < 20000))
            list.push({ code: rm.code, host: host.nick, ...cosm(host.nick), mode: rm.mode, difficulty: rm.difficulty, bet: rm.bet || 0 });
        }
        const names = [...online].sort((a, b) => a.localeCompare(b)).slice(0, 24).map((n) => ({ nick: n, ...cosm(n) }));
        return json(res, 200, { rooms: list.slice(0, 20), online: online.size, names, solo: soloInfo(authNick) });
      }
      if (action.startsWith('board/')) {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        try {
          const a = action.slice(6);
          if (a === 'list') return json(res, 200, { posts: boardList(authNick, body.sort), max: BOARD_MAX_LEN, daily: BOARD_DAILY });
          if (isBanned(authNick)) return json(res, 403, { error: '정지된 계정은 사용할 수 없어요' });
          if (a === 'post') boardPost(authNick, body.text);
          else if (a === 'like') boardLike(authNick, body.id);
          else if (a === 'delete') boardDelete(authNick, body.id, false);
          else return json(res, 404, { error: '없는 요청이에요' });
          return json(res, 200, { posts: boardList(authNick, body.sort), max: BOARD_MAX_LEN, daily: BOARD_DAILY });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'roominfo') {
        const rm = rooms.get(String(body.code || '').toUpperCase().trim());
        if (!rm) return json(res, 404, { error: '해당 코드의 방이 없어요' });
        return json(res, 200, { mode: rm.mode, difficulty: rm.difficulty, bet: rm.bet || 0, fixed: !!rm.fixed, host: rm.players[0].nick, full: rm.players.length >= 2 });
      }
      if (action === 'shop' || action.startsWith('shop/') || action === 'daily/claim' || action === 'quest/claim' || action === 'notes/ack' || action === 'profile/set') {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        try {
          let claimed = 0;
          if (action === 'shop/buy') buyItem(authNick, body.kind, body.id);
          else if (action === 'shop/equip') equipItem(authNick, body.kind, body.id);
          else if (action === 'profile/set') setProfile(authNick, body.icon, body.msg);
          else if (action === 'daily/claim') claimed = claimDaily(authNick);
          else if (action === 'quest/claim') claimed = claimQuest(authNick, String(body.id || ''));
          else if (action === 'notes/ack') { const e = eco(authNick); if (e && e.notes && e.notes.length) { e.notes = []; saveAcc(); } }
          return json(res, 200, { ...shopState(authNick), claimed });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'mystats') {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        return json(res, 200, st(authNick));
      }
      if (action.startsWith('solo/')) {
        if (!authNick) return json(res, 401, { error: '로그인이 필요해요' });
        try {
          const a = action.slice(5);
          if (a === 'start') return json(res, 200, { state: soloView(soloStart(authNick, body.difficulty)) });
          if (a === 'leave') {
            const lg = solos.get(authNick);
            if (lg && lg.status === 'playing') { soloPause(lg, Date.now()); persistSolo(lg); } else { solos.delete(authNick); unpersistSolo(authNick); }
            return json(res, 200, { ok: true });
          }
          const g = solos.get(authNick);
          if (!g) throw new Error('진행 중인 솔로 게임이 없어요');
          if (a === 'resume') return json(res, 200, { state: soloView(soloResume(g, true)) });
          if (a === 'state') return json(res, 200, { state: soloView(soloResume(g, false)) });
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
        const bet = BETS.includes(body.bet) ? body.bet : 0;
        if (coinsOf(nick) < bet) return json(res, 400, { error: '코인이 부족해요 (판돈 ' + bet + ')' });
        rooms.set(code, { code, difficulty, mode, bet, listed: !!body.listed, players: [p], status: 'waiting', updated: Date.now(), last: { seq: 0 } });
        return json(res, 200, { code, pid: p.id });
      }
      if (action === 'join') {
        const room = rooms.get(String(body.code || '').toUpperCase().trim());
        const nick = authNick;
        if (!room) return json(res, 404, { error: '해당 코드의 방이 없어요' });
        if (room.players.length >= 2) return json(res, 400, { error: '이미 두 명이 있는 방이에요' });
        if (room.players[0].nick === nick) return json(res, 400, { error: '상대와 같은 닉네임이에요. 바꿔 주세요' });
        const lack = betCheck(room, nick);
        if (lack) return json(res, 400, { error: lack === nick ? '코인이 부족해요 (판돈 ' + room.bet + ')' : '방장의 코인이 부족해서 시작할 수 없어요' });
        const p = newPlayer(2, nick);
        room.players.push(p);
        startGame(room);
        return json(res, 200, { code: room.code, pid: p.id });
      }

      if (action === 'match') {
        const nick = authNick;
        if (coinsOf(nick) < MATCH_FEE) return json(res, 400, { error: '코인이 부족해요 (참가비 ' + MATCH_FEE + ')' });
        const t = Date.now();
        for (const room of rooms.values()) {
          const host = room.players[0];
          if (room.isPublic && room.status === 'waiting' && room.players.length === 1 && host.nick !== nick && !betCheck(room, nick) &&
              (host.connected || t - room.updated < 5000)) {
            const p = newPlayer(2, nick);
            room.players.push(p);
            startGame(room);
            return json(res, 200, { code: room.code, pid: p.id, matched: true });
          }
        }
        const code = makeCode();
        const p = newPlayer(1, nick);
        rooms.set(code, { code, difficulty: 'normal', mode: 'race', isPublic: true, bet: MATCH_FEE, fixed: true, players: [p], status: 'waiting', updated: t, last: { seq: 0 } });
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
        if (room.players.every((x) => x.rematch)) {
          if (room.bet > 0 && betCheck(room)) {
            room.players.forEach((x) => (x.rematch = false)); broadcast(room);
            return json(res, 400, { error: '코인이 부족해서 재대결할 수 없어요' });
          }
          startGame(room);
        } else broadcast(room);
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
  for (const [n, g] of solos) if (now - g.updated > SOLO_KEEP_MS) { solos.delete(n); unpersistSolo(n); }
}, 5000);

initDb().then(() => {
  refundOrphanEscrow(); ensureSeason(); loadSavedSolos();
  setInterval(ensureSeason, 20000).unref();
  server.listen(PORT, '0.0.0.0', () => console.log('스도쿠 듀얼 서버 실행 중: http://localhost:' + PORT));
});
