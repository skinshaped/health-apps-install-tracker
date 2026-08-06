# health-apps-install-tracker

Daily install tracking for India health & fitness apps, from public store data.

## What it does
Every day (~09:00 IST) a GitHub Action:
1. Pulls the **Google Play Health & Fitness top-free chart (India, top 100)** and the apps in
   [`watchlist.yaml`](watchlist.yaml) — the union is the tracked set (~120 apps).
2. Records each app's **exact cumulative install count** (Play `maxInstalls`), rating, ratings
   count and version. Day-on-day differences of the cumulative count = daily installs.
3. Snapshots the **AppBrain top-100 ranking page** (rank, rank movement, rounded lifetime /
   30-day installs) as an independent cross-check. Rounded numbers are never differenced.
4. Commits everything to [`data/daily/<date>/`](data/) including `load_<date>.sql`, a
   ready-to-run BigQuery script (idempotent per-date DELETE + INSERT) consumed by a downstream
   loader.

Monthly (1st, ~10:10 IST) a **discovery sweep** casts a much wider net (multiple charts,
top-free + grossing, keyword searches; ~900 apps) and writes a ranked report of apps with real
install volume that the daily tracker is not watching → `data/discovery/<date>/candidates_<date>.md`.

## Files per day
| File | Contents |
|---|---|
| `play_<date>.csv` / `.ndjson` | Exact installs per tracked app (the delta source) |
| `appbrain_<date>.csv` / `.ndjson` | AppBrain rank snapshot (rank movement; numbers rounded) |
| `load_<date>.sql` | BigQuery loader script for both tables |
| `appbrain_raw.html.gz` | Raw rankings page, kept as evidence for parser breaks |

## Method notes
- `maxInstalls` is **global** lifetime, not India-only; it occasionally dips on Play recounts
  (treat negative day-on-day deltas as null) and can step after plateaus.
- Requests are throttled to 1/s; a validation gate rejects partial scrapes (<80 chart rows or
  >25% missing fields) so a broken source produces a loud failure, not quiet bad data.
- Exit codes: 0 ok · 2 degraded (a source failed; the rest was written) · 3 Play sweep unhealthy.

Scraping is limited to public pages and public store metadata.

## Run locally
```bash
npm ci
node scripts/daily-installs.mjs            # today (IST); --date YYYY-MM-DD to re-run a day
node scripts/discovery-sweep.mjs           # the monthly wide sweep
```
