// K리그 확률 엔진. 페이지(kleague-odds.html)의 <script id="engine-src">에 그대로 들어간다.
// 이 파일을 고친 뒤에는 build.py로 페이지에 다시 넣는다.

// halfLife·prior는 2025·2026시즌 K리그1·2 742경기 백테스트(경기 전 데이터만으로 예측)에서 고른 값.
// 격자 탐색(halfLife 45~무한대 × prior 2~12)에서 로그 손실 1.0659로 최저권, 기준선(리그 승·무·패 비율) 1.1024.
// halfLife 180~365일은 차이가 0.0001 이내라 최근 흐름을 조금 더 보는 180을 골랐다.
const PARAMS = {
  halfLife: 180,      // 경기 가중치가 절반이 되는 기간(일). 최근 경기를 더 크게 본다
  prior: 8,           // 리그 평균 쪽으로 당기는 가상 경기 수
  injuryPenalty: 0.03,
  injuryCap: 0.12,
  crossLeague: 0.85,  // 승강 플레이오프에서 K리그2 팀 득점 기대값 배율 (가정)
  crossTieK2: 0.45,   // 승강 플레이오프 합계 동점 시 K리그2 팀이 이길 확률 (가정)
};

const DAY = 86400000;
function toMs(d) { return Date.parse(d + "T00:00:00Z"); }
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function poissonDraw(l, rnd) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
function gauss(rnd) { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pois(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

/* ---------- 전력 추정 ----------
   득점 기대값 = 리그 평균 × 홈/원정 배율 × 내 공격력 × 상대 수비력.
   공격력·수비력은 상대 전력을 감안해 반복 계산으로 맞추고(강팀 상대로 넣은 골은 더 높게 평가),
   경기마다 오래될수록 가중치를 줄여 최근 흐름을 반영한다. */
function fitModel(teams, matches, asOf, P, injuries) {
  const ref = toMs(asOf);
  const ms = matches.map(m => ({ h: m[2], a: m[3], hs: m[4], as: m[5], w: Math.pow(0.5, Math.max(0, (ref - toMs(m[0])) / DAY) / P.halfLife) }));
  let hg = 0, ag = 0;
  ms.forEach(m => { hg += m.hs; ag += m.as; });
  const home = ms.length ? Math.sqrt((hg + 10) / (ag + 10)) : 1.08, away = 1 / home;
  let mu = ms.length ? (hg + ag) / (2 * ms.length) : 1.3;
  const R = {};
  teams.forEach(t => R[t] = { att: 1, def: 1 });
  let nA, dA, nD, dD;
  for (let it = 0; it < 40; it++) {
    nA = {}; dA = {}; nD = {}; dD = {};
    teams.forEach(t => { nA[t] = dA[t] = nD[t] = dD[t] = 0; });
    const eh = mu * home, ea = mu * away;
    for (const m of ms) {
      nA[m.h] += m.w * m.hs; dA[m.h] += m.w * eh * R[m.a].def;
      nA[m.a] += m.w * m.as; dA[m.a] += m.w * ea * R[m.h].def;
      nD[m.h] += m.w * m.as; dD[m.h] += m.w * ea * R[m.a].att;
      nD[m.a] += m.w * m.hs; dD[m.a] += m.w * eh * R[m.h].att;
    }
    const k = P.prior * mu;
    teams.forEach(t => { R[t].att = (nA[t] + k) / (dA[t] + k); R[t].def = (nD[t] + k) / (dD[t] + k); });
    const ma = teams.reduce((s, t) => s + R[t].att, 0) / teams.length;
    const md = teams.reduce((s, t) => s + R[t].def, 0) / teams.length;
    teams.forEach(t => { R[t].att /= ma; R[t].def /= md; });
    let num = 0, den = 0;
    for (const m of ms) { num += m.w * (m.hs + m.as); den += m.w * (home * R[m.h].att * R[m.a].def + away * R[m.a].att * R[m.h].def); }
    if (den > 0) mu = num / den;
  }
  // 전력 추정의 불확실성(로그 척도 표준오차): 근거가 된 골 수가 적을수록 크다
  const k = P.prior * mu;
  teams.forEach(t => {
    R[t].seA = 1 / Math.sqrt(nA[t] + k);
    R[t].seD = 1 / Math.sqrt(nD[t] + k);
    const inj = (injuries || []).filter(x => x.team === t).length;
    R[t].inj = inj;
    if (inj) R[t].att *= 1 - Math.min(P.injuryCap, inj * P.injuryPenalty);
  });
  // 무승부 보정 계수(Dixon-Coles rho): 모델의 무승부 수가 실제 무승부 수와 같아지도록 맞춘다
  let rho = 0;
  if (ms.length >= 30) {
    const pairs = ms.map(m => [mu * home * R[m.h].att * R[m.a].def, mu * away * R[m.a].att * R[m.h].def]);
    const draws = ms.filter(m => m.hs === m.as).length;
    rho = fitRho(pairs, draws);
  }
  return { R, mu, home, away, rho };
}

function drawProb(l, m, rho) {
  let s = 0;
  for (let k = 0; k <= 10; k++) s += pois(k, l) * pois(k, m);
  return s - 2 * rho * l * m * Math.exp(-l - m);
}
function fitRho(pairs, draws) {
  const maxL = Math.max(1, ...pairs.map(p => Math.max(p[0], p[1])));
  let lo = Math.max(-0.4, -1 / maxL + 1e-3), hi = 0.25;
  const f = r => pairs.reduce((s, p) => s + drawProb(p[0], p[1], r), 0) - draws;
  if (f(lo) <= 0) return lo;
  if (f(hi) >= 0) return hi;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function tau(x, y, l, m, rho) {
  if (x === 0 && y === 0) return 1 - l * m * rho;
  if (x === 0 && y === 1) return 1 + l * rho;
  if (x === 1 && y === 0) return 1 + m * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}
function matchProbs(l, m, rho) {
  let pH = 0, pD = 0, pA = 0;
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) {
    const p = pois(x, l) * pois(y, m) * tau(x, y, l, m, rho);
    if (x > y) pH += p; else if (x === y) pD += p; else pA += p;
  }
  const s = pH + pD + pA;
  return [pH / s, pD / s, pA / s];
}
// Dixon-Coles 분포에서 점수 뽑기 (독립 포아송 + 기각 표본추출)
function sampleScore(l, m, rho, rnd) {
  const tmax = Math.max(1, 1 - l * m * rho, 1 - rho, 1 + l * rho, 1 + m * rho);
  for (;;) {
    const x = poissonDraw(l, rnd), y = poissonDraw(m, rnd);
    if (rnd() * tmax <= tau(x, y, l, m, rho)) return [x, y];
  }
}

/* ---------- 리그 상태 ---------- */
// results 행: [날짜, 라운드, 홈, 원정, 홈득점, 원정득점, 단계], fixtures 행: [날짜, 라운드, 홈, 원정, 단계]
function makeCtx(doc, P, opt) {
  opt = opt || {};
  const teams = doc.standings.map(s => s.team);
  const n = teams.length, ix = {};
  teams.forEach((t, i) => ix[t] = i);
  const all = doc.results.filter(r => r[6] !== "P");
  const known = opt.cutoff ? all.filter(r => r[0] < opt.cutoff) : all;
  const split = doc.format && doc.format.split;
  let regFix, finFix;
  if (opt.cutoff) {
    const later = all.filter(r => r[0] >= opt.cutoff);
    regFix = later.filter(r => !r[6] && (!split || r[1] <= split.after)).map(r => [ix[r[2]], ix[r[3]]]);
    finFix = [];
  } else {
    // 일정 행: [홈, 원정, 경기 키, 고정 결과(-1 = 시뮬레이션), 추적 번호(-1 = 추적 안 함)]
    const row = f => [ix[f[2]], ix[f[3]], f[0] + "|" + f[2] + "|" + f[3], -1, -1];
    regFix = (doc.fixtures || []).filter(f => !f[4]).map(row);
    finFix = (doc.fixtures || []).filter(f => f[4]).map(row);
  }
  const asOf = opt.cutoff || doc.asOf;
  const model = fitModel(teams, known, asOf, P, opt.cutoff ? [] : doc.injuries);
  const pts = new Int32Array(n), gf = new Int32Array(n), ga = new Int32Array(n), w = new Int32Array(n), hc = new Int32Array(n);
  const h2h = new Int32Array(n * n);
  known.forEach(r => applyRes(ix[r[2]], ix[r[3]], r[4], r[5], n, pts, gf, ga, w, h2h));
  known.forEach(r => hc[ix[r[2]]]++);
  regFix.forEach(f => hc[f[0]]++);
  let groupA = null;
  const aTeams = new Set();
  known.filter(r => r[6] === "A").forEach(r => { aTeams.add(ix[r[2]]); aTeams.add(ix[r[3]]); });
  (opt.cutoff ? [] : (doc.fixtures || [])).filter(f => f[4] === "A").forEach(f => { aTeams.add(ix[f[2]]); aTeams.add(ix[f[3]]); });
  if (aTeams.size) groupA = aTeams;
  return {
    teams, n, ix, split, regFix, finFix, groupA, pts, gf, ga, w, h2h, hc,
    att: teams.map(t => model.R[t].att), def: teams.map(t => model.R[t].def),
    seA: teams.map(t => model.R[t].seA), seD: teams.map(t => model.R[t].seD),
    inj: teams.map(t => model.R[t].inj),
    mu: model.mu, home: model.home, away: model.away, rho: model.rho,
    noPlayoff: doc.format && doc.format.noPlayoffTeam != null ? ix[doc.format.noPlayoffTeam] : -1,
  };
}
function applyRes(h, a, hs, as, n, pts, gf, ga, w, h2h) {
  gf[h] += hs; ga[h] += as; gf[a] += as; ga[a] += hs;
  if (hs > as) { pts[h] += 3; w[h]++; h2h[h * n + a] += 3; }
  else if (hs < as) { pts[a] += 3; w[a]++; h2h[a * n + h] += 3; }
  else { pts[h]++; pts[a]++; h2h[h * n + a]++; h2h[a * n + h]++; }
}
// 순위: 승점 → 다득점 → 득실차 → 다승 → 승자승(동률 팀끼리 승점) → 추첨(벌점 정보 없음)
function sortIdx(list, n, pts, gf, ga, w, h2h, rnd) {
  const arr = list.slice();
  const k4 = (a, b) => pts[b] - pts[a] || gf[b] - gf[a] || (gf[b] - ga[b]) - (gf[a] - ga[a]) || w[b] - w[a];
  arr.sort(k4);
  const out = [];
  for (let i = 0; i < arr.length;) {
    let j = i + 1;
    while (j < arr.length && k4(arr[i], arr[j]) === 0) j++;
    if (j - i === 1) out.push(arr[i]);
    else {
      const grp = arr.slice(i, j), mp = {}, rk = {};
      grp.forEach(x => { mp[x] = 0; rk[x] = rnd ? rnd() : x; grp.forEach(y => { if (x !== y) mp[x] += h2h[x * n + y]; }); });
      grp.sort((a, b) => mp[b] - mp[a] || rk[a] - rk[b]);
      out.push(...grp);
    }
    i = j;
  }
  return out;
}

// 0 = 홈 승, 1 = 무승부, 2 = 원정 승
const outcomeOf = (x, y) => x > y ? 0 : x === y ? 1 : 2;

// outBuf가 있으면 추적 중인 경기의 결과를 그 자리에 적는다
function simOnce(c, rnd, outBuf) {
  const n = c.n;
  const pts = c.pts.slice(), gf = c.gf.slice(), ga = c.ga.slice(), w = c.w.slice(), h2h = c.h2h.slice();
  const att = new Float64Array(n), def = new Float64Array(n);
  for (let i = 0; i < n; i++) { att[i] = c.att[i] * Math.exp(c.seA[i] * gauss(rnd)); def[i] = c.def[i] * Math.exp(c.seD[i] * gauss(rnd)); }
  const play = (h, a, forced, ti) => {
    const l = c.mu * c.home * att[h] * def[a], m = c.mu * c.away * att[a] * def[h];
    let [x, y] = sampleScore(l, m, c.rho, rnd);
    // 결과를 정해 둔 경기: 그 결과가 나올 때까지 점수를 다시 뽑는다(점수 분포는 그 결과 안에서 자연스럽게 유지)
    if (forced >= 0) for (let k = 0; outcomeOf(x, y) !== forced; k++) {
      if (k > 500) { x = forced === 0 ? 1 : 0; y = forced === 2 ? 1 : 0; break; }
      [x, y] = sampleScore(l, m, c.rho, rnd);
    }
    if (ti >= 0 && outBuf) outBuf[ti] = outcomeOf(x, y);
    applyRes(h, a, x, y, n, pts, gf, ga, w, h2h);
  };
  for (const f of c.regFix) play(f[0], f[1], f[3] ?? -1, f[4] ?? -1);
  const all = [...Array(n).keys()];
  let order;
  if (c.split && !c.groupA) {
    // 파이널 라운드: 같은 그룹끼리 한 번씩. 홈은 시즌 홈 경기가 적은 팀(같으면 추첨)
    const first = sortIdx(all, n, pts, gf, ga, w, h2h, rnd);
    const gA = first.slice(0, c.split.size), gB = first.slice(c.split.size);
    const hc = c.hc.slice();
    for (const g of [gA, gB]) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      let h = g[i], a = g[j];
      if (hc[a] < hc[h] || (hc[a] === hc[h] && rnd() < 0.5)) { h = g[j]; a = g[i]; }
      hc[h]++; play(h, a, -1, -1);
    }
    order = sortIdx(gA, n, pts, gf, ga, w, h2h, rnd).concat(sortIdx(gB, n, pts, gf, ga, w, h2h, rnd));
  } else if (c.split && c.groupA) {
    for (const f of c.finFix) play(f[0], f[1], f[3] ?? -1, f[4] ?? -1);
    const gA = all.filter(i => c.groupA.has(i)), gB = all.filter(i => !c.groupA.has(i));
    order = sortIdx(gA, n, pts, gf, ga, w, h2h, rnd).concat(sortIdx(gB, n, pts, gf, ga, w, h2h, rnd));
  } else {
    order = sortIdx(all, n, pts, gf, ga, w, h2h, rnd);
  }
  return { order, pts, att, def };
}

/* ---------- 현재 시즌: 두 리그를 함께 시뮬레이션 ---------- */
// opts.forced = { k1: { 경기키: 0|1|2 }, k2: {...} }: 결과를 정해 두고 시뮬레이션 ("만약에")
// opts.track = { k1: [경기키...], k2: [...] }: 그 경기 결과별로 팀 확률을 따로 센다 (빅매치)
const ZONE_KEYS = { k1: ["champ", "acle", "finalA", "po"], k2: ["champ", "auto", "top6", "promo"] };
function prepFix(c, forced, track) {
  const ti = {};
  (track || []).forEach((k, i) => ti[k] = i);
  for (const f of c.regFix.concat(c.finFix)) {
    f[3] = forced && forced[f[2]] != null ? forced[f[2]] : -1;
    f[4] = ti[f[2]] ?? -1;
  }
}
function simulateCurrent(d1, d2, N, seed, onProgress, opts) {
  opts = opts || {};
  const P = PARAMS, rnd = mulberry32(seed);
  const c1 = makeCtx(d1, P), c2 = makeCtx(d2, P);
  const tr1 = (opts.track && opts.track.k1) || [], tr2 = (opts.track && opts.track.k2) || [];
  prepFix(c1, opts.forced && opts.forced.k1, tr1);
  prepFix(c2, opts.forced && opts.forced.k2, tr2);
  const ob1 = new Int8Array(tr1.length), ob2 = new Int8Array(tr2.length);
  const hit1 = new Uint8Array(c1.n * 4), hit2 = new Uint8Array(c2.n * 4);
  const T1 = { n: new Float64Array(tr1.length * 3), z: new Float64Array(tr1.length * 3 * c1.n * 4) };
  const T2 = { n: new Float64Array(tr2.length * 3), z: new Float64Array(tr2.length * 3 * c2.n * 4) };
  const tally = (T, ob, hit) => {
    const m = hit.length;
    for (let j = 0; j < ob.length; j++) {
      const o = ob[j];
      if (o < 0) continue;
      T.n[j * 3 + o]++;
      const base = (j * 3 + o) * m;
      for (let i = 0; i < m; i++) if (hit[i]) T.z[base + i]++;
    }
  };
  const z = n => ({ posDist: new Float64Array(n * n), ptsSum: new Float64Array(n) });
  const o1 = Object.assign(z(c1.n), { champ: new Float64Array(c1.n), acle: new Float64Array(c1.n), finalA: new Float64Array(c1.n), po: new Float64Array(c1.n), relegated: new Float64Array(c1.n) });
  const o2 = Object.assign(z(c2.n), { champ: new Float64Array(c2.n), auto: new Float64Array(c2.n), top6: new Float64Array(c2.n), promo: new Float64Array(c2.n) });
  const muX = Math.sqrt(c1.mu * c2.mu), rhoX = (c1.rho + c2.rho) / 2;
  for (let s = 0; s < N; s++) {
    ob1.fill(-1); ob2.fill(-1); hit1.fill(0); hit2.fill(0);
    const s1 = simOnce(c1, rnd, ob1), s2 = simOnce(c2, rnd, ob2);
    s1.order.forEach((t, i) => {
      o1.posDist[t * c1.n + i]++; o1.ptsSum[t] += s1.pts[t];
      if (i === 0) { o1.champ[t]++; hit1[t * 4] = 1; }
      if (i < 2) { o1.acle[t]++; hit1[t * 4 + 1] = 1; }
      if (i < 6) { o1.finalA[t]++; hit1[t * 4 + 2] = 1; }
    });
    s2.order.forEach((t, i) => {
      o2.posDist[t * c2.n + i]++; o2.ptsSum[t] += s2.pts[t];
      if (i === 0) { o2.champ[t]++; hit2[t * 4] = 1; }
      if (i < 2) { o2.auto[t]++; o2.promo[t]++; hit2[t * 4 + 1] = 1; hit2[t * 4 + 3] = 1; }
      if (i < 6) { o2.top6[t]++; hit2[t * 4 + 2] = 1; }
    });
    // K리그2 플레이오프: 단판, 상위 팀 홈, 무승부면 상위 팀
    const tie = (hi, lo) => { const [a, b] = sampleScore(c2.mu * c2.home * s2.att[hi] * s2.def[lo], c2.mu * c2.away * s2.att[lo] * s2.def[hi], c2.rho, rnd); return a >= b ? hi : lo; };
    const sd = s2.order;
    const w1 = tie(sd[2], sd[5]), w2 = tie(sd[3], sd[4]);
    const hi = sd.indexOf(w1) < sd.indexOf(w2) ? w1 : w2, lo = hi === w1 ? w2 : w1;
    const champ = tie(hi, lo), runner = champ === hi ? lo : hi;
    o2.promo[champ]++; hit2[champ * 4 + 3] = 1;
    // 승강 플레이오프: K리그1 12위(예외 팀 제외) vs K리그2 PO 준우승, 2경기 합산
    const last = s1.order[c1.n - 1];
    if (last !== c1.noPlayoff) {
      o1.po[last]++; hit1[last * 4 + 3] = 1;
      const [a1, b1] = sampleScore(muX * c2.home * s2.att[runner] * s1.def[last] * P.crossLeague, muX * c2.away * s1.att[last] * s2.def[runner], rhoX, rnd);
      const [a2, b2] = sampleScore(muX * c1.home * s1.att[last] * s2.def[runner], muX * c1.away * s2.att[runner] * s1.def[last] * P.crossLeague, rhoX, rnd);
      const k2g = a1 + b2, k1g = b1 + a2;
      if (k2g > k1g || (k2g === k1g && rnd() < P.crossTieK2)) { o2.promo[runner]++; hit2[runner * 4 + 3] = 1; o1.relegated[last]++; }
    }
    tally(T1, ob1, hit1); tally(T2, ob2, hit2);
    if (onProgress && (s + 1) % 2000 === 0) onProgress(s + 1);
  }
  const pack = (c, o, keys) => {
    const out = {};
    c.teams.forEach((t, i) => {
      out[t] = { posDist: Array.from(o.posDist.slice(i * c.n, (i + 1) * c.n)), exp: o.ptsSum[i] / N };
      keys.forEach(k => out[t][k] = o[k][i]);
    });
    return out;
  };
  // 추적 경기: 결과별 횟수 n[홈승, 무, 원정승]과, 그 결과일 때 팀별 구간 달성 횟수 z[팀][구간] = [홈승, 무, 원정승]
  const packTrack = (c, T, tr, keys) => tr.map((key, j) => {
    const zz = {};
    c.teams.forEach((t, i) => {
      zz[t] = {};
      keys.forEach((k, q) => zz[t][k] = [0, 1, 2].map(o => T.z[(j * 3 + o) * c.n * 4 + i * 4 + q]));
    });
    return { key, n: [0, 1, 2].map(o => T.n[j * 3 + o]), z: zz };
  });
  return {
    N, seed,
    k1: pack(c1, o1, ["champ", "acle", "finalA", "po", "relegated"]),
    k2: pack(c2, o2, ["champ", "auto", "top6", "promo"]),
    model: { k1: modelInfo(c1), k2: modelInfo(c2) },
    track: { k1: packTrack(c1, T1, tr1, ZONE_KEYS.k1), k2: packTrack(c2, T2, tr2, ZONE_KEYS.k2) },
  };
}
function modelInfo(c) {
  const r = {};
  c.teams.forEach((t, i) => r[t] = { att: c.att[i], def: c.def[i] });
  return { mu: c.mu, home: c.home, rho: c.rho, R: r };
}

/* ---------- 백테스트 ---------- */
// 지난 시즌을 cutoff 날짜 시점에서 시뮬레이션하고 실제 최종 순위와 비교
function backtestSeason(doc, cutoff, N, seed) {
  const P = PARAMS, rnd = mulberry32(seed);
  const c = makeCtx(doc, P, { cutoff });
  const posDist = new Float64Array(c.n * c.n);
  for (let s = 0; s < N; s++) simOnce(c, rnd).order.forEach((t, i) => posDist[t * c.n + i]++);
  // 실제 최종 순위
  const n = c.n, pts = new Int32Array(n), gf = new Int32Array(n), ga = new Int32Array(n), w = new Int32Array(n), h2h = new Int32Array(n * n);
  const all = doc.results.filter(r => r[6] !== "P");
  all.forEach(r => applyRes(c.ix[r[2]], c.ix[r[3]], r[4], r[5], n, pts, gf, ga, w, h2h));
  const aSet = new Set();
  all.filter(r => r[6] === "A").forEach(r => { aSet.add(c.ix[r[2]]); aSet.add(c.ix[r[3]]); });
  const idx = [...Array(n).keys()];
  const actual = aSet.size
    ? sortIdx(idx.filter(i => aSet.has(i)), n, pts, gf, ga, w, h2h, null).concat(sortIdx(idx.filter(i => !aSet.has(i)), n, pts, gf, ga, w, h2h, null))
    : sortIdx(idx, n, pts, gf, ga, w, h2h, null);
  const atCut = sortIdx(idx, n, c.pts, c.gf, c.ga, c.w, c.h2h, null);
  return {
    teams: c.teams, cutoff, N,
    posDist: c.teams.map((_, i) => Array.from(posDist.slice(i * n, (i + 1) * n)).map(v => v / N)),
    actualRank: c.teams.map((_, i) => actual.indexOf(i) + 1),
    cutRank: c.teams.map((_, i) => atCut.indexOf(i) + 1),
    cutPts: Array.from(c.pts),
    remaining: c.regFix.length,
  };
}

// 경기 단위 검증: 각 경기일마다 그 전 경기만으로 전력을 다시 맞춰 승·무·패 확률을 예측
function evalMatches(docs, P) {
  const tot = { n: 0, ll: 0, llBase: 0, br: 0, brBase: 0, dPred: 0, dAct: 0, hPred: 0, hAct: 0, buckets: [0, 0, 0, 0, 0].map(() => ({ p: 0, o: 0, n: 0 })) };
  const per = [];
  for (const doc of docs) {
    const teams = doc.standings.map(s => s.team);
    const res = doc.results.filter(r => r[6] !== "P").slice().sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const dates = [...new Set(res.map(r => r[0]))];
    const st = { n: 0, ll: 0, llBase: 0 };
    let p0 = 0;
    for (const D of dates) {
      while (p0 < res.length && res[p0][0] < D) p0++;
      const prior = res.slice(0, p0);
      if (prior.length < teams.length * 3) continue;
      const m = fitModel(teams, prior, D, P, []);
      let bh = 1, bd = 1, ba = 1;
      prior.forEach(r => { if (r[4] > r[5]) bh++; else if (r[4] === r[5]) bd++; else ba++; });
      const bs = bh + bd + ba, base = [bh / bs, bd / bs, ba / bs];
      for (const r of res.filter(x => x[0] === D)) {
        const l = m.mu * m.home * m.R[r[2]].att * m.R[r[3]].def, mm = m.mu * m.away * m.R[r[3]].att * m.R[r[2]].def;
        const p = matchProbs(l, mm, m.rho);
        const o = r[4] > r[5] ? 0 : r[4] === r[5] ? 1 : 2;
        const ll = -Math.log(Math.max(1e-9, p[o])), llb = -Math.log(base[o]);
        let br = 0, brb = 0;
        for (let k = 0; k < 3; k++) { br += (p[k] - (k === o)) ** 2; brb += (base[k] - (k === o)) ** 2; }
        tot.n++; tot.ll += ll; tot.llBase += llb; tot.br += br; tot.brBase += brb;
        tot.dPred += p[1]; tot.dAct += o === 1; tot.hPred += p[0]; tot.hAct += o === 0;
        const b = tot.buckets[Math.min(4, Math.floor(p[0] * 5))]; b.p += p[0]; b.o += o === 0; b.n++;
        st.n++; st.ll += ll; st.llBase += llb;
      }
    }
    per.push({ league: doc.league, season: doc.season, n: st.n, ll: st.ll / st.n, llBase: st.llBase / st.n });
  }
  return { per, n: tot.n, ll: tot.ll / tot.n, llBase: tot.llBase / tot.n, br: tot.br / tot.n, brBase: tot.brBase / tot.n,
    drawPred: tot.dPred / tot.n, drawAct: tot.dAct / tot.n, homePred: tot.hPred / tot.n, homeAct: tot.hAct / tot.n,
    buckets: tot.buckets.map(b => ({ n: b.n, pred: b.n ? b.p / b.n : 0, act: b.n ? b.o / b.n : 0 })) };
}

// 워커에서 실행될 때의 메시지 처리
if (typeof self !== "undefined" && typeof window === "undefined") {
  self.onmessage = e => {
    const m = e.data;
    try {
      if (m.type === "current") {
        const r = simulateCurrent(m.d1, m.d2, m.N, m.seed, done => self.postMessage({ type: "progress", id: m.id, done }), m.opts);
        self.postMessage({ type: "current", id: m.id, result: r });
      } else if (m.type === "backtest") {
        const matches = evalMatches(m.docs, PARAMS);
        const seasons = m.seasons.map(s => Object.assign({ league: s.doc.league, season: s.doc.season }, backtestSeason(s.doc, s.cutoff, m.N, m.seed)));
        self.postMessage({ type: "backtest", id: m.id, result: { matches, seasons } });
      }
    } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String(err && err.stack || err) });
    }
  };
}
