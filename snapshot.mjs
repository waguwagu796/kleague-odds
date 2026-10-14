// 오늘 데이터로 확률을 계산해 data/history.json에 하루치 기록을 추가한다 (GitHub Actions용).
// 페이지와 같은 엔진(engine.js)과 같은 시드를 써서, 페이지에 보이는 숫자와 똑같은 값을 남긴다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "data");
const read = name => JSON.parse(readFileSync(join(dataDir, name), "utf8"));

const src = readFileSync(join(here, "engine.js"), "utf8");
const E = new Function(src + "\nreturn { simulateCurrent, hashStr };")();

const k1 = read("k1.json"), k2 = read("k2.json");
const N = 50000;
// 페이지의 defaultSeed()와 같은 식
const seed = E.hashStr(k1.asOf + "|" + k1.results.length + "|" + k2.results.length + "|" + JSON.stringify(k1.injuries || []) + JSON.stringify(k2.injuries || []));
const sim = E.simulateCurrent(k1, k2, N, seed);

const ZONES = { k1: ["champ", "acle", "finalA", "po"], k2: ["champ", "auto", "poIn", "promo"] };
const pack = lg => {
  const o = {};
  for (const [team, v] of Object.entries(sim[lg])) {
    o[team] = { exp: Math.round(v.exp * 10) / 10 };
    for (const z of ZONES[lg]) o[team][z] = Math.round(v[z] / N * 1000) / 10;
  }
  return o;
};

const histPath = join(dataDir, "history.json");
const history = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8")) : [];
const entry = { asOf: k1.asOf, N, k1: pack("k1"), k2: pack("k2") };
const kept = history.filter(h => h.asOf !== entry.asOf);
kept.push(entry);
kept.sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
writeFileSync(histPath, JSON.stringify(kept));

const top = lg => Object.entries(entry[lg]).sort((a, b) => b[1].champ - a[1].champ)[0];
console.log(`${entry.asOf} 기록 완료 (${kept.length}일치). K리그1 우승 1순위 ${top("k1")[0]} ${top("k1")[1].champ}%, K리그2 ${top("k2")[0]} ${top("k2")[1].champ}%`);
