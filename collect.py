"""K리그 확률 페이지용 데이터 수집기.

Daum 스포츠 일정 API에서 시즌 전체 경기를 받아 페이지 DB 문서 형식(JSON)으로 저장한다.

사용법:
  py -X utf8 collect.py                 # 현재 시즌(k1.json, k2.json)을 out/에 저장
  py -X utf8 collect.py --history 2025  # 백테스트용 지난 시즌(k1-2025.json, k2-2025.json) 저장

  py -X utf8 collect.py --out data      # 저장 폴더 지정 (GitHub Actions용)

부상자 정보는 저장 폴더의 injuries.json 이 있으면 그대로 합친다.
형식: {"k1": [{"team","player","note","source"}], "k2": [...]}
"""
import argparse
import calendar
import datetime as dt
import json
import os
import sys
import urllib.request

API = "https://sports.daum.net/api/arms/SPORTS_SCHEDULE?leagueCode={lc}&fromDate={f}&toDate={t}&seasonKey={y}"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
KST = dt.timezone(dt.timedelta(hours=9))

# 시즌별 대회 형식. 페이지 시뮬레이션이 이 값을 그대로 쓴다.
FORMATS = {
    ("k1", 2026): {"teams": 12, "split": {"after": 33, "size": 6}, "noPlayoffTeam": "김천",
                   "zones": "k1-2026"},
    ("k2", 2026): {"teams": 17, "gamesPerTeam": 32, "zones": "k2-2026"},
    ("k1", 2025): {"teams": 12, "split": {"after": 33, "size": 6}, "zones": "k1-2025"},
    ("k2", 2025): {"teams": 14, "gamesPerTeam": 39, "zones": "k2-2025"},
}
LEAGUE_CODE = {"k1": "kl", "k2": "kl2"}


def fetch_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://sports.daum.net/schedule/kl"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch_season(league, year):
    lc = LEAGUE_CODE[league]
    games, seen = [], set()
    for m in range(1, 13):
        last = calendar.monthrange(year, m)[1]
        d = fetch_json(API.format(lc=lc, f=f"{year}{m:02d}01", t=f"{year}{m:02d}{last}", y=year))
        for day in (d.get("document") or {}).get("schedule", {}).values():
            for g in day:
                if g["gameId"] in seen:
                    continue
                seen.add(g["gameId"])
                games.append(g)
    games.sort(key=lambda g: (g["startDate"], g.get("startTime") or ""))
    return games


def stage_of(g):
    name = ((g.get("gameDetailType") or {}).get("nameKo")) or ""
    if "라운드A" in name:
        return "A"
    if "라운드B" in name:
        return "B"
    if "플레이오프" in name:
        return "P"
    return ""


def iso(d):
    return f"{d[:4]}-{d[4:6]}-{d[6:]}"


def standings_from(results, teams):
    """결과로 순위표를 만든다. 동률은 다득점, 득실차, 다승, 승자승 순."""
    t = {x: {"team": x, "p": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "pts": 0} for x in teams}
    h2h = {}
    for date, rnd, h, a, hs, as_, st in results:
        if st == "P":
            continue
        H, A = t[h], t[a]
        H["p"] += 1; A["p"] += 1
        H["gf"] += hs; H["ga"] += as_; A["gf"] += as_; A["ga"] += hs
        if hs > as_:
            H["w"] += 1; A["l"] += 1; H["pts"] += 3; h2h[(h, a)] = h2h.get((h, a), 0) + 3
        elif hs < as_:
            A["w"] += 1; H["l"] += 1; A["pts"] += 3; h2h[(a, h)] = h2h.get((a, h), 0) + 3
        else:
            H["d"] += 1; A["d"] += 1; H["pts"] += 1; A["pts"] += 1
            h2h[(h, a)] = h2h.get((h, a), 0) + 1; h2h[(a, h)] = h2h.get((a, h), 0) + 1
    rows = list(t.values())
    key = lambda r: (r["pts"], r["gf"], r["gf"] - r["ga"], r["w"])
    rows.sort(key=key, reverse=True)
    # 같은 키끼리 승자승(미니 리그 승점)으로 다시 정렬
    out, i = [], 0
    while i < len(rows):
        j = i
        while j < len(rows) and key(rows[j]) == key(rows[i]):
            j += 1
        grp = rows[i:j]
        if len(grp) > 1:
            names = {r["team"] for r in grp}
            grp.sort(key=lambda r: sum(h2h.get((r["team"], o), 0) for o in names if o != r["team"]), reverse=True)
        out.extend(grp)
        i = j
    for n, r in enumerate(out, 1):
        r["rank"] = n
    return out


def build(league, year, games, as_of, injuries=None):
    teams = sorted({g["homeTeamName"] for g in games} | {g["awayTeamName"] for g in games})
    results, fixtures = [], []
    for g in games:
        st = stage_of(g)
        if st == "P":
            continue  # 리그 플레이오프는 시뮬레이션이 직접 만든다
        row = [iso(g["startDate"]), g.get("roundSeq"), g["homeTeamName"], g["awayTeamName"]]
        if g.get("gameStatus") == "END" and g.get("homeResult") not in (None, ""):
            results.append(row + [int(g["homeResult"]), int(g["awayResult"]), st])
        elif g.get("gameStatus") != "CANCEL":
            fixtures.append(row + [st])  # 경기 전·연기 경기 포함
    fmt = FORMATS[(league, year)]
    if len(teams) != fmt["teams"]:
        raise SystemExit(f"{league} {year}: 팀 수 {len(teams)} (기대 {fmt['teams']})")
    doc = {
        "league": league,
        "season": year,
        "asOf": as_of,
        "updatedAt": dt.datetime.now(KST).isoformat(timespec="seconds"),
        "source": f"Daum 스포츠 {('K리그1' if league == 'k1' else 'K리그2')} 일정·결과 (sports.daum.net)",
        "format": fmt,
        "standings": standings_from(results, teams),
        # [날짜, 라운드, 홈, 원정, 홈득점, 원정득점, 단계("", "A", "B")]
        "results": results,
        # [날짜, 라운드, 홈, 원정, 단계]
        "fixtures": fixtures,
        "injuries": injuries or [],
        "note": "",
    }
    return doc


def check_current(doc):
    """현재 시즌 데이터가 말이 되는지 검사한다."""
    fmt = doc["format"]
    problems = []
    for r in doc["standings"]:
        if r["pts"] != 3 * r["w"] + r["d"] or r["p"] != r["w"] + r["d"] + r["l"]:
            problems.append(f"{r['team']} 승점 계산 불일치")
    left = {r["team"]: 0 for r in doc["standings"]}
    for f in doc["fixtures"]:
        left[f[2]] += 1; left[f[3]] += 1
    played = {r["team"]: r["p"] for r in doc["standings"]}
    total = fmt.get("gamesPerTeam") or (fmt["split"]["after"] if not any(f[4] for f in doc["fixtures"])
                                        and not any(x[6] for x in doc["results"]) else 38)
    for team in left:
        if played[team] + left[team] != total:
            problems.append(f"{team}: 치른 {played[team]} + 남은 {left[team]} != {total}")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", type=int, help="지난 시즌 연도 (백테스트용)")
    ap.add_argument("--season", type=int, default=dt.datetime.now(KST).year)
    ap.add_argument("--out", default=OUT, help="저장 폴더 (기본: out/, GitHub Actions에서는 data/)")
    args = ap.parse_args()
    out_dir = os.path.join(HERE, args.out) if not os.path.isabs(args.out) else args.out
    os.makedirs(out_dir, exist_ok=True)
    today = dt.datetime.now(KST).date().isoformat()

    if args.history:
        for lg in ("k1", "k2"):
            games = fetch_season(lg, args.history)
            doc = build(lg, args.history, games, f"{args.history}-12-31")
            # 지난 시즌은 결과만 쓴다 (남은 경기 없음)
            path = os.path.join(out_dir, f"{lg}-{args.history}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
            print(f"{path}: {len(doc['results'])}경기")
        return

    inj_path = os.path.join(out_dir, "injuries.json")
    injuries = {}
    if os.path.exists(inj_path):
        with open(inj_path, encoding="utf-8") as f:
            injuries = json.load(f)
    failed = False
    for lg in ("k1", "k2"):
        games = fetch_season(lg, args.season)
        doc = build(lg, args.season, games, today, injuries.get(lg))
        problems = check_current(doc)
        if problems:
            failed = True
            doc["note"] = "데이터 검사에서 문제가 발견됐어요: " + "; ".join(problems[:3])
            print(f"[{lg}] 문제: {problems}", file=sys.stderr)
        path = os.path.join(out_dir, f"{lg}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        top = doc["standings"][0]
        print(f"{path}: 결과 {len(doc['results'])} / 남은 {len(doc['fixtures'])} / 1위 {top['team']} {top['pts']}점")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
