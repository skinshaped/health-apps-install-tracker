// lib/util.mjs — shared helpers for Competitive Marketing scripts.
// Copied (subset) from "Competitive Intel/scripts/lib/registry.mjs" 2026-08-06 so the two
// folders stay independent; keep behavior identical if you sync changes back.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJSON(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeFileEnsuring(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function writeJSON(path, data) {
  writeFileEnsuring(path, JSON.stringify(data, null, 2) + '\n');
}

export function appendLine(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line.endsWith('\n') ? line : line + '\n');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Date string in IST (Asia/Kolkata), or an explicit --date override for idempotent reruns.
export function todayIST() {
  const argIdx = process.argv.indexOf('--date');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const d = process.argv[argIdx + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`--date must be YYYY-MM-DD, got: ${d}`);
    return d;
  }
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function nowISO() {
  return new Date().toISOString();
}

// One retry with backoff; caller decides what a failure means.
export async function withRetry(fn, label, backoffMs = 5000) {
  try {
    return await fn();
  } catch (e1) {
    process.stderr.write(`[retry] ${label}: ${e1.message} — retrying in ${backoffMs / 1000}s\n`);
    await sleep(backoffMs);
    return await fn(); // second failure propagates
  }
}

// CSV writer: quotes fields containing commas/quotes/newlines; null/undefined → empty.
export function toCSV(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

// NDJSON writer for BigQuery loads (one JSON object per line).
export function toNDJSON(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
