"""Scrape MLB team-total stats from ESPN's public JSON API.

Source: the ESPN "by team" statistics endpoint, which returns season totals for
all 30 teams in a single request. Adding ``split=61`` returns the same shape for
the *Last 7 Days* window. This avoids the bot-walled HTML pages entirely and
needs only two requests per run.

Run standalone to write ``scraper/_raw_data.json`` (consumed by build_outputs.py):

    python scraper/scrape.py
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

API = "https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam"
TEAMS_API = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams"

# The 10 dashboard categories, in display order, grouped batting then pitching.
# Each entry: key, label, group, espn_category, espn_stat_name, better, fmt
#   better: "high" (rank 1 = largest) or "low" (rank 1 = smallest)
#   fmt:    how the value is displayed ("rate3" -> .241, "rate2" -> 4.45, "int")
CATEGORIES = [
    ("avg",        "Batting Average",     "batting",  "batting",  "avg",         "high", "rate3"),
    ("runs",       "Runs",                "batting",  "batting",  "runs",        "high", "int"),
    ("hr",         "Home Runs",           "batting",  "batting",  "homeRuns",    "high", "int"),
    ("obp",        "On-Base %",           "batting",  "batting",  "onBasePct",   "high", "rate3"),
    ("slg",        "Slugging %",          "batting",  "batting",  "slugAvg",     "high", "rate3"),
    ("so",         "Batting Strikeouts",  "batting",  "batting",  "strikeouts",  "low",  "int"),
    ("era",        "ERA",                 "pitching", "pitching", "ERA",         "low",  "rate2"),
    ("hr_against", "HR Against",          "pitching", "pitching", "homeRuns",    "low",  "int"),
    ("whip",       "WHIP",                "pitching", "pitching", "WHIP",        "low",  "rate2"),
    ("baa",        "Batting Avg Against", "pitching", "pitching", "opponentAvg", "low",  "rate3"),
]

PERIODS = {"season": None, "last7": "61"}  # split id 61 == Last 7 Days

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; mlb-team-stats-dashboard/1.0)"}


def _get_json(url: str, retries: int = 4) -> dict:
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.load(resp)
        except (urllib.error.URLError, TimeoutError) as err:  # transient
            last_err = err
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def _fetch_period(split: str | None) -> dict:
    url = f"{API}?region=us&lang=en&seasontype=2"
    if split:
        url += f"&split={split}"
    return _get_json(url)


def _stat_lookup(team_categories: list[dict], name_order: dict) -> dict:
    """Build {category_name: {stat_name: (value_float, display_str)}}.

    Per-team category entries only carry ``values``/``totals`` arrays; the column
    order (stat names) lives in the payload-level schema (``name_order``).
    """
    out: dict[str, dict[str, tuple]] = {}
    for cat in team_categories:
        cat_name = cat.get("name")
        names = name_order.get(cat_name, [])
        values = cat.get("values", [])
        totals = cat.get("totals", [])
        out[cat_name] = {
            name: (
                values[i] if i < len(values) else None,
                totals[i] if i < len(totals) else "",
            )
            for i, name in enumerate(names)
        }
    return out


def _parse_period(payload: dict) -> list[dict]:
    name_order = {c.get("name"): c.get("names", []) for c in payload.get("categories", [])}
    teams_out = []
    for entry in payload.get("teams", []):
        team = entry.get("team", {})
        logos = team.get("logos", []) or []
        logo = logos[0]["href"] if logos else ""
        lookup = _stat_lookup(entry.get("categories", []), name_order)

        stats = {}
        for key, _label, _group, espn_cat, espn_name, _better, _fmt in CATEGORIES:
            value, display = lookup.get(espn_cat, {}).get(espn_name, (None, ""))
            stats[key] = {"value": value, "display": display}

        teams_out.append({
            "id": team.get("id"),
            "abbr": team.get("abbreviation"),
            "name": team.get("displayName"),
            "shortName": team.get("shortDisplayName"),
            "logo": logo,
            "stats": stats,
        })
    return teams_out


DEFAULT_COLOR = "#f06b20"
DEFAULT_ALT = "#111827"

# Static fallback of ESPN team brand colors, keyed by abbreviation (color, altColor).
# The live teams endpoint intermittently returns HTTP 403, so we no longer depend on
# it: colors are stable, so a baked-in map keeps the dashboard correct even when the
# endpoint is down. Live values (when reachable) still take precedence.
STATIC_COLORS = {
    "ARI": ("#aa182c", "#000000"), "ATH": ("#003831", "#efb21e"),
    "ATL": ("#0c2340", "#ba0c2f"), "BAL": ("#df4601", "#000000"),
    "BOS": ("#0d2b56", "#bd3039"), "CHC": ("#0e3386", "#cc3433"),
    "CHW": ("#000000", "#c4ced4"), "CIN": ("#c6011f", "#ffffff"),
    "CLE": ("#002b5c", "#e31937"), "COL": ("#33006f", "#000000"),
    "DET": ("#0a2240", "#ff4713"), "HOU": ("#002d62", "#eb6e1f"),
    "KC": ("#004687", "#7ab2dd"),  "LAA": ("#ba0021", "#c4ced4"),
    "LAD": ("#005a9c", "#ffffff"), "MIA": ("#00a3e0", "#000000"),
    "MIL": ("#13294b", "#ffc72c"), "MIN": ("#031f40", "#e20e32"),
    "NYM": ("#002d72", "#ff5910"), "NYY": ("#132448", "#c4ced4"),
    "PHI": ("#e81828", "#003278"), "PIT": ("#000000", "#fdb827"),
    "SD": ("#2f241d", "#ffc425"),  "SEA": ("#005c5c", "#0c2c56"),
    "SF": ("#000000", "#fd5a1e"),  "STL": ("#be0a14", "#001541"),
    "TB": ("#092c5c", "#8fbce6"),  "TEX": ("#003278", "#c0111f"),
    "TOR": ("#134a8e", "#6cace5"), "WSH": ("#ab0003", "#11225b"),
}


def _fetch_team_colors() -> dict:
    """Return {abbr: (color, altColor)} from the ESPN teams endpoint.

    Best-effort only: this endpoint intermittently returns 403, so any failure
    falls back to STATIC_COLORS rather than aborting the whole scrape.
    """
    try:
        data = _get_json(TEAMS_API, retries=2)
    except Exception as err:
        print(f"warning: team colors endpoint unavailable ({err}); using static colors")
        return {}
    out = {}
    for league in data.get("sports", [])[0].get("leagues", []):
        for item in league.get("teams", []):
            t = item.get("team", {})
            abbr = t.get("abbreviation")
            if abbr and t.get("color"):
                out[abbr] = ("#" + t["color"],
                             "#" + t["alternateColor"] if t.get("alternateColor") else DEFAULT_ALT)
    return out


def scrape_all() -> dict:
    """Return {seasonYear, periods:{season:[teams], last7:[teams]}}."""
    result = {"periods": {}}
    live_colors = _fetch_team_colors()
    first_payload = None
    for period, split in PERIODS.items():
        payload = _fetch_period(split)
        if first_payload is None:
            first_payload = payload
        teams = _parse_period(payload)
        if len(teams) != 30:
            raise RuntimeError(f"Expected 30 teams for '{period}', got {len(teams)}")
        for t in teams:
            color, alt = live_colors.get(t["abbr"]) or STATIC_COLORS.get(
                t["abbr"], (DEFAULT_COLOR, DEFAULT_ALT))
            t["color"] = color
            t["altColor"] = alt
        result["periods"][period] = teams

    season_info = first_payload.get("requestedSeason") or first_payload.get("currentSeason") or {}
    result["seasonYear"] = season_info.get("year")
    return result


def main() -> None:
    data = scrape_all()
    out_path = os.path.join(os.path.dirname(__file__), "_raw_data.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    for period, teams in data["periods"].items():
        print(f"{period}: {len(teams)} teams")
    print(f"season year: {data['seasonYear']}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
