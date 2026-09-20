// ============================================================
// Trend Radar — shared types
// ============================================================

export interface Signal {
  source: 'trends' | 'news' | 'gdelt' | 'reddit' | 'youtube' | 'manual';
  text: string;
  url?: string;
  observedAt?: string; // ISO
  score?: number; // source-native 0-100 proxy or engagement
  comments?: number;
  metric?: string;
  region?: string;
  query?: string;
}

export interface EntityCandidate {
  name: string;
  personProb: number;
  contextVerbsHit: string[];
  roleContextHit: string | null;
  homonymPenalty: number;
}

export interface SpiceFactors {
  conflict: number;
  surprise: number;
  money: number;
  mystery: number;
  celebrity: number;
  emotional_intensity: number;
  tech_business_angle: number;
  visual_potential: number;
  consequence: number;
}

export interface RiskFactors {
  rumor_penalty: number;
  sourcing_penalty: number;
  ambiguity_penalty: number;
  legal_claim_penalty: number;
}

export interface Opportunity {
  person: string;
  event: string;
  category: string;
  momentum: number;
  acceleration: number;
  spice: number;
  risk: number;
  youtubeSaturation: number;
  opportunity: number;
  alert: AlertLevel;
  angle: string;
  status: 'NEW' | 'RESEARCH' | 'KEPT' | 'BOOSTED' | 'ARCHIVED';
  detectedAt: string;
  lastSeenAt: string;
  sources: string[];
  sourceCounts: Record<string, number>;
  keywords: string[];
  evidenceConfidence: number;
  videoCount6h: number;
  ttsForecastHours: number | null;
  ttsLowHours: number | null;
  ttsHighHours: number | null;
  archetype: string | null;
  windowState: 'open' | 'closing' | 'closed' | 'unknown';
  windowRemainingMin: number | null;
  momentumHistory: number[];
  scoreVersion: string;
}

export type AlertLevel = 'STRIKE NOW' | 'STRIKE WINDOW' | 'WATCH' | 'ARCHIVE';

/** Novelty classes (spec 7.3). */
export type NoveltyClass = 'NEW' | 'KNOWN' | 'REACTIVATED' | 'SATURATED';
