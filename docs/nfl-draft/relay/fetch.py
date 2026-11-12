"""Relay de Sleeper NFL: baja las ligas NFL de raymondesk y sus drafts a docs/nfl-draft/data.

Corre en GitHub Actions (el contenedor de Claude y el navegador de Raymond no alcanzan Sleeper directo).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

SLEEPER = "https://api.sleeper.app/v1"
SLEEPER2 = "https://api.sleeper.com"
UA = "team-ranks-nfl-draft/1.0 (+https://github.com/eskenazi2009/team-ranks)"
USERNAME = os.environ.get("SLEEPER_USER", "raymondesk")
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
POS_Q = "&".join(f"position[]={p}" for p in ["QB", "RB", "WR", "TE", "K", "DEF"])
KEEP = ["player_id", "full_name", "first_name", "last_name", "team", "position", "fantasy_positions", "status",
        "active", "age", "years_exp", "injury_status", "injury_body_part", "injury_notes", "search_rank",
        "depth_chart_order", "depth_chart_position", "number", "college", "news_updated"]
LOG = []


def log(msg, ok=True):
    line = f"{'✓' if ok else '✗'} {msg}"
    LOG.append(line)
    print(line, flush=True)


def get(url, timeout=60, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 403, 404):
                break
        except Exception as e:
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


def save(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    os.makedirs(OUT, exist_ok=True)
    state = try_get("estado NFL", f"{SLEEPER}/state/nfl") or {}
    user = try_get("usuario", f"{SLEEPER}/user/{USERNAME}")
    if not user:
        sys.exit("no se pudo leer el usuario de Sleeper")
    uid = user["user_id"]
    season = int(state.get("league_season") or state.get("season") or time.gmtime().tm_year)
    leagues = []
    for s in sorted({season, season + 1, int(state.get("season") or season)}):
        for lg in try_get(f"ligas {s}", f"{SLEEPER}/user/{uid}/leagues/nfl/{s}") or []:
            leagues.append(lg)
    out_leagues = []
    for lg in leagues:
        lid = lg["league_id"]
        entry = {
            "league": lg,
            "users": try_get(f"usuarios {lid}", f"{SLEEPER}/league/{lid}/users") or [],
            "rosters": try_get(f"rosters {lid}", f"{SLEEPER}/league/{lid}/rosters") or [],
            "traded_picks": try_get(f"picks cambiados {lid}", f"{SLEEPER}/league/{lid}/traded_picks") or [],
            "drafts": [],
        }
        for d in try_get(f"drafts {lid}", f"{SLEEPER}/league/{lid}/drafts") or []:
            did = d["draft_id"]
            entry["drafts"].append({
                "draft": try_get(f"draft {did}", f"{SLEEPER}/draft/{did}") or d,
                "picks": try_get(f"picks {did}", f"{SLEEPER}/draft/{did}/picks") or [],
                "traded_picks": try_get(f"picks cambiados draft {did}", f"{SLEEPER}/draft/{did}/traded_picks") or [],
            })
        out_leagues.append(entry)
    save("leagues.json", {"user": user, "state": state, "leagues": out_leagues})

    players = try_get("jugadores NFL", f"{SLEEPER}/players/nfl", timeout=180) or {}
    slim = {}
    for pid, p in players.items():
        if not p or p.get("position") not in ("QB", "RB", "WR", "TE", "K", "DEF"):
            continue
        if not p.get("active") and p.get("position") != "DEF":
            continue
        slim[pid] = {k: p[k] for k in KEEP if p.get(k) is not None}
    log(f"jugadores activos {len(slim)}")
    save("players.json", slim)

    proj = {}
    for s in sorted({season, season + 1}):
        j = try_get(f"proyecciones {s}", f"{SLEEPER2}/projections/nfl/{s}?season_type=regular&{POS_Q}&order_by=adp_ppr", timeout=120)
        if isinstance(j, list) and j:
            proj[str(s)] = {r["player_id"]: r.get("stats") for r in j if r.get("player_id")}
    wk = state.get("week")
    if wk:
        j = try_get(f"proyecciones semana {wk}", f"{SLEEPER2}/projections/nfl/{season}/{wk}?season_type=regular&{POS_Q}", timeout=120)
        if isinstance(j, list):
            proj[f"{season}_w{wk}"] = {r["player_id"]: r.get("stats") for r in j if r.get("player_id")}
        j = try_get(f"stats temporada {season}", f"{SLEEPER2}/stats/nfl/{season}?season_type=regular&{POS_Q}", timeout=120)
        if isinstance(j, list):
            proj[f"stats_{season}"] = {r["player_id"]: r.get("stats") for r in j if r.get("player_id")}
    for w in range(int(wk or 1), 19):
        j = try_get(f"proyecciones semana {w}", f"{SLEEPER2}/projections/nfl/{season}/{w}?season_type=regular&{POS_Q}", timeout=120)
        if isinstance(j, list):
            proj[f"{season}_w{w}"] = {r["player_id"]: dict(r.get("stats") or {}, _opp=r.get("opponent"), _team=r.get("team")) for r in j if r.get("player_id")}
    save("proj.json", proj)
    save("log.json", {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "log": LOG})


def live(hours=5.0, every=15):
    """Durante el draft: copia el draft y sus picks a live_draft.json y hace push en cada cambio."""
    import subprocess
    L = json.load(open(os.path.join(OUT, "leagues.json")))
    dids = [d["draft"]["draft_id"] for e in L["leagues"] for d in e["drafts"]
            if d["draft"].get("status") in ("pre_draft", "drafting", "paused")]
    if not dids:
        print("no hay drafts pendientes")
        return
    did, last, t0 = dids[-1], None, time.time()
    while time.time() - t0 < hours * 3600:
        try:
            d = get(f"{SLEEPER}/draft/{did}")
            picks = get(f"{SLEEPER}/draft/{did}/picks")
        except Exception as e:
            print("error", e, flush=True)
            time.sleep(every)
            continue
        key = (d.get("status"), len(picks))
        if key != last:
            last = key
            save("live_draft.json", {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "draft": d, "picks": picks})
            subprocess.run("git add docs/nfl-draft/data/live_draft.json && git commit -qm 'chore(nfl-draft): picks en vivo [skip ci]' "
                           "&& (git push -q origin HEAD:$GITHUB_REF_NAME || (git pull -q --rebase origin $GITHUB_REF_NAME && git push -q origin HEAD:$GITHUB_REF_NAME))",
                           shell=True)
            print(f"status={key[0]} picks={key[1]}", flush=True)
        if d.get("status") == "complete":
            break
        time.sleep(every)


if __name__ == "__main__":
    if "--live" in sys.argv:
        live()
    else:
        main()
