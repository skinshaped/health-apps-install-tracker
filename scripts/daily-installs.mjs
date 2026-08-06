// daily-installs.mjs — daily competitor-install scrape.
//
// TRACKED SET = union( Play "top 100" chart(s) for the day , watchlist.yaml )
//   The chart comes from Google Play directly (gplay.list) — authoritative, and it keeps the
//   tracked set independent of any third-party markup. AppBrain is ENRICHMENT ONLY.
//
// Outputs per day, under data/daily/<date>/:
//   1. play_<date>.{csv,ndjson}     — one row per tracked app with EXACT maxInstalls.
//                                     Day-on-day deltas of max_installs = daily install volume.
//                                     THIS is the only valid delta source.
//   2. appbrain_<date>.{csv,ndjson} — AppBrain chart page: rank_change + ROUNDED lifetime /
//                                     recent-30d installs. Rank movement + cross-check only;
//                                     never diff its install numbers (quantization noise).
//
// Usage: node daily-installs.mjs [--date YYYY-MM-DD]   (date override = idempotent rerun)
// Exit codes: 0 ok · 2 degraded (a source failed validation; whatever succeeded was written)
//             3 Play sweep unhealthy (>25% failures, or our own app failed)
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import yaml from 'js-yaml';
import gplay from 'google-play-scraper';
import {
  todayIST, nowISO, sleep, withRetry,
  writeFileEnsuring, appendLine, toCSV, toNDJSON,
} from './lib/util.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ → Competitive Marketing/
const OUR_APP = 'com.seekhoai.android';
const RANKINGS_URL = 'https://www.appbrain.com/stats/google-play-rankings/top_free/health_fitness/in';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const date = todayIST();
const runId = `${date}_${Math.floor(Date.now() / 1000)}`;
const dayDir = join(ROOT, 'data', 'daily', date);

// ---------- helpers ----------

// "360 K" → 360000, "1.5 M" → 1500000, "15 M" → 15000000, "820" → 820, junk → null
function parseRounded(s) {
  if (!s) return null;
  const m = String(s).trim().replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// ---------- 1. AppBrain rankings page ----------

async function scrapeAppBrain() {
  const res = await withRetry(
    () => fetch(RANKINGS_URL, { headers: { 'User-Agent': UA } }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),
    'appbrain rankings',
  );
  // Save raw HTML FIRST — if the parser breaks on markup drift, the evidence is on disk.
  writeFileEnsuring(join(dayDir, 'appbrain_raw.html.gz'), gzipSync(res)); // evidence for parser breaks, gzipped for the repo

  const $ = cheerio.load(res);
  const rows = [];
  $('td.ranking-rank').each((_, el) => {
    const tr = $(el).closest('tr');
    const rank = parseInt($(el).text().trim(), 10);

    // rank movement: ranking-equal '=' → 0, ranking-increase 'N' → +N, ranking-decrease 'N' → -N
    let rank_change = null;
    const chg = tr.find('td.ranking-equal, td.ranking-increase, td.ranking-decrease').first();
    if (chg.length) {
      if (chg.hasClass('ranking-equal')) rank_change = 0;
      else {
        const n = parseInt(chg.text().trim(), 10);
        if (!Number.isNaN(n)) rank_change = chg.hasClass('ranking-decrease') ? -n : n;
      }
    }

    const appLink = tr.find('td.ranking-app-cell a').first();
    const href = appLink.attr('href') || '';
    const pkg = href.split('/').filter(Boolean).pop() || null; // /app/<slug>/<pkg>
    const app_name = appLink.text().trim() || null;
    const rating = parseFloat(tr.find('td.ranking-rating-cell span').first().text().trim()) || null;

    // The two bare (class-less) tds after the rating cell: lifetime, recent-30d
    const bare = tr.find('td').filter((_, td) => !$(td).attr('class')).map((_, td) => $(td).text().trim()).get();
    const lifetime_installs_rounded = parseRounded(bare[0]);
    const recent_30d_installs_rounded = parseRounded(bare[1]);

    rows.push({
      snapshot_date: date, rank, rank_change, package: pkg, app_name, rating,
      lifetime_installs_rounded, recent_30d_installs_rounded,
      scraped_at: nowISO(), run_id: runId,
    });
  });

  // Validation gate (radar convention): a partial/broken scrape must not look like data.
  const missing = rows.filter((r) => !r.package || !r.rank || r.recent_30d_installs_rounded === null).length;
  if (rows.length < 80) throw new Error(`appbrain: only ${rows.length} rows (<80) — treating as failed scrape`);
  if (missing > rows.length / 4) throw new Error(`appbrain: ${missing}/${rows.length} rows missing package/rank/recent_30d`);
  return rows;
}

// ---------- 2. Play chart (the tracked-set spine) ----------

// gplay.list per configured category → [{package, app_name, chart_rank, chart}]
// One request per chart. This defines who gets tracked; AppBrain no longer does.
async function scrapePlayCharts(charts, topN) {
  const rows = [];
  for (const cat of charts) {
    if (!gplay.category[cat]) throw new Error(`unknown Play category in watchlist.yaml: ${cat}`);
    const list = await withRetry(
      () => gplay.list({ category: gplay.category[cat], collection: gplay.collection.TOP_FREE, country: 'in', num: topN }),
      `chart ${cat}`,
    );
    if (list.length < Math.min(80, topN)) throw new Error(`chart ${cat}: only ${list.length} rows (<${Math.min(80, topN)}) — treating as failed`);
    list.slice(0, topN).forEach((a, i) => rows.push({ package: a.appId, app_name: a.title, chart_rank: i + 1, chart: cat }));
    process.stderr.write(`[chart] ${cat}: ${Math.min(list.length, topN)} rows\n`);
    await sleep(1000);
  }
  return rows;
}

// ---------- 3. Google Play exact installs ----------

function loadWatchlist() {
  const wl = yaml.load(readFileSync(join(ROOT, 'watchlist.yaml'), 'utf8'));
  if (!wl || !Array.isArray(wl.apps)) throw new Error('watchlist.yaml invalid: no apps[]');
  return {
    packages: wl.apps.map((a) => a.package),
    clusters: new Map(wl.apps.map((a) => [a.package, a.cluster ?? null])),
    charts: Array.isArray(wl.charts) && wl.charts.length ? wl.charts : ['HEALTH_AND_FITNESS'],
    chartTopN: wl.chart_top_n ?? 100,
  };
}

async function scrapePlay(packages, chartMeta, watchlist) {
  const rows = [];
  const failures = [];
  let i = 0;
  for (const pkg of packages) {
    i += 1;
    try {
      const d = await withRetry(() => gplay.app({ appId: pkg, country: 'in' }), pkg, 3000);
      const chart = chartMeta.get(pkg);
      rows.push({
        snapshot_date: date,
        package: pkg,
        app_name: d.title ?? null,
        max_installs: d.maxInstalls ?? null,   // EXACT cumulative — the delta source
        installs_bucket: d.installs ?? null,   // "10,000,000+"
        score: d.score ?? null,
        ratings: d.ratings ?? null,
        version: d.version ?? null,
        chart_rank: chart?.chart_rank ?? null, // null = tracked via watchlist, off-chart today
        chart: chart?.chart ?? null,
        in_chart: !!chart,
        in_watchlist: watchlist.clusters.has(pkg),
        cluster: watchlist.clusters.get(pkg) ?? null, // labelled for watchlist apps; null = unlabelled chart app
        scraped_at: nowISO(),
        run_id: runId,
      });
    } catch (e) {
      failures.push({ package: pkg, error: e.message });
      process.stderr.write(`[play-fail ${i}/${packages.length}] ${pkg}: ${e.message}\n`);
    }
    if (i % 20 === 0) process.stderr.write(`[play] ${i}/${packages.length}\n`);
    await sleep(1000); // 1 req/s, house convention
  }
  return { rows, failures };
}

// ---------- main ----------

let exitCode = 0;
const watchlist = loadWatchlist();

// The chart defines the tracked set. If it fails we still run the watchlist (degraded).
let chartRows = [];
try {
  chartRows = await scrapePlayCharts(watchlist.charts, watchlist.chartTopN);
} catch (e) {
  process.stderr.write(`[chart] FAILED: ${e.message} — continuing watchlist-only\n`);
  exitCode = 2;
}
const chartMeta = new Map(chartRows.map((r) => [r.package, r]));

// AppBrain is enrichment only — its failure must never shrink the tracked set.
let appbrainRows = [];
try {
  appbrainRows = await scrapeAppBrain();
} catch (e) {
  process.stderr.write(`[appbrain] FAILED (enrichment only, tracked set unaffected): ${e.message}\n`);
  exitCode = exitCode || 2;
}

const tracked = [...new Set([...chartMeta.keys(), ...watchlist.packages])];
process.stderr.write(`[set] chart=${chartMeta.size} watchlist=${watchlist.packages.length} union=${tracked.length}\n`);

const { rows: playRows, failures } = await scrapePlay(tracked, chartMeta, watchlist);

// Health gates for the Play sweep
const ourRow = playRows.find((r) => r.package === OUR_APP);
if (failures.length > tracked.length / 4 || !ourRow) exitCode = 3;

// ---------- write outputs (always write whatever succeeded) ----------

const AB_COLS = ['snapshot_date', 'rank', 'rank_change', 'package', 'app_name', 'rating',
  'lifetime_installs_rounded', 'recent_30d_installs_rounded', 'scraped_at', 'run_id'];
const PLAY_COLS = ['snapshot_date', 'package', 'app_name', 'max_installs', 'installs_bucket',
  'score', 'ratings', 'version', 'chart_rank', 'chart', 'in_chart', 'in_watchlist', 'cluster',
  'scraped_at', 'run_id'];

if (appbrainRows.length) {
  writeFileEnsuring(join(dayDir, `appbrain_${date}.csv`), toCSV(appbrainRows, AB_COLS));
  writeFileEnsuring(join(dayDir, `appbrain_${date}.ndjson`), toNDJSON(appbrainRows));
}
if (playRows.length) {
  // CSV sorted by installs for human review; NDJSON as-is for BQ
  const sorted = [...playRows].sort((a, b) => (b.max_installs ?? 0) - (a.max_installs ?? 0));
  writeFileEnsuring(join(dayDir, `play_${date}.csv`), toCSV(sorted, PLAY_COLS));
  writeFileEnsuring(join(dayDir, `play_${date}.ndjson`), toNDJSON(playRows));
}

// load_<date>.sql — ready-to-execute BigQuery script (DELETE partition + INSERT), consumed
// by the daily Claude cloud routine via the BigQuery MCP. Idempotent per snapshot_date.
function sqlVal(x) {
  if (x === null || x === undefined) return 'NULL';
  if (typeof x === 'boolean') return x ? 'TRUE' : 'FALSE';
  if (typeof x === 'number') return String(x);
  return "'" + String(x).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function insertSQL(table, cols, rows) {
  const values = rows.map((r) => '(' + cols.map((c) => sqlVal(r[c])).join(',') + ')').join(',\n');
  return `DELETE FROM \`${table}\` WHERE snapshot_date='${date}';\n`
    + `INSERT INTO \`${table}\` (${cols.join(',')}) VALUES\n${values};`;
}
const sqlParts = [];
if (playRows.length) sqlParts.push(insertSQL('seekho-c084b.gtm.play_installs_daily', PLAY_COLS, playRows));
if (appbrainRows.length) sqlParts.push(insertSQL('seekho-c084b.gtm.appbrain_rank_daily', AB_COLS, appbrainRows));
if (sqlParts.length) writeFileEnsuring(join(dayDir, `load_${date}.sql`), sqlParts.join('\n\n') + '\n');

const status = {
  date, run_id: runId, exit: exitCode,
  chart_rows: chartRows.length,
  appbrain_rows: appbrainRows.length,
  play_rows: playRows.length,
  play_failures: failures.length,
  our_app: ourRow ? { max_installs: ourRow.max_installs, chart_rank: ourRow.chart_rank } : null,
  failed_packages: failures.slice(0, 5).map((f) => f.package),
};
appendLine(join(ROOT, 'logs', 'runs.log'),
  `${nowISO()} | ${runId} | exit=${exitCode} | chart=${chartRows.length} | appbrain=${appbrainRows.length} | play=${playRows.length} | fail=${failures.length}`);
console.log(JSON.stringify(status, null, 2));
process.exit(exitCode);
