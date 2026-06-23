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
    ("so",         "Batting Strikeouts",  "batting",  "batting",  "strikeouts",  "low",  "int"),
    ("runs",       "Runs",                "batting",  "batting",  "runs",        "high", "int"),
    ("hr",         "Home Runs",           "batting",  "batting",  "homeRuns",    "high", "int"),
    ("obp",        "On-Base %",           "batting",  "batting",  "onBasePct",   "high", "rate3"),
    ("slg",        "Slugging %",          "batting",  "batting",  "slugAvg",     "high", "rate3"),
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


def _fetch_team_colors() -> dict:
    """Return {team_id: {color, altColor}} from the teams endpoint."""
    data = _get_json(TEAMS_API)
    out = {}
    for league in data.get("sports", [])[0].get("leagues", []):
        for item in league.get("teams", []):
            t = item.get("team", {})
            out[t.get("id")] = {
                "color": "#" + t["color"] if t.get("color") else "#f06b20",
                "altColor": "#" + t["alternateColor"] if t.get("alternateColor") else "#111827",
            }
    return out


def scrape_all() -> dict:
    """Return {seasonYear, periods:{season:[teams], last7:[teams]}}."""
    result = {"periods": {}}
    colors = _fetch_team_colors()
    first_payload = None
    for period, split in PERIODS.items():
        payload = _fetch_period(split)
        if first_payload is None:
            first_payload = payload
        teams = _parse_period(payload)
        if len(teams) != 30:
            raise RuntimeError(f"Expected 30 teams for '{period}', got {len(teams)}")
        for t in teams:
            c = colors.get(t["id"], {})
            t["color"] = c.get("color", "#f06b20")
            t["altColor"] = c.get("altColor", "#111827")
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
