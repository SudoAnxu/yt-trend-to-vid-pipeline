// ============================================================
// Trend Radar — config/radar.yaml loader
// Simple key: value YAML subset (no dependency). Only scalars and
// one flat list type are supported; everything falls back to the
// code defaults in engine/config.ts when absent.
// ============================================================

import * as path from 'node:path';
import * as fs from 'node:fs';

export type RadarYaml = Record<string, string | number | boolean | string[]>;

export function loadRadarYaml(repoRoot: string): RadarYaml {
  const out: RadarYaml = {};
  const file = path.join(repoRoot, 'config', 'radar.yaml');
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s*(.+)$/);
    if (listMatch && currentListKey) {
      const arr = out[currentListKey];
      if (Array.isArray(arr)) (arr as string[]).push(String(parseScalar(listMatch[1].trim())));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '' ) {
      // Could be a list header; nothing to store yet.
      currentListKey = key;
      out[key] = [] as string[];
      continue;
    }
    currentListKey = null;
    out[key] = parseScalar(val);
  }
  return out;
}

function parseScalar(v: string): string | number | boolean {
  const s = v.trim().replace(/^["']|["']$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

export function num(y: RadarYaml, key: string, fallback: number): number {
  const v = y[key];
  return typeof v === 'number' ? v : fallback;
}

export function strList(y: RadarYaml, key: string, fallback: string[]): string[] {
  const v = y[key];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return fallback;
}
