// ============================================================
// Trend Radar — Markdown dashboard: the human report the repo
// commits after every run. Open the repo and read the answer to
// "what should I make a video about today?"
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DISPLAY_TZ } from '../engine/config';
import type { StateEvent } from '../engine/state';

export function radarPath(repoRoot: string): string {
  return path.join(repoRoot, 'data', 'radar.md');
}

interface Row {
  event: StateEvent;
  spice: number;
  risk: number;
  acceleration: number;
  trendRatio: number;
  newsRatio: number;
  communityRatio: number;
  reasons: string[];
}

export function writeRadarMarkdown(repoRoot: string, args: {
  runNumber: number;
  updatedAt: Date;
  rows: Row[];
  errors: string[];
  sourcesUsed: string[];
}): void {
  const file = radarPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];

  const updated = args.updatedAt.toLocaleString('en-GB', {
    timeZone: DISPLAY_TZ,
    hour12: false,
  });

  lines.push(`# 🔥 TREND RADAR`);
  lines.push('');
  lines.push(`Run #${args.runNumber} · Updated: ${updated} (${DISPLAY_TZ})`);
  lines.push('');
  if (args.errors.length > 0) {
    lines.push(`> ⚠️ Collector issues this run: ${args.errors.join(' · ')}`);
    lines.push('');
  }
  lines.push(`Sources this run: ${args.sourcesUsed.join(', ') || 'none'}`);
  lines.push('');

  const byLevel = (level: string) => args.rows.filter((r) => r.event.alert === level);
  const strikeNow = byLevel('STRIKE NOW');
  const strikeWindow = byLevel('STRIKE WINDOW');
  const watch = byLevel('WATCH');
  const archive = byLevel('ARCHIVE');

  lines.push(`## 🚨 STRIKE NOW (${strikeNow.length})`);
  lines.push('');
  for (const r of strikeNow) pushEvent(lines, r);
  lines.push(`## 🟠 STRIKE WINDOW (${strikeWindow.length})`);
  lines.push('');
  for (const r of strikeWindow) pushEvent(lines, r);
  lines.push(`## 🟡 WATCH (${watch.length})`);
  lines.push('');
  for (const r of watch.slice(0, 8)) pushEvent(lines, r);
  if (watch.length > 8) lines.push(`_…and ${watch.length - 8} more watching_`, '');
  lines.push(`## ⚫ ARCHIVED (${archive.length})`);
  lines.push('');
  lines.push(`<details><summary>show</summary>`);
  lines.push('');
  for (const r of archive.slice(0, 15)) pushEvent(lines, r, true);
  lines.push('');
  lines.push(`</details>`);
  lines.push('');
  lines.push('---');
  lines.push(`_Scores: score_version v1 · ε-smoothed baselines · window gate: external momentum + low YouTube competition (TTS forecast). Angles are templates; verify every factual claim before scripting._`);

  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function pushEvent(lines: string[], r: Row, compact = false): void {
  const e = r.event;
  lines.push(`### ${e.entityName} — ${e.opportunity}/100`);
  lines.push('');
  lines.push(`**Event:** ${e.title}`);
  lines.push('');
  if (!compact) {
    lines.push('```');
    lines.push(`Momentum:       ${bar(e.momentum)} ${e.momentum}`);
    lines.push(`Acceleration:   ${bar(r.acceleration)} ${r.acceleration}`);
    lines.push(`Spice:          ${bar(r.spice)} ${r.spice}`);
    lines.push(`Risk:           ${bar(100 - r.risk)} ${r.risk}`);
    lines.push(`YT Saturation:  ${bar(100 - satPct(e.videoCount6h))} ${satPct(e.videoCount6h)}`);
    lines.push('```');
    lines.push('');
  }
  const win = e.windowState === 'open' || e.windowState === 'closing';
  lines.push(`**Why now:** ${r.reasons.join(' · ') || 'cross-source attention confirmed'}`);
  lines.push('');
  lines.push(`**Recommended angle**`);
  lines.push('');
  lines.push(`> ${e.angle}`);
  lines.push('');
  lines.push(
    `**Competition:** ${e.videoCount6h} videos in last 6h` +
    (e.ttsForecastHours != null
      ? ` · TTS ≈ ${e.ttsForecastHours}h` +
        (win && e.windowRemainingMin != null ? ` · window ${e.windowRemainingMin >= 0 ? 'opens/closes in' : 'expired'} ${Math.abs(e.windowRemainingMin)}m` : '')
      : '') +
    ` · sources: ${e.sources.join(', ')}`
  );
  lines.push('');
  lines.push(`**Status:** ${e.status}`);
  lines.push('');
}

function satPct(videoCount6h: number): number {
  return Math.min(100, Math.round((videoCount6h / 40) * 100));
}

function bar(score: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const filled = Math.round(clamped / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
