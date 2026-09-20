// ============================================================
// Trend Radar — engine config
// Ported from the YT Intel app engine (same formulas, same
// versioning). All weights/thresholds are tunable via
// config/radar.yaml (see config.ts loader in main).
// ============================================================

export const ENGINE_VERSION = 'radar-v1.0.0';
export const SCORE_VERSION = 'v1';

/** Cross-source confirmation weights (spec 5.4). */
export const CROSS_SOURCE_WEIGHTS = {
  trend: 0.30,
  news: 0.25,
  community: 0.20,
  youtube: 0.15,
  social_other: 0.10,
} as const;

/** Spice score weights (spec 5.6). */
export const SPICE_WEIGHTS = {
  conflict: 0.18,
  surprise: 0.14,
  money: 0.12,
  mystery: 0.14,
  celebrity: 0.10,
  emotional_intensity: 0.10,
  tech_business_angle: 0.08,
  visual_potential: 0.07,
  consequence: 0.07,
} as const;

/** Opportunity score weights (spec 5.7). */
export const OPPORTUNITY_WEIGHTS = {
  momentum: 0.40,
  spice: 0.25,
  novelty: 0.10,
  visual_fit: 0.10,
  searchability: 0.10,
  saturation_penalty: 0.20,
  risk_penalty: 0.15,
} as const;

/** Initial alert thresholds (spec 12). Calibrate with replay data. */
export const THRESHOLDS = {
  /** Candidate emergence: 2 independent sources within the gate window, or 1 high-confidence trend + 1 corroborator. */
  candidateMinSources: 2,
  candidateWindowMin: 45,
  candidateHighConfTrend: 0.80,

  trendAlert: 2.5,
  trendAlertStrong: 5.0,

  /** YouTube open window: < 15 relevant videos in 6h. */
  openWindowMaxVideos: 15,
  openWindowHours: 6,

  researchGateOpportunity: 70,
  researchGateRisk: 35,

  strikeOpportunity: 85,
  strikeMaxAgeHours: 6,
  strikeEvidenceConfidence: 0.8,
} as const;

/** Laplace smoothing epsilon for baseline ratios (spec 5.1). */
export const BASELINE_EPSILON = 0.5;

/**
 * Baseline volume per entity per window before the engine has real
 * history. Emerging names have tiny baselines by definition — the
 * prior must sit near zero so first-hour mentions ARE the spike.
 */
export const DEFAULT_BASELINE_VOLUME = 0.5;

/** Person-likelihood floor before entity resolution runs. */
export const PERSON_PROB_FLOOR = 0.75;

/** Alert level cutoffs for the CSV/MD ladder. */
export const WATCH_FLOOR = 45;

/** Deep-pass gate: candidate must clear this many independent sources. */
export const DEEP_PASS_MIN_SOURCES = 2;

/** Momentum history window kept per entity in state.json. */
export const MOMENTUM_HISTORY_MAX = 48;

/** Display timezone for the operator dashboard. */
export const DISPLAY_TZ = process.env.RADAR_TZ ?? 'Asia/Kolkata';

export type AlertLevel = 'STRIKE NOW' | 'STRIKE WINDOW' | 'WATCH' | 'ARCHIVE';
