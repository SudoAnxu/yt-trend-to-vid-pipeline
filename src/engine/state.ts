// ============================================================
// Trend Radar — state.json persistence (the engine's memory)
//
// The Git repo IS the database: state.json carries per-entity
// baselines, momentum history and event clusters across runs so
// acceleration is computed over time, not per-run. CSV and MD are
// projections of this state (human export + dashboard).
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MOMENTUM_HISTORY_MAX } from './config';
import type { StateEntity } from './ner';

export interface TrackedVideo {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  views: number;
}

export interface StateEvent {
  key: string;
  entityKey: string;
  entityName: string;
  title: string;
  category: string;
  t0: string; // first meaningful external signal (ISO)
  lastSeen: string;
  sources: string[]; // all source lanes that ever confirmed
  sourceCounts: Record<string, number>;
  keywords: string[];
  alert: string;
  opportunity: number;
  momentum: number;
  spice: number;
  risk: number;
  acceleration: number;
  status: 'NEW' | 'RESEARCH' | 'KEPT' | 'BOOSTED' | 'ARCHIVED';
  angle: string;
  evidenceConfidence: number;
  videoCount6h: number;
  archetype: string | null;
  ttsForecastHours: number | null;
  windowState: 'open' | 'closing' | 'closed' | 'unknown';
  windowRemainingMin: number | null;
  researchRuns: number;
  probeHistory: { hoursAfterT0: number; videoCount: number }[];
}

export interface RadarState {
  version: number;
  lastRunAt: string | null;
  runCount: number;
  entities: Record<string, StateEntity>; // key = lowercase canonical name
  events: Record<string, StateEvent>; // key = eventKey
  recentSignals: { text: string; source: string; observedAt: string }[];
  seenUrls: Record<string, string>; // dedupe -> first seen ISO
  seenText: Record<string, string>; // text dedupe -> last seen ISO
}

export function emptyState(): RadarState {
  return {
    version: 1,
    lastRunAt: null,
    runCount: 0,
    entities: {},
    events: {},
    recentSignals: [],
    seenUrls: {},
    seenText: {},
  };
}

export function statePath(repoRoot: string): string {
  return path.join(repoRoot, 'data', 'state.json');
}

export function loadState(repoRoot: string): RadarState {
  const file = statePath(repoRoot);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RadarState;
    if (!parsed || typeof parsed !== 'object' || !parsed.entities || !parsed.events) {
      return emptyState();
    }
    return {
      ...emptyState(),
      ...parsed,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(repoRoot: string, state: RadarState): void {
  const file = statePath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Bounded state: the repo should not bloat over months of runs.
  state.recentSignals = state.recentSignals.slice(-500);
  const seenUrls = Object.entries(state.seenUrls)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 20_000);
  state.seenUrls = Object.fromEntries(seenUrls);
  const seenText = Object.entries(state.seenText ?? {})
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))
    .slice(0, 20_000);
  state.seenText = Object.fromEntries(seenText);
  for (const e of Object.values(state.entities)) {
    e.momentumHistory = e.momentumHistory.slice(-MOMENTUM_HISTORY_MAX);
    e.lastSources = (e.lastSources ?? []).slice(0, 8);
  }

  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export function newEventKey(entityName: string, title: string): string {
  const slug = `${entityName}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug;
}

export function newEntityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
