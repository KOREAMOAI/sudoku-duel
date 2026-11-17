'use strict';
// 사람이 쓰는 풀이 기법으로 스도쿠를 푸는 솔버.
// - 난이도 판정: 퍼즐을 풀 때 꼭 필요했던 가장 어려운 기법의 단계(tier)
// - 설명형 힌트: 지금 판에서 다음으로 둘 수 있는 칸과 그 이유
// tier 1: 싱글 / 2: 포인팅·박스-라인 / 3: 페어·트리플 / 4: 물고기·윙·단일 숫자 패턴

const ROW = (i) => Math.floor(i / 9), COL = (i) => i % 9, BOX = (i) => Math.floor(ROW(i) / 3) * 3 + Math.floor(COL(i) / 3);
const UNITS = []; // 0~8 행, 9~17 열, 18~26 박스
for (let r = 0; r < 9; r++) UNITS.push([...Array(9)].map((_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push([...Array(9)].map((_, r) => r * 9 + c));
for (let b = 0; b < 9; b++) { const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3, u = []; for (let k = 0; k < 9; k++) u.push((br + Math.floor(k / 3)) * 9 + bc + (k % 3)); UNITS.push(u); }
const PEERS = [...Array(81)].map((_, i) => { const s = new Set(); for (const u of [ROW(i), 9 + COL(i), 18 + BOX(i)]) UNITS[u].forEach((k) => k !== i && s.add(k)); return [...s]; });
const SEES = (a, b) => a !== b && (ROW(a) === ROW(b) || COL(a) === COL(b) || BOX(a) === BOX(b));
const BIT = (v) => 1 << v, POP = (m) => { let n = 0; while (m) { m &= m - 1; n++; } return n; };
const DIGS = (m) => { const o = []; for (let v = 1; v <= 9; v++) if (m & BIT(v)) o.push(v); return o; };
const ALL = 0b1111111110;

const RC = (i) => (ROW(i) + 1) + '행 ' + (COL(i) + 1) + '열';
const UNAME = (u) => (u < 9 ? (u + 1) + '행' : u < 18 ? (u - 8) + '열' : (u - 17) + '번 박스');
// 받침에 맞는 조사 (숫자는 일·이·삼… 읽는 소리 기준)
const NUMB = { 1: 1, 3: 1, 6: 1, 7: 1, 8: 1, 0: 1, 2: 0, 4: 0, 5: 0, 9: 0 };
function J(w, a, b) {
  const t = String(w), ch = t[t.length - 1];
  if (/[0-9]/.test(ch)) return t + (NUMB[ch] ? a : b);
  const code = ch.charCodeAt(0) - 0xac00;
  return t + (code >= 0 && code < 11172 && code % 28 ? a : b);
}
const TECH = {
  nsingle: { tier: 1, name: '네이키드 싱글' }, hsingle: { tier: 1, name: '히든 싱글' },
  pointing: { tier: 2, name: '포인팅' }, claiming: { tier: 2, name: '박스-라인 리덕션' },
  npair: { tier: 3, name: '네이키드 페어' }, ntriple: { tier: 3, name: '네이키드 트리플' },
  hpair: { tier: 3, name: '히든 페어' }, htriple: { tier: 3, name: '히든 트리플' },
  xwing: { tier: 4, name: 'X-윙' }, swordfish: { tier: 4, name: '스워드피시' },
  skyscraper: { tier: 4, name: '스카이스크래퍼' }, kite: { tier: 4, name: '투 스트링 카이트' }, turbot: { tier: 4, name: '터봇 피시' },
  xywing: { tier: 4, name: 'XY-윙' }, xyzwing: { tier: 4, name: 'XYZ-윙' },
};

function makeState(grid) {
  const g = grid.slice(), c = new Array(81).fill(0);
  for (let i = 0; i < 81; i++) if (!g[i]) { let m = ALL; for (const k of PEERS[i]) if (g[k]) m &= ~BIT(g[k]); c[i] = m; }
  return { g, c };
}
function place(s, i, v) { s.g[i] = v; s.c[i] = 0; for (const k of PEERS[i]) s.c[k] &= ~BIT(v); }
// 지울 후보가 실제로 있을 때만 단계로 인정
function elim(s, list) { const out = []; for (const [i, v] of list) if (s.c[i] & BIT(v)) out.push([i, v]); return out; }
function applyElims(s, list) { for (const [i, v] of list) s.c[i] &= ~BIT(v); }
const where = (s, u, v) => UNITS[u].filter((k) => s.c[k] & BIT(v));

/* ---------- tier 1 ---------- */
function findSingle(s, prefer) {
  const ns = (i) => s.c[i] && POP(s.c[i]) === 1 ? { tech: 'nsingle', i, v: DIGS(s.c[i])[0], area: PEERS[i].filter((k) => s.g[k]) } : null;
  const hs = (i) => {
    if (!s.c[i]) return null;
    for (const u of [18 + BOX(i), ROW(i), 9 + COL(i)]) for (const v of DIGS(s.c[i])) { const w = where(s, u, v); if (w.length === 1) return { tech: 'hsingle', i, v, unit: u, area: UNITS[u] }; }
    return null;
  };
  if (prefer >= 0) { const r = hs(prefer) || ns(prefer); if (r) return r; }
  for (let u = 0; u < 27; u++) for (let v = 1; v <= 9; v++) { const w = where(s, u, v); if (w.length === 1) return { tech: 'hsingle', i: w[0], v, unit: u, area: UNITS[u] }; }
  for (let i = 0; i < 81; i++) { const r = ns(i); if (r) return r; }
  return null;
}
/* ---------- tier 2 ---------- */
function findLocked(s) {
  for (let b = 18; b < 27; b++) for (let v = 1; v <= 9; v++) {
    const w = where(s, b, v); if (w.length < 2) continue;
    for (const [same, line] of [[ROW, (x) => x], [COL, (x) => 9 + x]]) {
      if (w.every((k) => same(k) === same(w[0]))) {
        const e = elim(s, UNITS[line(same(w[0]))].filter((k) => BOX(k) !== b - 18).map((k) => [k, v]));
        if (e.length) return { tech: 'pointing', v, cells: w, elims: e, text: (b - 17) + '번 박스의 ' + J(v, '은', '는') + ' ' + UNAME(line(same(w[0]))) + '에만 있어서, 그 줄의 다른 칸에서 ' + J(v, '을', '를') + ' 지울 수 있어요' };
      }
    }
  }
  for (let u = 0; u < 18; u++) for (let v = 1; v <= 9; v++) {
    const w = where(s, u, v); if (w.length < 2 || !w.every((k) => BOX(k) === BOX(w[0]))) continue;
    const e = elim(s, UNITS[18 + BOX(w[0])].filter((k) => !w.includes(k)).map((k) => [k, v]));
    if (e.length) return { tech: 'claiming', v, cells: w, elims: e, text: UNAME(u) + '의 ' + J(v, '은', '는') + ' ' + (BOX(w[0]) + 1) + '번 박스 안에만 있어서, 그 박스의 다른 칸에서 ' + J(v, '을', '를') + ' 지울 수 있어요' };
  }
  return null;
}
/* ---------- tier 3 ---------- */
function combos(arr, k, start = 0, pre = [], out = []) {
  if (pre.length === k) { out.push(pre.slice()); return out; }
  for (let x = start; x < arr.length; x++) { pre.push(arr[x]); combos(arr, k, x + 1, pre, out); pre.pop(); }
  return out;
}
function findSubset(s) {
  for (const k of [2, 3]) {
    for (let u = 0; u < 27; u++) { // 네이키드
      const open = UNITS[u].filter((i) => s.c[i] && POP(s.c[i]) <= k);
      for (const cs of combos(open, k)) {
        const m = cs.reduce((a, i) => a | s.c[i], 0); if (POP(m) !== k) continue;
        const e = elim(s, UNITS[u].filter((i) => !cs.includes(i)).flatMap((i) => DIGS(m).map((v) => [i, v])));
        if (e.length) return { tech: k === 2 ? 'npair' : 'ntriple', cells: cs, elims: e, text: cs.map(RC).join(', ') + '에는 ' + DIGS(m).join('·') + '만 들어가요. 그래서 ' + UNAME(u) + '의 다른 칸에서 이 숫자들을 지울 수 있어요' };
      }
    }
    for (let u = 0; u < 27; u++) { // 히든
      const ds = []; for (let v = 1; v <= 9; v++) { const n = where(s, u, v).length; if (n >= 1 && n <= k) ds.push(v); }
      for (const dset of combos(ds, k)) {
        const cs = [...new Set(dset.flatMap((v) => where(s, u, v)))]; if (cs.length !== k) continue;
        const keep = dset.reduce((a, v) => a | BIT(v), 0);
        const e = elim(s, cs.flatMap((i) => DIGS(s.c[i] & ~keep).map((v) => [i, v])));
        if (e.length) return { tech: k === 2 ? 'hpair' : 'htriple', cells: cs, elims: e, text: UNAME(u) + '에서 ' + J(dset.join('·'), '은', '는') + ' ' + cs.map(RC).join(', ') + '에만 들어갈 수 있어요. 그래서 이 칸들의 다른 후보를 지울 수 있어요' };
      }
    }
  }
  return null;
}
/* ---------- tier 4 ---------- */
function findFish(s) {
  for (const n of [2, 3]) for (let v = 1; v <= 9; v++) for (const byRow of [true, false]) {
    const base = [...Array(9)].map((_, x) => (byRow ? x : 9 + x)).filter((u) => { const w = where(s, u, v).length; return w >= 2 && w <= n; });
    for (const us of combos(base, n)) {
      const cover = new Set(us.flatMap((u) => where(s, u, v).map(byRow ? COL : ROW))); if (cover.size !== n) continue;
      const cells = us.flatMap((u) => where(s, u, v));
      const e = elim(s, [...cover].flatMap((x) => UNITS[byRow ? 9 + x : x]).filter((i) => !cells.includes(i)).map((i) => [i, v]));
      if (e.length) return { tech: n === 2 ? 'xwing' : 'swordfish', v, cells, elims: e, text: us.map(UNAME).join('·') + '에서 ' + J(v, '이', '가') + ' 들어갈 자리가 ' + [...cover].map((x) => (x + 1) + (byRow ? '열' : '행')).join('·') + '에만 있어요. 그래서 그 ' + (byRow ? '열' : '행') + '들의 다른 칸에서 ' + J(v, '을', '를') + ' 지울 수 있어요' };
    }
  }
  return null;
}
function findTurbot(s) { // 강한 연결 두 개가 약한 연결로 이어진 단일 숫자 패턴 (스카이스크래퍼·카이트·터봇)
  for (let v = 1; v <= 9; v++) {
    const links = [];
    for (let u = 0; u < 27; u++) { const w = where(s, u, v); if (w.length === 2) links.push({ u, a: w[0], b: w[1] }); }
    for (let x = 0; x < links.length; x++) for (let y = x + 1; y < links.length; y++) {
      const A = links[x], B = links[y];
      for (const [a1, a2] of [[A.a, A.b], [A.b, A.a]]) for (const [b1, b2] of [[B.a, B.b], [B.b, B.a]]) {
        if (new Set([a1, a2, b1, b2]).size < 4 || !SEES(a2, b1)) continue;
        const e = elim(s, PEERS[a1].filter((i) => SEES(i, b2) && i !== b2 && i !== a2 && i !== b1).map((i) => [i, v]));
        if (!e.length) continue;
        const rowcol = (u) => (u < 9 ? 'r' : u < 18 ? 'c' : 'b'), t = rowcol(A.u) + rowcol(B.u);
        const tech = t === 'rr' || t === 'cc' ? 'skyscraper' : t === 'rc' || t === 'cr' ? 'kite' : 'turbot';
        return { tech, v, cells: [a1, a2, b1, b2], elims: e, text: J(v, '은', '는') + ' ' + J(UNAME(A.u), '과', '와') + ' ' + UNAME(B.u) + '에서 두 칸에만 들어가요. 두 줄이 이어져 있어서 ' + RC(a1) + ' 또는 ' + RC(b2) + ' 중 하나는 반드시 ' + J(v, '이에요', '예요') + '. 그래서 둘 다 보는 칸에서 ' + J(v, '을', '를') + ' 지울 수 있어요' };
      }
    }
  }
  return null;
}
function findWing(s) {
  const bi = [...Array(81).keys()].filter((i) => POP(s.c[i]) === 2);
  for (const p of bi) { // XY-윙
    const [x, y] = DIGS(s.c[p]); const ws = bi.filter((k) => SEES(k, p));
    for (const w1 of ws) for (const w2 of ws) {
      if (w1 >= w2) continue;
      const m1 = s.c[w1], m2 = s.c[w2];
      for (const [a, b] of [[x, y], [y, x]]) {
        if (!(m1 & BIT(a)) || (m1 & BIT(b)) || !(m2 & BIT(b)) || (m2 & BIT(a))) continue;
        const z1 = m1 & ~BIT(a), z2 = m2 & ~BIT(b); if (z1 !== z2) continue; const z = DIGS(z1)[0];
        const e = elim(s, PEERS[w1].filter((i) => SEES(i, w2) && i !== p).map((i) => [i, z]));
        if (e.length) return { tech: 'xywing', v: z, cells: [p, w1, w2], elims: e, text: RC(p) + '(' + x + '·' + y + ')가 어느 쪽이든 ' + RC(w1) + ' 또는 ' + RC(w2) + ' 중 하나는 ' + z + '가 돼요. 그래서 두 칸을 모두 보는 칸에서 ' + J(z, '을', '를') + ' 지울 수 있어요' };
      }
    }
  }
  for (let p = 0; p < 81; p++) { // XYZ-윙
    if (POP(s.c[p]) !== 3) continue;
    const ws = bi.filter((k) => SEES(k, p) && (s.c[k] & ~s.c[p]) === 0);
    for (const w1 of ws) for (const w2 of ws) {
      if (w1 >= w2 || s.c[w1] === s.c[w2]) continue;
      const zm = s.c[w1] & s.c[w2]; if (POP(zm) !== 1) continue; const z = DIGS(zm)[0];
      const e = elim(s, PEERS[p].filter((i) => SEES(i, w1) && SEES(i, w2)).map((i) => [i, z]));
      if (e.length) return { tech: 'xyzwing', v: z, cells: [p, w1, w2], elims: e, text: RC(p) + '·' + RC(w1) + '·' + RC(w2) + ' 세 칸 중 하나는 반드시 ' + J(z, '이에요', '예요') + '. 그래서 세 칸을 모두 보는 칸에서 ' + J(z, '을', '를') + ' 지울 수 있어요' };
    }
  }
  return null;
}
const FINDERS = [[2, findLocked], [3, findSubset], [4, findFish], [4, findTurbot], [4, findWing]];

// 한 단계: 둘 수 있는 칸이 있으면 두고, 없으면 maxTier 안의 가장 쉬운 소거를 적용
function step(s, maxTier, prefer = -1) {
  const one = findSingle(s, prefer);
  if (one) { place(s, one.i, one.v); return one; }
  for (const [t, f] of FINDERS) { if (t > maxTier) break; const r = f(s); if (r) { applyElims(s, r.elims); return r; } }
  return null;
}
function valid(s) { for (let i = 0; i < 81; i++) if (!s.g[i] && !s.c[i]) return false; return true; }

// 퍼즐 채점: 풀리면 사용한 최고 단계(tier)를, 못 풀면 null
function rate(puzzle, maxTier = 4) {
  const s = makeState(puzzle); let top = 1;
  for (let n = 0; n < 2000; n++) {
    if (!s.g.includes(0)) return { tier: top };
    if (!valid(s)) return null;
    const r = step(s, maxTier); if (!r) return null;
    top = Math.max(top, TECH[r.tech].tier);
  }
  return null;
}

// 설명형 힌트: grid(맞게 채운 칸만)에서 다음으로 둘 수 있는 칸을 찾고 이유를 붙여요
function explainNext(grid, solution, prefer = -1) {
  const s = makeState(grid), pre = [];
  for (let n = 0; n < 300; n++) {
    const one = findSingle(s, prefer);
    if (one) {
      if (solution && solution[one.i] !== one.v) break;
      const base = one.tech === 'hsingle'
        ? UNAME(one.unit) + '에서 ' + J(one.v, '이', '가') + ' 들어갈 수 있는 칸은 ' + RC(one.i) + '뿐이에요'
        : RC(one.i) + '에는 ' + one.v + '만 들어갈 수 있어요. 같은 행·열·박스에 다른 숫자가 모두 있거나 지워졌어요';
      const last = pre[pre.length - 1];
      const tech = last && TECH[last.tech].tier > 1 ? last.tech : one.tech;
      const text = (pre.length > 1 ? '몇 가지 후보를 지운 뒤, 마지막으로 ' : pre.length ? '먼저 ' : '') + (pre.length ? TECH[last.tech].name + ': ' + last.text + '. 그러면 ' : '') + base + '.';
      return { i: one.i, v: one.v, tech, name: TECH[tech].name, tier: TECH[tech].tier, text, area: one.area || [], cells: last ? last.cells : [], elimCells: last ? [...new Set(last.elims.map((e) => e[0]))] : [] };
    }
    let found = null;
    for (const [, f] of FINDERS) { const r = f(s); if (r) { found = r; break; } }
    if (!found) break;
    applyElims(s, found.elims); pre.push(found);
  }
  return null; // 이 기법들로는 다음 칸을 찾지 못함 (호출한 쪽에서 정답 공개로 대체)
}

module.exports = { rate, explainNext, TECH, makeState, step };

/* ---------- 난이도별 퍼즐 생성 ---------- */
const crypto = require('crypto');
const rnd = (n) => crypto.randomInt(n);
const shuf = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// 해의 개수 세기 (limit개까지) — 비트마스크 백트래킹
function countSolutions(grid, limit = 2) {
  const s = makeState(grid); let n = 0;
  (function go() {
    if (n >= limit) return;
    let best = -1, bc = 10;
    for (let i = 0; i < 81; i++) if (!s.g[i]) { const p = POP(s.c[i]); if (p === 0) return; if (p < bc) { bc = p; best = i; if (p === 1) break; } }
    if (best < 0) { n++; return; }
    for (const v of DIGS(s.c[best])) {
      const g0 = s.g.slice(), c0 = s.c.slice();
      place(s, best, v); go(); s.g = g0; s.c = c0;
      if (n >= limit) return;
    }
  })();
  return n;
}
function fullGrid() {
  const g = new Array(81).fill(0);
  (function fill(i) {
    if (i === 81) return true;
    for (const v of shuf([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      let ok = true; for (const k of PEERS[i]) if (g[k] === v) { ok = false; break; }
      if (!ok) continue; g[i] = v; if (fill(i + 1)) return true; g[i] = 0;
    }
    return false;
  })(0);
  return g;
}
// minTier: 꼭 한 번은 필요한 단계, maxTier: 넘으면 안 되는 단계, stop: 주어진 칸이 이 수 이하가 되면 그만 지움
const LEVELS = {
  beginner: { minTier: 1, maxTier: 1, stop: 45 },
  easy: { minTier: 1, maxTier: 1, stop: 32 },
  normal: { minTier: 2, maxTier: 2, stop: 24 },
  hard: { minTier: 3, maxTier: 3, stop: 22 },
  expert: { minTier: 4, maxTier: 4, stop: 20 },
};
function tryLevel(level) {
  const L = LEVELS[level] || LEVELS.normal;
  const solution = fullGrid(), puzzle = solution.slice(); let givens = 81, tier = 1;
  for (const i of shuf([...Array(81).keys()])) {
    if (givens <= L.stop) break;
    const v = puzzle[i]; puzzle[i] = 0;
    const r = countSolutions(puzzle, 2) === 1 && rate(puzzle, L.maxTier);
    if (r) { givens--; tier = r.tier; } else puzzle[i] = v;
  }
  return tier >= L.minTier ? { solution, puzzle, tier } : null;
}
function genLevel(level, tries = 60) {
  for (let k = 0; k < tries; k++) { const r = tryLevel(level); if (r) return r; }
  return null;
}
module.exports.genLevel = genLevel; module.exports.tryLevel = tryLevel; module.exports.countSolutions = countSolutions; module.exports.LEVELS = LEVELS;
