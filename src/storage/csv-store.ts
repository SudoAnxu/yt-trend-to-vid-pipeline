// ============================================================
// Trend Radar — CSV store: the persistent story bank
// Columns follow the planned schema plus the TTS/window fields;
// rows upsert per event key so the next run reads history.
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StateEvent } from '../engine/state';

export const CSV_COLUMNS = [
  'event_key', 'detected_at', 'last_seen', 'person', 'event', 'category',
  'momentum', 'acceleration', 'spice', 'risk', 'youtube_saturation',
  'opportunity', 'alert', 'angle', 'status', 'tts_forecast_hours',
  'window_state', 'window_remaining_min', 'sources', 'video_count_6h',
  'score_version',
] as const;

export function csvPath(repoRoot: string): string {
  return path.join(repoRoot, 'data', 'opportunities.csv');
}

interface CsvRow {
  [key: string]: string;
}

export function readCsvRows(repoRoot: string): Record<string, CsvRow> {
  const file = csvPath(repoRoot);
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const header = parseCsvLine(lines[0]);
  const rows: Record<string, CsvRow> = {};
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row: CsvRow = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    if (row.event_key) rows[row.event_key] = row;
  }
  return rows;
}

export function writeCsvRows(repoRoot: string, rows: Record<string, CsvRow>): void {
  const file = csvPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [CSV_COLUMNS.join(',')];
  // Newest activity first.
  const sorted = Object.values(rows).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  for (const row of sorted) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(row[c] ?? '')).join(','));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

export function eventToCsvRow(e: StateEvent, extra: {
  acceleration: number;
  spice: number;
  risk: number;
  scoreVersion: string;
}): CsvRow {
  return {
    event_key: e.key,
    detected_at: e.t0,
    last_seen: e.lastSeen,
    person: e.entityName,
    event: e.title,
    category: e.category,
    momentum: String(e.momentum),
    acceleration: String(extra.acceleration),
    spice: String(extra.spice),
    risk: String(extra.risk),
    youtube_saturation: String(Math.round((e.videoCount6h / 40) * 100)),
    opportunity: String(e.opportunity),
    alert: e.alert,
    angle: e.angle,
    status: e.status,
    tts_forecast_hours: e.ttsForecastHours != null ? String(e.ttsForecastHours) : '',
    window_state: e.windowState,
    window_remaining_min: e.windowRemainingMin != null ? String(e.windowRemainingMin) : '',
    sources: e.sources.join('|'),
    video_count_6h: String(e.videoCount6h),
    score_version: extra.scoreVersion,
  };
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}
