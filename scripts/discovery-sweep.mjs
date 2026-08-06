// discovery-sweep.mjs — MONTHLY broad sweep. Answers exactly one question:
//   "Is there an app with real install volume that the daily tracker is NOT watching?"
//
// Deliberately wider than the daily path: multiple Play charts (top-free AND grossing)
// plus keyword searches, which is the only way to catch apps filed under a category the
// daily chart never touches (CureSkin, 33M installs, has never charted in Health & Fitness).
//
// NOT part of the daily job. Safe to run any time; ~12-18 min at 1 req/s.
//
// Velocity for candidates, best available first:
//   1. mom_installs_per_day — (max_installs now − max_installs at previous sweep) / days between.
//      TRUE measured velocity. Available from the 2nd sweep onward.
//   2. lifetime_installs_per_day — max_installs / days since release. A lifetime AVERAGE:
//      good for young apps (a 2026 app's average IS roughly its current rate), misleading for
//      old ones (a 2013 app that has plateaued still shows a healthy-looking average).
//
// Usage: node discovery-sweep.mjs [--date YYYY-MM-DD]
// Exit codes: 0 ok · 2 degraded (a source failed; whatever succeeded was written)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import gplay from 'google-play-scraper';
import {
  todayIST, nowISO, sleep, withRetry, writeFileEnsuring, appendLine, toCSV, toNDJSON,
} from './lib/util.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const date = todayIST();
const runId = `${date}_${Math.floor(Date.now() / 1000)}`;
const outDir = join(ROOT, 'data', 'discovery', date);

const cfg = yaml.load(readFileSync(join(ROOT, 'watchlist.yaml'), 'utf8'));
const watchPkgs = new Set(cfg.apps.map((a) => a.package));
const dailyCharts = cfg.charts ?? ['HEALTH_AND_FITNESS'];
const dailyTopN = cfg.chart_top_n ?? 100;
const disc = cfg.discovery ?? { charts: [], searches: [] };

let exitCode = 0;

// ---------- 1. build the candidate pool ----------

const pool = new Map(); // package → { app_name, found_via }
const addAll = (list, via) => list.forEach((a) => {
  if (!pool.has(a.appId)) pool.set(a.appId, { app_name: a.title, found_via: via });
});

for (const { category, collections } of disc.charts ?? []) {
  for (const col of collections) {
    try {
      const l = await withRetry(
        () => gplay.list({ category: gplay.category[category], collection: gplay.collection[col], country: 'in', num: 200 }),
        `list ${category}/${col}`,
      );
      addAll(l, `chart:${category}/${col}`);
      process.stderr.write(`[pool] ${category}/${col}: ${l.length} rows → pool ${pool.size}\n`);
    } catch (e) {
      process.stderr.write(`[pool] ${category}/${col} FAILED: ${e.message}\n`);
      exitCode = 2;
    }
    await sleep(800);
  }
}
for (const term of disc.searches ?? []) {
  try {
    const s = await withRetry(() => gplay.search({ term, country: 'in', num: 50 }), `search ${term}`);
    const before = pool.size;
    addAll(s, `search:${term}`);
    process.stderr.write(`[pool] search "${term}": +${pool.size - before} → ${pool.size}\n`);
  } catch (e) {
    process.stderr.write(`[pool] search "${term}" FAILED: ${e.message}\n`);
    exitCode = 2;
  }
  await sleep(800);
}

// What the daily job already watches: today's daily chart(s) ∪ watchlist.
const dailyTracked = new Set(watchPkgs);
for (const cat of dailyCharts) {
  try {
    const l = await withRetry(
      () => gplay.list({ category: gplay.category[cat], collection: gplay.collection.TOP_FREE, country: 'in', num: dailyTopN }),
      `daily chart ${cat}`,
    );
    l.slice(0, dailyTopN).forEach((a) => dailyTracked.add(a.appId));
  } catch (e) {
    process.stderr.write(`[tracked] daily chart ${cat} FAILED: ${e.message} — 'tracked' flag is watchlist-only\n`);
    exitCode = 2;
  }
  await sleep(800);
}
process.stderr.write(`[pool] TOTAL ${pool.size} candidates · daily tracker watches ${dailyTracked.size}\n`);

// ---------- 2. previous sweep (for TRUE month-over-month velocity) ----------

function loadPreviousSweep() {
  const base = join(ROOT, 'data', 'discovery');
  if (!existsSync(base)) return null;
  const prev = readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date).sort().pop();
  if (!prev) return null;
  const f = join(base, prev, `pool_${prev}.ndjson`);
  if (!existsSync(f)) return null;
  const map = new Map();
  for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    if (r.max_installs != null) map.set(r.package, r.max_installs);
  }
  process.stderr.write(`[prev] baseline ${prev}: ${map.size} apps → true MoM velocity available\n`);
  return { date: prev, installs: map };
}
const prev = loadPreviousSweep();
const daysSincePrev = prev
  ? Math.max(1, Math.round((Date.parse(date) - Date.parse(prev.date)) / 86400000))
  : null;

// ---------- 3. look up every candidate ----------

const rows = [];
const failures = [];
let i = 0;
for (const [pkg, meta] of pool) {
  i += 1;
  try {
    const d = await withRetry(() => gplay.app({ appId: pkg, country: 'in' }), pkg, 3000);
    const releasedMs = d.released ? Date.parse(d.released) : null;
    const ageDays = releasedMs ? Math.max(1, Math.round((Date.now() - releasedMs) / 86400000)) : null;
    const maxInstalls = d.maxInstalls ?? null;
    const prevInstalls = prev?.installs.get(pkg) ?? null;
    rows.push({
      sweep_date: date,
      package: pkg,
      app_name: d.title ?? meta.app_name ?? null,
      developer: d.developer ?? null,
      genre: d.genre ?? null,
      max_installs: maxInstalls,
      released: d.released ?? null,
      age_days: ageDays,
      // lifetime average — only trust it for young apps
      lifetime_installs_per_day: maxInstalls && ageDays ? Math.round(maxInstalls / ageDays) : null,
      // TRUE measured velocity, 2nd sweep onward
      prev_sweep_date: prev?.date ?? null,
      prev_max_installs: prevInstalls,
      mom_installs_per_day: prevInstalls != null && maxInstalls != null && maxInstalls >= prevInstalls
        ? Math.round((maxInstalls - prevInstalls) / daysSincePrev) : null,
      score: d.score ?? null,
      ratings: d.ratings ?? null,
      free: d.free ?? null,
      found_via: meta.found_via,
      tracked_daily: dailyTracked.has(pkg),
      on_watchlist: watchPkgs.has(pkg),
      scraped_at: nowISO(),
      run_id: runId,
    });
  } catch (e) {
    failures.push({ package: pkg, error: e.message });
  }
  if (i % 50 === 0) process.stderr.write(`[lookup] ${i}/${pool.size} (${failures.length} failed)\n`);
  await sleep(800);
}
if (failures.length > pool.size / 4) exitCode = 2;

// ---------- 4. outputs ----------

const COLS = ['sweep_date', 'package', 'app_name', 'developer', 'genre', 'max_installs', 'released',
  'age_days', 'lifetime_installs_per_day', 'prev_sweep_date', 'prev_max_installs',
  'mom_installs_per_day', 'score', 'ratings', 'free', 'found_via', 'tracked_daily', 'on_watchlist',
  'scraped_at', 'run_id'];

const velocity = (r) => r.mom_installs_per_day ?? r.lifetime_installs_per_day ?? 0;
const sorted = [...rows].sort((a, b) => velocity(b) - velocity(a));
writeFileEnsuring(join(outDir, `pool_${date}.csv`), toCSV(sorted, COLS));
writeFileEnsuring(join(outDir, `pool_${date}.ndjson`), toNDJSON(rows)); // next sweep's baseline

// The report: untracked candidates only, ranked by best available velocity.
const candidates = sorted.filter((r) => !r.tracked_daily && velocity(r) > 0);
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-IN'));
const md = [
  `# Discovery sweep — ${date}`,
  '',
  `Pool: **${rows.length}** apps (${pool.size} candidates, ${failures.length} lookup failures) · daily tracker watches **${dailyTracked.size}**.`,
  prev
    ? `Velocity = TRUE month-over-month, measured against the ${prev.date} sweep (${daysSincePrev} days).`
    : `⚠️ First sweep — no previous baseline, so velocity is **lifetime average** (max_installs ÷ age). Reliable for apps released recently; inflated for old plateaued apps. The next sweep gives true measured velocity.`,
  '',
  `## Untracked apps by install velocity (top 40 of ${candidates.length})`,
  '',
  '| # | app | developer | genre | installs/day | lifetime | released | rating | found via |',
  '|---|---|---|---|---|---|---|---|---|',
  ...candidates.slice(0, 40).map((r, n) => `| ${n + 1} | ${r.app_name} | ${r.developer ?? '—'} | ${r.genre ?? '—'} | **${fmt(velocity(r))}** | ${fmt(r.max_installs)} | ${r.released ?? '—'} | ${r.score ? r.score.toFixed(1) : '—'} | ${r.found_via} |`),
  '',
  '## How to act on this',
  'Add anything worth watching to `watchlist.yaml` (`apps:` list, with a `cluster`) — it then',
  'gets an exact daily install count from the next daily run onward, whether or not it charts.',
  '',
  `_Run ${runId}._`,
].join('\n');
writeFileEnsuring(join(outDir, `candidates_${date}.md`), md + '\n');

appendLine(join(ROOT, 'logs', 'runs.log'),
  `${nowISO()} | ${runId} | SWEEP | exit=${exitCode} | pool=${rows.length} | untracked=${candidates.length} | fail=${failures.length}`);
console.log(JSON.stringify({
  date, run_id: runId, exit: exitCode, pool_rows: rows.length,
  untracked_candidates: candidates.length, failures: failures.length,
  velocity_basis: prev ? `mom_vs_${prev.date}` : 'lifetime_average',
  report: join('data', 'discovery', date, `candidates_${date}.md`),
}, null, 2));
process.exit(exitCode);
