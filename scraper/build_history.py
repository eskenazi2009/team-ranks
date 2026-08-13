"""Maintain docs/data/history.json — a time series of each team's SEASON rank per
category, sampled every 3 days.

Two modes, chosen automatically:
  * Seed (history.json missing): reconstruct the series from git history by reading
    docs/data/season.json at ~3-day-spaced commits. This backfills real history
    from the daily refresh commits.
  * Append (history.json exists): add the current snapshot (from the freshly built
    docs/data/season.json) only if >= 3 days have passed since the last entry.

The append path needs no git, so it works under the Action's shallow checkout.

    python scraper/build_history.py
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess

HERE = os.path.dirname(__file__)
REPO_ROOT = os.path.abspath(os.path.join(HERE, ".."))
DATA_DIR = os.path.join(REPO_ROOT, "docs", "data")
HIST_PATH = os.path.join(DATA_DIR, "history.json")
SEASON_PATH = os.path.join(DATA_DIR, "season.json")
META_PATH = os.path.join(DATA_DIR, "meta.json")

# The 10 category keys tracked (order matches the dashboard; frontend uses meta.json
# for labels/groups). Kept here so history is self-contained.
CATS = ["avg", "runs", "hr", "obp", "slg", "so", "era", "hr_against", "whip", "baa"]
MIN_GAP_DAYS = 3


def _git(*args) -> str:
    res = subprocess.run(["git", *args], capture_output=True, text=True, cwd=REPO_ROOT)
    return res.stdout


def _ranks_from_season(text: str) -> dict:
    """{abbr: {cat: rank}} from a season.json string."""
    data = json.loads(text)
    return {
        t["abbr"]: {c: t.get("stats", {}).get(c, {}).get("rank") for c in CATS}
        for t in data.get("teams", [])
    }


def _assemble(kept: list) -> dict:
    """kept = [(date_str, {abbr:{cat:rank}})] -> history.json structure."""
    dates = [d for d, _ in kept]
    abbrs = sorted({a for _, r in kept for a in r})
    teams = {a: {c: [] for c in CATS} for a in abbrs}
    for _, ranks in kept:
        for a in abbrs:
            for c in CATS:
                teams[a][c].append(ranks.get(a, {}).get(c))
    return {"dates": dates, "teams": teams}


def seed_from_git() -> dict:
    """Reconstruct history from ~3-day-spaced commits touching season.json."""
    log = _git("log", "--reverse", "--format=%H|%cI", "--", "docs/data/season.json")
    commits = []
    for line in log.splitlines():
        if "|" not in line:
            continue
        h, iso = line.split("|", 1)
        commits.append((h, iso[:10]))

    kept: list = []
    last_date = None
    for i, (h, d) in enumerate(commits):
        day = dt.date.fromisoformat(d)
        is_last = i == len(commits) - 1
        far_enough = last_date is None or (day - last_date).days >= MIN_GAP_DAYS
        if not (far_enough or is_last):
            continue
        if kept and kept[-1][0] == d:  # never duplicate a calendar date
            continue
        text = _git("show", f"{h}:docs/data/season.json")
        if not text.strip():
            continue
        try:
            ranks = _ranks_from_season(text)
        except json.JSONDecodeError:
            continue
        kept.append((d, ranks))
        last_date = day

    return _assemble(kept)


def append_current(history: dict) -> dict:
    """Append today's snapshot if >= MIN_GAP_DAYS since the last entry."""
    with open(META_PATH, encoding="utf-8") as fh:
        today = json.load(fh)["updated"][:10]
    with open(SEASON_PATH, encoding="utf-8") as fh:
        ranks = _ranks_from_season(fh.read())

    dates = history["dates"]
    if dates:
        last = dt.date.fromisoformat(dates[-1])
        gap = (dt.date.fromisoformat(today) - last).days
        if today == dates[-1] or gap < MIN_GAP_DAYS:
            return history  # already recorded, or not due yet

    # Make sure every abbr (including any new team) has an aligned array.
    n = len(dates)
    teams = history["teams"]
    for abbr in ranks:
        teams.setdefault(abbr, {c: [None] * n for c in CATS})
    dates.append(today)
    for abbr, cols in teams.items():
        for c in CATS:
            cols.setdefault(c, [None] * n)
            cols[c].append(ranks.get(abbr, {}).get(c))
    return history


def main() -> None:
    if os.path.exists(HIST_PATH):
        with open(HIST_PATH, encoding="utf-8") as fh:
            history = json.load(fh)
        history = append_current(history)
        mode = "append"
    else:
        history = seed_from_git()
        mode = "seed"

    with open(HIST_PATH, "w", encoding="utf-8") as fh:
        json.dump(history, fh, separators=(",", ":"))

    print(f"history [{mode}]: {len(history['dates'])} snapshots, "
          f"{len(history['teams'])} teams")
    if history["dates"]:
        print(f"  range: {history['dates'][0]} -> {history['dates'][-1]}")


if __name__ == "__main__":
    main()
