# ⚾ MLB Team Stats Dashboard

A live, interactive dashboard of **MLB team-total statistics** — ranked across all 30
teams — for both the **full season** and the **last 7 days**. Data is scraped daily
from ESPN's public API, published as an Excel workbook + JSON, and rendered by a
self-contained static site you can host for free on **GitHub Pages**.

![categories](https://img.shields.io/badge/categories-10-orange) ![teams](https://img.shields.io/badge/teams-30-blue)

## Features

- **Two tabs:** Season and Last 7 Days.
- **Team selector:** a grid of all 30 teams with logos — click any team to open a
  full-screen **TEAM RANKS** card.
- **Batting & Pitching** clearly separated, each category showing the team's rank
  (`Nth`), a color-coded bar, and the actual stat value.
- **Compare two teams** side-by-side inside the popup; the better team per category
  is highlighted.
- **Sortable league table** of all teams × all categories.
- **Excel download** of the underlying team totals.

### The 10 categories

| Batting | Pitching |
|---|---|
| Batting Average · Strikeouts · Runs · Home Runs · On-Base % · Slugging % | ERA · HR Against · WHIP · Batting Avg Against |

Ranks are computed across all 30 teams (**rank 1 = best**, direction-aware: e.g. the
lowest ERA, WHIP, strikeouts, HR-against and opponent average all rank 1st). Ties
share the lower rank.

## Data source

Everything comes from ESPN's public JSON endpoint (no HTML scraping, no API key):

```
https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam
```

Season is the default; `&split=61` returns the **Last 7 Days** window. Team colors and
logos come from `.../mlb/teams`.

## Project layout

```
scraper/
  scrape.py          # fetch + normalize ESPN team totals (season + last7)
  build_outputs.py   # rank, sanity-check, write Excel + JSON
  requirements.txt
docs/                # the published site (GitHub Pages root)
  index.html  app.js  styles.css
  data/              # season.json, last7.json, meta.json, mlb_team_stats.xlsx
.github/workflows/update.yml   # daily refresh
```

## Run locally

```bash
pip install -r scraper/requirements.txt
python scraper/scrape.py          # writes scraper/_raw_data.json
python scraper/build_outputs.py   # writes docs/data/*

# preview the dashboard
python -m http.server --directory docs 8000
# open http://localhost:8000
```

## Publish on GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main` / `/docs`.
3. The site goes live at `https://<you>.github.io/<repo>/`.
4. The included Action (`.github/workflows/update.yml`) refreshes the data **daily**
   and commits it; you can also trigger it manually from the **Actions** tab.

## Notes

- `scraper/_raw_data.json` is a regenerated intermediate and is git-ignored.
- The build script runs sanity assertions (30 teams, no nulls, plausible ranges,
  complete 1–30 ranks) and fails loudly if ESPN changes shape.
