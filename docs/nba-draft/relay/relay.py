#!/usr/bin/env python3
"""Relay de datos para el asistente de draft (corre en GitHub Actions).

Modos:
  snapshot  Baja liga, draft, jugadores, stats, proyecciones y datos de ESPN y los
            escribe como JSON estático en docs/nba-draft/data/ (la página los lee
            desde su mismo origen, sin CORS).
  live      Durante el draft: cada N segundos baja draft+picks de Sleeper y, si
            cambiaron, los publica en live.json de la rama `nba-live`.

Solo usa la librería estándar. Las URLs base se pueden cambiar por variables de
entorno para pruebas (SLEEPER_BASE, SLEEPER2_BASE, ESPN_SITE, ESPN_WEB).
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SLEEPER = os.environ.get("SLEEPER_BASE", "https://api.sleeper.app/v1")
SLEEPER2 = os.environ.get("SLEEPER2_BASE", "https://api.sleeper.com")
ESPN_SITE = os.environ.get("ESPN_SITE", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba")
ESPN_WEB = os.environ.get("ESPN_WEB", "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba")
UA = "team-ranks-nba-draft/1.0 (+https://github.com/eskenazi2009/team-ranks)"
POS_Q = "position[]=PG&position[]=SG&position[]=SF&position[]=PF&position[]=C&position[]=G&position[]=F"
KEEP = ["player_id", "first_name", "last_name", "team", "position", "fantasy_positions", "status", "active",
        "age", "years_exp", "injury_status", "injury_body_part", "injury_notes", "injury_start_date", "espn_id",
        "search_rank", "number", "height", "weight", "college", "news_updated", "depth_chart_order",
        "depth_chart_position", "birth_date"]
TEAM_ALIAS = {"GSW": "GS", "NOP": "NO", "NYK": "NY", "SAS": "SA", "UTA": "UTAH", "WAS": "WSH", "PHO": "PHX", "BRK": "BKN", "CHO": "CHA"}
SOURCES = []


def log(msg, ok=True):
    line = f"{'✓' if ok else '✗'} {msg}"
    SOURCES.append(line)
    print(line, flush=True)


def get(url, timeout=40, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 400, 403):
                raise
        except Exception as e:  # red, timeout, JSON
            last = e
        time.sleep(1.5 * (i + 1))
    raise last


def try_get(label, url, **kw):
    try:
        j = get(url, **kw)
        log(f"{label}: {url}")
        return j
    except Exception as e:
        log(f"{label}: {e} ({url})", ok=False)
        return None


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


# ---------------- Sleeper ----------------
def resolve_core(username, league_name, season_override=None):
    state = try_get("state/nba", f"{SLEEPER}/state/nba") or {}
    user = get(f"{SLEEPER}/user/{urllib.parse.quote(username)}")
    log(f"usuario {user.get('display_name')} ({user.get('user_id')})")
    y = dt.date.today().year
    seasons = [season_override] if season_override else []
    for s in [state.get("league_season"), state.get("season"), str(y), str(y + 1), str(y - 1)]:
        if s and str(s) not in seasons:
            seasons.append(str(s))
    league = None
    for se in seasons:
        lgs = try_get(f"ligas {se}", f"{SLEEPER}/user/{user['user_id']}/leagues/nba/{se}") or []
        want = league_name.lower().strip()
        hit = next((l for l in lgs if l["name"].lower().strip() == want), None) or \
              next((l for l in lgs if want in l["name"].lower()), None)
        if hit:
            league = hit
            log(f"liga {hit['name']} ({hit['league_id']}) temporada {se}")
            break
        if lgs:
            log(f"temporada {se}: {', '.join(l['name'] for l in lgs)} (ninguna coincide)", ok=False)
    if not league:
        raise SystemExit(f"No se encontró la liga '{league_name}' para {username}")
    lid = league["league_id"]
    users = get(f"{SLEEPER}/league/{lid}/users")
    rosters = get(f"{SLEEPER}/league/{lid}/rosters")
    drafts = get(f"{SLEEPER}/league/{lid}/drafts") or []
    if not drafts:
        raise SystemExit("La liga no tiene draft creado todavía")
    dmeta = sorted(drafts, key=lambda d: d.get("start_time") or 0, reverse=True)[0]
    draft = get(f"{SLEEPER}/draft/{dmeta['draft_id']}")
    traded = try_get("traded_picks", f"{SLEEPER}/draft/{dmeta['draft_id']}/traded_picks") or []
    picks = try_get("picks", f"{SLEEPER}/draft/{dmeta['draft_id']}/picks") or []
    log(f"draft {draft['draft_id']} estado={draft.get('status')} tipo={draft.get('type')} "
        f"rondas={(draft.get('settings') or {}).get('rounds')} equipos={(draft.get('settings') or {}).get('teams')} "
        f"inicio={draft.get('start_time')}")
    return {"state": state, "user": user, "league": league, "users": users, "rosters": rosters,
            "draft": draft, "traded": traded, "picks": picks}


def fetch_players():
    allp = get(f"{SLEEPER}/players/nba", timeout=120)
    out = {}
    for pid, p in allp.items():
        if not p or not p.get("first_name"):
            continue
        out[pid] = {k: p[k] for k in KEEP if p.get(k) is not None}
    log(f"jugadores {len(out)}")
    return out


def _arr_to_map(arr):
    return {r["player_id"]: r["stats"] for r in arr if r and r.get("player_id") and r.get("stats")}


def fetch_stats_like(kind, season):
    """kind = 'stats' | 'projections'. Devuelve dict player_id -> stats (totales)."""
    j = try_get(f"{kind} {season}", f"{SLEEPER2}/{kind}/nba/{season}?season_type=regular&{POS_Q}&order_by=pts", timeout=90)
    if isinstance(j, list) and len(j) > 10:
        return _arr_to_map(j), "sleeper"
    j = try_get(f"{kind} {season} (legacy)", f"{SLEEPER}/{kind}/nba/regular/{season}", timeout=90)
    if isinstance(j, dict) and len(j) > 10:
        return j, "sleeper-legacy"
    return {}, None


ESPN_MAP = {"gp": "gamesPlayed", "gs": "gamesStarted", "min": "avgMinutes", "pts": "avgPoints", "reb": "avgRebounds",
            "oreb": "avgOffensiveRebounds", "dreb": "avgDefensiveRebounds", "ast": "avgAssists", "stl": "avgSteals",
            "blk": "avgBlocks", "to": "avgTurnovers", "fgm": "avgFieldGoalsMade", "fga": "avgFieldGoalsAttempted",
            "ftm": "avgFreeThrowsMade", "fta": "avgFreeThrowsAttempted", "tpm": "avgThreePointFieldGoalsMade",
            "tpa": "avgThreePointFieldGoalsAttempted", "dd": "doubleDouble", "td": "tripleDouble", "pf": "avgFouls"}


def fetch_espn_bulk_stats(season, players):
    """Respaldo: promedios de ESPN -> totales, mapeados a player_id de Sleeper por espn_id."""
    espn_season = int(season) + 1
    by_espn = {str(p["espn_id"]): pid for pid, p in players.items() if p.get("espn_id")}
    out = {}
    for page in range(1, 5):
        j = try_get(f"ESPN byathlete p{page}", f"{ESPN_WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=350&page={page}&season={espn_season}&seasontype=2")
        if not j:
            break
        cats = j.get("categories") or []
        for a in j.get("athletes") or []:
            vals = {}
            for i, c in enumerate(a.get("categories") or []):
                names = (cats[i] if i < len(cats) else {}).get("names") or []
                for k, v in enumerate(c.get("values") or []):
                    if k < len(names):
                        try:
                            vals[names[k]] = float(v)
                        except (TypeError, ValueError):
                            pass
            pid = by_espn.get(str((a.get("athlete") or {}).get("id")))
            if not pid:
                continue
            gp = vals.get("gamesPlayed") or 0
            st = {}
            for k, n in ESPN_MAP.items():
                if n in vals:
                    st[k] = vals[n] if k in ("gp", "gs", "dd", "td") else vals[n] * gp
            out[pid] = st
        if len(j.get("athletes") or []) < 350:
            break
    log(f"ESPN stats {espn_season}: {len(out)} jugadores", ok=len(out) > 0)
    return out


import unicodedata, re as _re

def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = _re.sub(r"[^a-z ]", " ", s.lower())
    s = _re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", " ", s)
    return " ".join(s.split())


def link_espn_ids(players, rosters_by_team, teams):
    """Asigna espn_id a los jugadores de Sleeper cruzando nombre (y equipo si hay empate)."""
    by_name = {}
    for tid, rows in rosters_by_team.items():
        abbr = next((a for a, t in teams.items() if t["id"] == tid), None)
        for a in rows:
            by_name.setdefault(norm_name(a.get("displayName")), []).append((a["id"], abbr))
    alias = {v: k for k, v in TEAM_ALIAS.items()}  # ESPN abbr -> Sleeper abbr
    n = 0
    for p in players.values():
        if p.get("espn_id"):
            continue
        cands = by_name.get(norm_name(f"{p.get('first_name','')} {p.get('last_name','')}")) or []
        if len(cands) > 1 and p.get("team"):
            same = [c for c in cands if c[1] and (alias.get(c[1], c[1]) == p["team"] or c[1] == p["team"])]
            if same:
                cands = same
        if cands:
            p["espn_id"] = int(cands[0][0]) if str(cands[0][0]).isdigit() else cands[0][0]
            n += 1
    log(f"espn_id asignados por nombre: {n}")
    return n


# ---------------- ESPN extra (noticias, lesiones, rosters, historial) ----------------
def fetch_espn_bundle(players, top_n=250, workers=8):
    bundle = {"generated_at": now_iso(), "teams": {}, "injuries": {}, "rosters": {}, "news": [], "athletes": {}}
    tj = try_get("ESPN teams", f"{ESPN_SITE}/teams?limit=40")
    teams = []
    try:
        teams = [t["team"] for t in tj["sports"][0]["leagues"][0]["teams"]]
    except Exception:
        pass
    for t in teams:
        bundle["teams"][t.get("abbreviation")] = {"id": str(t.get("id")), "displayName": t.get("displayName")}
    ij = try_get("ESPN injuries", f"{ESPN_SITE}/injuries")
    if isinstance(ij, dict):
        first = ((ij.get("injuries") or [None])[0])
        log(f"ESPN injuries: claves={list(ij.keys())} equipos={len(ij.get('injuries') or [])} primero={list(first.keys()) if isinstance(first, dict) else first}")
    for t in (ij or {}).get("injuries") or []:
        for inj in t.get("injuries") or []:
            aid = str((inj.get("athlete") or {}).get("id") or "")
            if not aid:
                continue
            det = inj.get("details") or {}
            bundle["injuries"][aid] = {"status": inj.get("status"), "type": det.get("type"), "detail": det.get("detail") or inj.get("shortComment") or inj.get("longComment") or "",
                                       "returnDate": det.get("returnDate"), "date": inj.get("date"), "team": t.get("displayName")}
    nj = try_get("ESPN news", f"{ESPN_SITE}/news?limit=100")
    for a in (nj or {}).get("articles") or []:
        ath = []
        for c in a.get("categories") or []:
            if c.get("athleteId"):
                ath.append(str(c["athleteId"]))
        bundle["news"].append({"headline": a.get("headline"), "description": a.get("description"), "published": a.get("published"),
                               "href": ((a.get("links") or {}).get("web") or {}).get("href"), "athletes": ath,
                               "teams": [str(c.get("teamId")) for c in (a.get("categories") or []) if c.get("teamId")]})

    def roster(t):
        rj = try_get(f"ESPN roster {t.get('abbreviation')}", f"{ESPN_SITE}/teams/{t['id']}/roster")
        rows = []
        for a in (rj or {}).get("athletes") or []:
            rows.append({"id": str(a.get("id")), "displayName": a.get("displayName"), "position": (a.get("position") or {}).get("abbreviation"),
                         "age": a.get("age"), "exp": (a.get("experience") or {}).get("years"), "jersey": a.get("jersey"),
                         "injuries": [x.get("status") for x in (a.get("injuries") or []) if x.get("status")]})
        return str(t["id"]), rows


    def athlete(p):
        eid = str(p["espn_id"])
        out = {}
        ov = try_get(f"ESPN overview {p.get('last_name')}", f"{ESPN_WEB}/athletes/{eid}/overview")
        if ov:
            out["news"] = [{"headline": n.get("headline"), "description": n.get("description"), "published": n.get("published"),
                            "href": ((n.get("links") or {}).get("web") or {}).get("href")} for n in (ov.get("news") or [])[:10]]
        sj = try_get(f"ESPN stats {p.get('last_name')}", f"{ESPN_WEB}/athletes/{eid}/stats")
        if sj:
            cat = next((c for c in sj.get("categories") or [] if "averag" in (c.get("name") or "").lower()), None) or ((sj.get("categories") or [None])[0])
            if cat:
                out["seasons"] = {"labels": cat.get("labels"), "rows": [{"season": (r.get("season") or {}).get("displayName") or (r.get("season") or {}).get("year"),
                                                                        "team": (r.get("teamSlug") or "").upper()[:3], "stats": r.get("stats")} for r in (cat.get("statistics") or [])[-8:]]}
        return eid, out

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for tid, rows in ex.map(roster, teams):
            bundle["rosters"][tid] = rows
    link_espn_ids(players, bundle["rosters"], bundle["teams"])
    ranked = sorted((p for p in players.values() if p.get("espn_id") and p.get("team")),
                    key=lambda p: p.get("search_rank") or 9_999_999)[:top_n]
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for eid, out in ex.map(athlete, ranked):
            if out:
                bundle["athletes"][eid] = out
    log(f"ESPN bundle: {len(bundle['rosters'])} rosters, {len(bundle['injuries'])} lesiones, {len(bundle['news'])} noticias, {len(bundle['athletes'])} fichas")
    return bundle


# ---------------- git ----------------
def sh(cmd, cwd=None, check=True):
    print("$", cmd, flush=True)
    return subprocess.run(cmd, shell=True, cwd=cwd, check=check, text=True, capture_output=True)


def git_commit_push(repo_dir, paths, message, branch, retries=5):
    sh('git config user.name "nba-draft-relay"', repo_dir)
    sh('git config user.email "nba-draft-relay@users.noreply.github.com"', repo_dir)
    sh("git add -A -- " + " ".join(f'"{p}"' for p in paths), repo_dir)
    if sh("git diff --cached --quiet", repo_dir, check=False).returncode == 0:
        print("sin cambios", flush=True)
        return False
    sh(f'git commit -q -m "{message}"', repo_dir)
    for i in range(retries):
        r = sh(f"git push -q origin HEAD:{branch}", repo_dir, check=False)
        if r.returncode == 0:
            return True
        print("push rechazado, rebase:", r.stderr.strip()[-300:], flush=True)
        sh(f"git fetch -q origin {branch}", repo_dir, check=False)
        sh(f"git rebase -q origin/{branch} || (git rebase --abort; git reset --hard origin/{branch})", repo_dir, check=False)
        time.sleep(2 + i * 2)
    return False


# ---------------- modos ----------------
def do_snapshot(args):
    core = resolve_core(args.user, args.league, args.season)
    league = core["league"]
    lg_season = int(league.get("season") or dt.date.today().year)
    prev = str(lg_season - 1)
    players = fetch_players()
    stats, src = fetch_stats_like("stats", prev)
    if not stats:
        stats, src = fetch_espn_bulk_stats(prev, players), "espn"
    proj, _ = fetch_stats_like("projections", str(lg_season))
    out = args.out
    if not args.skip_espn:
        write_json(f"{out}/espn.json", fetch_espn_bundle(players, top_n=args.top_n))
    elif os.path.exists(f"{out}/players.json"):
        # conserva los espn_id ya asignados en un snapshot anterior
        try:
            prev_players = json.load(open(f"{out}/players.json", encoding="utf-8"))
            for pid, pp in prev_players.items():
                if pp.get("espn_id") and pid in players and not players[pid].get("espn_id"):
                    players[pid]["espn_id"] = pp["espn_id"]
        except Exception as e:
            log(f"no pude reutilizar espn_id previos: {e}", ok=False)
    write_json(f"{out}/players.json", players)
    write_json(f"{out}/stats.json", stats)
    write_json(f"{out}/proj.json", proj)
    snap = {"generated_at": now_iso(), "statsSeason": prev, "projSeason": str(lg_season), "statsSrc": src,
            **{k: core[k] for k in ("state", "user", "league", "users", "rosters", "draft", "traded", "picks")},
            "sources": SOURCES}
    write_json(f"{out}/snapshot.json", snap)
    write_json(f"{out}/live.json", {"fetched_at": now_iso(), "draft": core["draft"], "picks": core["picks"]})
    print(f"snapshot listo: {len(players)} jugadores, {len(stats)} stats ({src}), {len(proj)} proyecciones, {len(core['picks'])} picks")
    if args.push:
        git_commit_push(args.repo, [out], "chore(nba-draft): refrescar datos del draft [skip ci]", args.push_branch)


def do_live(args):
    core = resolve_core(args.user, args.league, args.season)
    did = core["draft"]["draft_id"]
    live_dir = args.live_dir
    os.makedirs(live_dir, exist_ok=True)
    end = time.time() + args.minutes * 60
    last_key = None
    while True:
        try:
            d = get(f"{SLEEPER}/draft/{did}", timeout=20)
            p = get(f"{SLEEPER}/draft/{did}/picks", timeout=20) or []
            key = (len(p), d.get("status"), d.get("last_picked"))
            if key != last_key:
                write_json(f"{live_dir}/live.json", {"fetched_at": now_iso(), "draft": d, "picks": p})
                git_commit_push(live_dir, ["live.json"], f"live: {len(p)} picks, {d.get('status')}", "nba-live")
                last_key = key
                print(f"{now_iso()} picks={len(p)} estado={d.get('status')}", flush=True)
            if d.get("status") == "complete":
                print("draft completo, fin")
                break
        except Exception as e:
            print("error en ciclo:", e, flush=True)
        if time.time() > end:
            print("tiempo agotado, fin")
            break
        time.sleep(args.interval)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["snapshot", "live"])
    ap.add_argument("--user", default="raymondesk")
    ap.add_argument("--league", default="Benchwarmers")
    ap.add_argument("--season", default=None)
    ap.add_argument("--out", default="docs/nba-draft/data")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--push-branch", default="main")
    ap.add_argument("--skip-espn", action="store_true")
    ap.add_argument("--top-n", type=int, default=250)
    ap.add_argument("--live-dir", default="live")
    ap.add_argument("--minutes", type=int, default=240)
    ap.add_argument("--interval", type=int, default=15)
    args = ap.parse_args()
    (do_snapshot if args.mode == "snapshot" else do_live)(args)


if __name__ == "__main__":
    main()
