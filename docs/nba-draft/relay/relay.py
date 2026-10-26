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
def _split_made(v):
    """'9-18' -> (9, 18)"""
    try:
        a, b = str(v).split("-")
        return float(a), float(b)
    except Exception:
        return None, None


def parse_gamelog(gl):
    """Devuelve la lista de juegos de temporada regular: [fecha, rival, min, pts, reb, ast, stl, blk, to, tpm, fgm, fga, ftm, fta]."""
    labels = gl.get("labels") or []
    idx = {l: i for i, l in enumerate(labels)}
    events = gl.get("events") or {}
    games = []
    for st in gl.get("seasonTypes") or []:
        if "regular" not in (st.get("displayName") or "").lower():
            continue
        for cat in st.get("categories") or []:
            for ev in cat.get("events") or []:
                stats = ev.get("stats") or []
                def g(label):
                    i = idx.get(label)
                    try:
                        return float(stats[i]) if i is not None and i < len(stats) else None
                    except (TypeError, ValueError):
                        return None
                fgm, fga = _split_made(stats[idx["FG"]]) if "FG" in idx and idx["FG"] < len(stats) else (None, None)
                tpm, tpa = _split_made(stats[idx["3PT"]]) if "3PT" in idx and idx["3PT"] < len(stats) else (None, None)
                ftm, fta = _split_made(stats[idx["FT"]]) if "FT" in idx and idx["FT"] < len(stats) else (None, None)
                meta = events.get(str(ev.get("eventId"))) or {}
                opp = (meta.get("opponent") or {}).get("abbreviation") or ""
                ha = meta.get("homeAway") or ""
                date = (meta.get("gameDate") or "")[:10]
                games.append([date, ("@" if ha == "away" else "vs ") + opp, g("MIN"), g("PTS"), g("REB"), g("AST"), g("STL"), g("BLK"), g("TO"), tpm, fgm, fga, ftm, fta, meta.get("gameResult")])
    games.sort(key=lambda x: x[0])
    return games


def fetch_espn_bundle(players, top_n=250, workers=8, gamelog_season=None):
    bundle = {"generated_at": now_iso(), "teams": {}, "injuries": {}, "rosters": {}, "news": [], "athletes": {}, "gamelog_season": gamelog_season}
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
    shown = False
    for t in (ij or {}).get("injuries") or []:
        for inj in t.get("injuries") or []:
            if not shown:
                log("ESPN injuries ejemplo: " + json.dumps(inj, ensure_ascii=False)[:700])
                shown = True
            ath = inj.get("athlete") or {}
            aid = str(ath.get("id") or "")
            if not aid:
                # ESPN no manda athlete.id aquí; el id va en links[].href (…/player/_/id/5105571/…) o en $ref/uid
                m = _re.search(r"(?:athletes|/id)/(\d+)", json.dumps(ath)) or _re.search(r"a:(\d+)", str(ath.get("uid") or ""))
                aid = m.group(1) if m else ""
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
        gl = try_get(f"ESPN gamelog {p.get('last_name')}", f"{ESPN_WEB}/athletes/{eid}/gamelog?season={gamelog_season}") if gamelog_season else None
        games = parse_gamelog(gl) if gl else []
        used = gamelog_season
        if not games and gamelog_season:
            # no jugó la temporada pasada (lesión, etc.): usar su última temporada con juegos
            for back in (1, 2):
                gl2 = try_get(f"ESPN gamelog {p.get('last_name')} {gamelog_season - back}", f"{ESPN_WEB}/athletes/{eid}/gamelog?season={gamelog_season - back}")
                games = parse_gamelog(gl2) if gl2 else []
                if games:
                    used = gamelog_season - back
                    break
        if games:
            out["games"] = games
            out["games_season"] = used
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


# ---------------- diario: stats y proyecciones por fecha, matchups, calendario ----------------
def _pair(v):
    try:
        a, b = str(v).split("-")
        return float(a), float(b)
    except Exception:
        return None, None


def parse_boxscore(summary, by_espn):
    """Box score de ESPN -> {sleeper_pid: línea}. Mapea por espn_id; si no hay, usa 'espn:<id>'."""
    out = {}
    for tm in ((summary or {}).get("boxscore") or {}).get("players") or []:
        abbr = (tm.get("team") or {}).get("abbreviation")
        for grp in tm.get("statistics") or []:
            labels = grp.get("labels") or []
            ix = {l: i for i, l in enumerate(labels)}
            for a in grp.get("athletes") or []:
                ath = a.get("athlete") or {}
                eid = str(ath.get("id") or "")
                stats = a.get("stats") or []
                def g(label):
                    i = ix.get(label)
                    try:
                        return float(stats[i]) if i is not None and i < len(stats) else None
                    except (TypeError, ValueError):
                        return None
                def pr(label):
                    i = ix.get(label)
                    return _pair(stats[i]) if i is not None and i < len(stats) else (None, None)
                fgm, fga = pr("FG"); tpm, tpa = pr("3PT"); ftm, fta = pr("FT")
                line = {"name": ath.get("displayName"), "team": abbr, "espn_id": eid, "dnp": bool(a.get("didNotPlay")), "reason": a.get("reason"),
                        "starter": bool(a.get("starter")), "min": g("MIN"), "pts": g("PTS"), "reb": g("REB"), "oreb": g("OREB"), "dreb": g("DREB"),
                        "ast": g("AST"), "stl": g("STL"), "blk": g("BLK"), "to": g("TO"), "pf": g("PF"),
                        "tpm": tpm, "tpa": tpa, "fgm": fgm, "fga": fga, "ftm": ftm, "fta": fta}
                pid = by_espn.get(eid)
                out[pid or f"espn:{eid}"] = line
    return out


def fetch_daily(core, season, players=None, days_back=7, days_fwd=9):
    """Stats reales y proyecciones de Sleeper por fecha (ventana alrededor de hoy), matchups de la
    semana en curso y calendario/marcadores de ESPN. Devuelve el dict que se escribe en daily.json."""
    # Nota: Sleeper ignora el parámetro date en stats/projections (devuelve la temporada completa),
    # así que los puntos por partido salen del box score de ESPN y se calculan con la puntuación de la liga.
    by_espn = {str(v["espn_id"]): pid for pid, v in (players or {}).items() if v.get("espn_id")}
    # ESPN usa hora del Este para el día de juego; alineamos "hoy" a esa zona (UTC-4/-5)
    today = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date()
    out = {"generated_at": now_iso(), "season": str(season), "today": today.isoformat(), "days": {}, "matchups": {}, "state": core.get("state")}
    for off in range(-days_back, days_fwd + 1):
        d = (today + dt.timedelta(days=off)).isoformat()
        day = {"games": [], "box": {}}
        sb = try_get(f"ESPN scoreboard {d}", f"{ESPN_SITE}/scoreboard?dates={d.replace('-', '')}")
        for ev in (sb or {}).get("events") or []:
            try:
                comp = ev["competitions"][0]
                cs = {c.get("homeAway"): c for c in comp.get("competitors") or []}
                h, a = cs.get("home", {}), cs.get("away", {})
                day["games"].append({"id": ev.get("id"), "start": ev.get("date"), "state": ((ev.get("status") or {}).get("type") or {}).get("state"),
                                     "detail": ((ev.get("status") or {}).get("type") or {}).get("shortDetail"),
                                     "home": (h.get("team") or {}).get("abbreviation"), "away": (a.get("team") or {}).get("abbreviation"),
                                     "hs": h.get("score"), "as": a.get("score")})
            except Exception:
                pass
        for gm in day["games"]:
            if gm.get("state") in ("in", "post") and gm.get("id"):
                sm = try_get(f"ESPN box {d} {gm['away']}@{gm['home']}", f"{ESPN_SITE}/summary?event={gm['id']}")
                box = parse_boxscore(sm, by_espn) if sm else {}
                for pid, line in box.items():
                    line["game_id"] = gm["id"]; line["final"] = gm.get("state") == "post"
                    line["opp"] = gm["home"] if line.get("team") == gm["away"] else gm["away"]
                    day["box"][pid] = line
        if day["games"]:
            out["days"][d] = day
    st_ = core.get("state") or {}
    weeks = []
    for w in (st_.get("week"), st_.get("display_week"), st_.get("leg")):
        try:
            w = int(w)
        except (TypeError, ValueError):
            continue
        if w >= 1 and w not in weeks:
            weeks.append(w)
    lid = core["league"]["league_id"]
    for w in weeks[:2]:
        m = try_get(f"matchups semana {w}", f"{SLEEPER}/league/{lid}/matchups/{w}")
        if isinstance(m, list):
            out["matchups"][str(w)] = m
    nbox = sum(len(x["box"]) for x in out["days"].values())
    log(f"diario: {len(out['days'])} fechas, {nbox} líneas de box score, matchups semanas {list(out['matchups'])}")
    return out


# ---------------- reporte diario de lesiones ----------------
SEV = {None: 0, "": 0, "probable": 1, "questionable": 2, "dtd": 2, "day-to-day": 2, "gtd": 2, "doubtful": 3, "out": 4, "ir": 4, "ofs": 4, "sus": 4, "suspended": 4}


def sev(status):
    return SEV.get((status or "").strip().lower(), 2 if status else 0)


def league_fp(scoring, line):
    t = 0.0
    for k, w in (scoring or {}).items():
        if not w:
            continue
        v = line.get(k)
        if v is None and k == "fgmi":
            v = max(0.0, float(line.get("fga") or 0) - float(line.get("fgm") or 0))
        if v is None and k == "ftmi":
            v = max(0.0, float(line.get("fta") or 0) - float(line.get("ftm") or 0))
        if v is None and k == "tpmi":
            v = max(0.0, float(line.get("tpa") or 0) - float(line.get("tpm") or 0))
        t += float(w) * float(v or 0)
    return t


def game_fp(scoring, g):
    """g = fila compacta del gamelog de ESPN"""
    d, opp, mn, pts, reb, ast, stl, blk, to, tpm = g[:10]
    n = sum(1 for q in (pts, reb, ast, stl, blk) if (q or 0) >= 10)
    return league_fp(scoring, {"pts": pts or 0, "reb": reb or 0, "ast": ast or 0, "stl": stl or 0, "blk": blk or 0, "to": to or 0, "tpm": tpm or 0, "dd": 1 if n >= 2 else 0, "td": 1 if n >= 3 else 0})


def box_fp(scoring, l):
    n = sum(1 for q in (l.get("pts"), l.get("reb"), l.get("ast"), l.get("stl"), l.get("blk")) if (q or 0) >= 10)
    return league_fp(scoring, {"pts": l.get("pts") or 0, "reb": l.get("reb") or 0, "ast": l.get("ast") or 0, "stl": l.get("stl") or 0, "blk": l.get("blk") or 0, "to": l.get("to") or 0, "tpm": l.get("tpm") or 0, "dd": 1 if n >= 2 else 0, "td": 1 if n >= 3 else 0})


def injury_report(out_dir, core, players, prev_players, bundle, prev_bundle, proj, daily):
    league = core["league"]; scoring = league.get("scoring_settings") or {}
    users = {u["user_id"]: u for u in core.get("users") or []}
    owner_of = {}
    for r in core.get("rosters") or []:
        u = users.get(r.get("owner_id")) or {}
        name = (u.get("metadata") or {}).get("team_name") or u.get("display_name") or f"roster {r.get('roster_id')}"
        for pid in r.get("players") or []:
            owner_of[pid] = name
    inj_now = (bundle or {}).get("injuries") or {}
    inj_prev = (prev_bundle or {}).get("injuries") or {}
    athletes = (bundle or {}).get("athletes") or {}

    def status_of(pl, injmap):
        eid = str(pl.get("espn_id") or "")
        a = injmap.get(eid) or {}
        cands = [(sev(pl.get("injury_status")), pl.get("injury_status"), pl.get("injury_body_part"), None, None),
                 (sev(a.get("status")), a.get("status"), a.get("type"), a.get("returnDate"), a.get("detail"))]
        return max(cands, key=lambda c: c[0])

    def per_game_proj(pid):
        pr = proj.get(pid)
        return league_fp(scoring, pr) if pr else 0.0

    def ceiling(pl):
        a = athletes.get(str(pl.get("espn_id") or "")) or {}
        g = [x for x in (a.get("games") or []) if (x[2] or 0) > 0]
        if len(g) < 10:
            return None
        f = sorted((game_fp(scoring, x) for x in g), reverse=True)
        return {"top5": sum(f[:5]) / 5, "p90": f[int(len(f) * 0.1)], "avg": sum(f) / len(f), "n": len(f)}

    def recent(pid):
        out = []
        for date in sorted((daily or {}).get("days") or {}):
            if date < "2026-10-20":
                continue
            l = daily["days"][date].get("box", {}).get(pid)
            if l and l.get("min"):
                out.append({"date": date[5:], "opp": l.get("opp"), "fp": round(box_fp(scoring, l), 1), "min": round(l["min"]), "starter": bool(l.get("starter"))})
        return out[-4:]

    today = (daily or {}).get("today") or now_iso()[:10]
    try:
        baseline = json.load(open(f"{out_dir}/injury_baseline.json", encoding="utf-8"))
    except Exception:
        baseline = None
    cur_statuses = {}
    for pid, pl in players.items():
        if pl.get("team"):
            cur_statuses[pid] = list(status_of(pl, inj_now))
    if baseline and baseline.get("statuses"):
        def prev_of(pid):
            b = baseline["statuses"].get(pid)
            return tuple(b) if b else (0, None, None, None, None)
        since = baseline.get("generated_at")
    else:
        def prev_of(pid):
            return status_of(prev_players.get(pid, {}), inj_prev) if prev_players.get(pid) else (0, None, None, None, None)
        since = None
    changes = []
    for pid, pl in players.items():
        if not pl.get("team"):
            continue
        now = tuple(cur_statuses[pid])
        prev = prev_of(pid)
        if now[0] == prev[0]:
            continue
        relevance = max(per_game_proj(pid), 0)
        if relevance < 15 and (pl.get("depth_chart_order") or 9) > 2:
            continue
        changes.append({"pid": pid, "name": f"{pl.get('first_name')} {pl.get('last_name')}", "team": pl.get("team"),
                        "pos": pl.get("fantasy_positions") or [pl.get("position")], "depth": [pl.get("depth_chart_position"), pl.get("depth_chart_order")],
                        "proj": round(relevance, 1), "owner": owner_of.get(pid), "kind": "peor" if now[0] > prev[0] else "mejor",
                        "from": prev[1], "to": now[1], "part": now[2], "return": now[3], "detail": (now[4] or "")[:160]})
    # beneficiarios: compañeros del mismo equipo, por posición de depth chart y techo
    for c in changes:
        if c["kind"] != "peor" or sev(c["to"]) < 3:
            continue
        team = c["team"]; pos = c["depth"][0]
        mates = []
        for pid, pl in players.items():
            if pl.get("team") != team or pid == c["pid"]:
                continue
            st_now = status_of(pl, inj_now)
            if st_now[0] >= 3:
                continue
            ce = ceiling(pl); rec = recent(pid)
            score = (ce["top5"] if ce else per_game_proj(pid)) + (10 if pl.get("depth_chart_position") == pos else 0) + (6 if (pl.get("depth_chart_order") or 9) <= 2 else 0)
            mates.append({"pid": pid, "name": f"{pl.get('first_name')} {pl.get('last_name')}", "pos": pl.get("fantasy_positions") or [], "depth": [pl.get("depth_chart_position"), pl.get("depth_chart_order")],
                          "proj": round(per_game_proj(pid), 1), "top5": ce and round(ce["top5"], 1), "p90": ce and round(ce["p90"], 1), "avg": ce and round(ce["avg"], 1),
                          "recent": rec, "owner": owner_of.get(pid), "free": pid not in owner_of, "_s": score})
        mates.sort(key=lambda m: -m["_s"])
        for m in mates:
            m.pop("_s", None)
        c["beneficiaries"] = mates[:5]
    changes.sort(key=lambda c: (c["kind"] != "peor", -sev(c["to"]), -c["proj"]))
    report = {"generated_at": now_iso(), "today": today, "since": since, "league": league.get("name"), "changes": changes}
    # la primera corrida de cada día fija la nueva línea base (así el reporte matutino cubre 24 h)
    if not baseline or baseline.get("date") != today:
        write_json(f"{out_dir}/injury_baseline.json", {"date": today, "generated_at": now_iso(), "statuses": cur_statuses})
    write_json(f"{out_dir}/injury_report.json", report)
    # histórico (últimos 30 días)
    try:
        log_ = json.load(open(f"{out_dir}/injury_log.json", encoding="utf-8"))
    except Exception:
        log_ = {}
    key = report["today"] or report["generated_at"][:10]
    seen = {(x["name"], x["to"]) for x in log_.get(key, [])}
    log_[key] = log_.get(key, []) + [{k: c[k] for k in ("name", "team", "kind", "from", "to", "part", "return")} for c in changes if (c["name"], c["to"]) not in seen]
    for k in sorted(log_)[:-30]:
        log_.pop(k, None)
    write_json(f"{out_dir}/injury_log.json", log_)
    # markdown para la notificación
    md = [f"# Lesiones {key} · {league.get('name')}", f"Cambios desde {since or 'el snapshot anterior'} (generado {report['generated_at']})", ""]
    worse = [c for c in changes if c["kind"] == "peor"]; better = [c for c in changes if c["kind"] == "mejor"]
    if not changes:
        md.append("Sin cambios de lesión relevantes desde el último reporte.")
    if worse:
        md.append("## Nuevas o agravadas")
        for c in worse:
            own = f" (de {c['owner']})" if c.get("owner") else " (LIBRE)"
            md.append(f"- **{c['name']}** {c['team']} {'/'.join(x for x in c['pos'] if x)}{own}: {c['from'] or 'sano'} → **{c['to']}**{' · ' + c['part'] if c.get('part') else ''}{' · regreso est. ' + c['return'] if c.get('return') else ''}. {c.get('detail') or ''}")
            for m in c.get("beneficiaries") or []:
                tag = "LIBRE" if m["free"] else f"de {m['owner']}"
                rec = ", ".join(f"{r['fp']} ({r['min']}m)" for r in m["recent"]) or "sin juegos"
                md.append(f"    - {m['name']} {'/'.join(m['pos'])} depth {m['depth'][0]}{m['depth'][1]} · {tag} · techo top5 {m['top5']} · p90 {m['p90']} · proy {m['proj']} · últimos: {rec}")
    frees = {}
    for c in worse:
        for m in c.get("beneficiaries") or []:
            if m["free"]:
                frees.setdefault(m["pid"], {**m, "por": c["name"]})
    report["free_beneficiaries"] = sorted(frees.values(), key=lambda m: -(m.get("top5") or m.get("proj") or 0))
    if frees:
        md.append("")
        md.append("## Libres de la liga que ganan minutos hoy")
        for m in report["free_beneficiaries"]:
            rec = ", ".join(f"{r['fp']} ({r['min']}m)" for r in m["recent"]) or "sin juegos"
            md.append(f"- **{m['name']}** {'/'.join(m['pos'])} · por la baja de {m['por']} · techo top5 {m['top5']} · p90 {m['p90']} · proy {m['proj']} · últimos: {rec}")
    write_json(f"{out_dir}/injury_report.json", report)
    if better:
        md.append("")
        md.append("## Mejoran o regresan")
        for c in better:
            own = f" (de {c['owner']})" if c.get("owner") else " (LIBRE)"
            md.append(f"- {c['name']} {c['team']}{own}: {c['from']} → {c['to'] or 'sano'}")
    with open(f"{out_dir}/injury_report.md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")
    log(f"reporte de lesiones: {len(worse)} peor, {len(better)} mejor")
    return report


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
    def load_prev(name):
        try:
            return json.load(open(f"{out}/{name}", encoding="utf-8"))
        except Exception:
            return None
    prev_players = load_prev("players.json") or {}
    prev_bundle = load_prev("espn.json")
    bundle = None
    if not args.skip_espn:
        bundle = fetch_espn_bundle(players, top_n=args.top_n, gamelog_season=int(prev) + 1)
        write_json(f"{out}/espn.json", bundle)
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
    daily = None
    try:
        daily = fetch_daily(core, lg_season, players=players)
        write_json(f"{out}/daily.json", daily)
    except Exception as ex:
        log(f"diario falló: {ex}", ok=False)
    try:
        # sin ESPN nuevo, ESPN previo sirve de 'actual' y de 'previo' (solo cambia Sleeper)
        injury_report(out, core, players, prev_players, bundle or prev_bundle, prev_bundle, proj, daily)
    except Exception as ex:
        log(f"reporte de lesiones falló: {ex}", ok=False)
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
    ap.add_argument("--top-n", type=int, default=350)
    ap.add_argument("--live-dir", default="live")
    ap.add_argument("--minutes", type=int, default=240)
    ap.add_argument("--interval", type=int, default=15)
    args = ap.parse_args()
    (do_snapshot if args.mode == "snapshot" else do_live)(args)


if __name__ == "__main__":
    main()
