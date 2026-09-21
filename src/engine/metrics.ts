// ============================================================
// Trend Radar — metrics & scoring (faithful port of the app
// engine's metrics.ts). Every formula is pure, explainable and
// versioned; score_version travels with every CSV row.
// ============================================================

import {
  BASELINE_EPSILON,
  CROSS_SOURCE_WEIGHTS,
  SPICE_WEIGHTS,
  OPPORTUNITY_WEIGHTS,
  SCORE_VERSION,
  WATCH_FLOOR,
} from './config';
import type { RiskFactors, SpiceFactors, AlertLevel } from './types';

// ------------------------------------------------------------
// Baseline-normalized signal
// ------------------------------------------------------------

/** ratio = (current + eps) / (baseline + eps); eps avoids div-by-zero. */
export function baselineRatio(current: number, baseline: number): number {
  const eps = BASELINE_EPSILON;
  return (current + eps) / (baseline + eps);
}

export function log1p(n: number): number {
  return Math.log1p(Math.max(0, n));
}

/** velocity = (score_t - score_{t-dt}) / dt. Prefer log1p inputs. */
export function velocity(series: number[], dtMinutes: number): number {
  if (series.length < 2 || dtMinutes <= 0) return 0;
  const a = series[series.length - 1];
  const b = series[series.length - 2];
  return (a - b) / dtMinutes;
}

/** Acceleration = velocity delta. */
export function acceleration(velocities: number[]): number {
  if (velocities.length < 2) return 0;
  return velocities[velocities.length - 1] - velocities[velocities.length - 2];
}

/** Trends rank (no stable volume) into a bounded 0-100 proxy. */
export function rankToProxyScore(rank: number, approxVolume?: number): number {
  if (approxVolume && approxVolume > 0) {
    return Math.min(100, (Math.log10(approxVolume) / 6) * 100);
  }
  if (rank <= 0) return 0;
  return Math.max(0, Math.min(100, 100 - rank * 2));
}

// ------------------------------------------------------------
// Cross-source confirmation (0-100)
// ------------------------------------------------------------

export interface CrossSourceInput {
  trend: number;
  news: number;
  community: number;
  youtube: number;
  socialOther?: number;
}

export function crossSourceScore(inp: CrossSourceInput): number {
  const w = CROSS_SOURCE_WEIGHTS;
  const s =
    w.trend * clamp01(inp.trend) +
    w.news * clamp01(inp.news) +
    w.community * clamp01(inp.community) +
    w.youtube * clamp01(inp.youtube) +
    w.social_other * clamp01(inp.socialOther ?? 0);
  return Math.round(s * 100);
}

/** Independent source lanes confirmed above baseline. */
export function countSourceClusters(lanes: {
  trend: number; news: number; community: number; youtube: number;
}, baseline = 1): number {
  return [
    lanes.trend > baseline,
    lanes.news > baseline,
    lanes.community > baseline,
    lanes.youtube > baseline,
  ].filter(Boolean).length;
}

// ------------------------------------------------------------
// YouTube saturation (0-100)
// ------------------------------------------------------------

export interface SaturationInput {
  recentVideoCount: number;
  medianViewsPerHour: number;
  creatorNormalizedVelocity: number;
  videoCountP50?: number;
  videoCountP90?: number;
  vphP50?: number;
  vphP90?: number;
}

export function youtubeSaturation(inp: SaturationInput): number {
  const vcP50 = inp.videoCountP50 ?? 8;
  const vcP90 = inp.videoCountP90 ?? 40;
  const vphP50 = inp.vphP50 ?? 500;
  const vphP90 = inp.vphP90 ?? 20_000;

  const countDim = percentileRank(inp.recentVideoCount, vcP50, vcP90);
  const vphDim = percentileRank(inp.medianViewsPerHour, vphP50, vphP90);
  const velocityDim = clamp01(inp.creatorNormalizedVelocity);

  const raw = countDim + 0.5 * vphDim + 0.5 * velocityDim;
  return Math.min(100, Math.round((100 * raw) / 2.0));
}

function percentileRank(v: number, p50: number, p90: number): number {
  if (v <= 0) return 0;
  if (v >= p90) return 1;
  if (v <= p50) return 0.5 * (v / p50);
  return 0.5 + 0.43 * ((v - p50) / (p90 - p50));
}

// ------------------------------------------------------------
// Spice score (0-100)
// ------------------------------------------------------------

export function computeSpiceFactors(text: string): SpiceFactors {
  const t = ` ${text.toLowerCase()} `;

  /** One clear mention = 50; saturation at 4+ distinct hits. */
  const hit = (words: string[]): number => {
    let c = 0;
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'g');
      const m = t.match(re);
      if (m) c += 1;
    }
    return c === 0 ? 0 : Math.min(100, Math.round(50 * Math.sqrt(c)));
  };

  const conflict = hit(['feud', 'feuds', 'fight', 'fights', 'beef', 'war', 'vs', 'versus', 'rival', 'rivalry', 'feuding', 'clash', 'conflict', 'dispute', 'disputes', 'attacked', 'attacks', 'slams', 'slammed', 'dragged', 'called out', 'calls out', 'hit back', 'hits back', 'claps back', 'responds', 'responded', 'accused', 'accuses', 'blast', 'blasts', 'confronts']);
  const surprise = hit(['sudden', 'suddenly', 'shock', 'shocking', 'shocks', 'unexpected', 'surprise', 'nobody expected', 'out of nowhere', 'abruptly', 'walked off', 'quit', 'quits', 'fired', 'drops', 'dropped', 'stuns', 'stunned', 'bombshell', 'confirms split', 'gone']);
  const money = hit(['money', 'million', 'billion', 'dollars', 'salary', 'contract', 'contracts', 'paid', 'payment', 'payments', 'sponsor', 'sponsors', 'sponsorship', 'deal', 'deals', 'fund', 'funding', 'bankrupt', 'lawsuit', 'settlement', 'fine', 'fraud', 'payola', 'withheld', 'fees', 'earnings', 'revenue', 'valuation', 'net worth', 'payout', 'payouts']);
  const mystery = hit(['mystery', 'missing', 'secret', 'secretly', 'hidden', 'unknown', 'why', 'what happened', 'what is going on', 'going on with', 'disappeared', 'vanish', 'vanished', 'unexplained', 'silence', 'silent', 'deleted', 'leaked', 'leaks', 'rumor', 'rumors', 'rumored', 'speculation', 'nobody knows', 'uncovered']);
  const celebrity = hit(['celebrity', 'celebrities', 'star', 'stars', 'famous', 'icon', 'ceo', 'founder', 'singer', 'actor', 'actress', 'rapper', 'influencer', 'streamer', 'streamers', 'youtuber', 'youtubers', 'creator', 'creators', 'producer', 'politician', 'label', 'executive']);
  const emotional = hit(['crying', 'cries', 'tears', 'angry', 'furious', 'heartbroken', 'devastated', 'emotional', 'fears', 'panic', 'outrage', 'outraged', 'backlash', 'fans furious', 'fans demand', 'viral meltdown', 'breaks down', 'broke down', 'apology', 'apologizes', 'apologized', 'sorry']);
  const techBiz = hit(['ai', 'app', 'apps', 'startup', 'startups', 'algorithm', 'algorithms', 'data', 'platform', 'platforms', 'merger', 'ipo', 'acquisition', 'acquires', 'valuation', 'funding', 'tech', 'business', 'company', 'companies', 'voice', 'clones', 'cloning', 'tool', 'tools', 'launch', 'launches', 'launched', 'product', 'feature', 'update', 'api', 'crypto', 'blockchain']);
  const visual = hit(['video', 'videos', 'footage', 'stream', 'streamed', 'livestream', 'live stream', 'clip', 'clips', 'recording', 'screenshot', 'screenshots', 'photo', 'photos', 'camera', 'caught on', 'viral video', 'leaked video', 'on camera', 'interview', 'broadcast', 'viral']);
  const consequence = hit(['lawsuit', 'lawsuits', 'sued', 'sues', 'suing', 'arrested', 'arrest', 'charged', 'charging', 'banned', 'ban', 'fired', 'investigation', 'investigators', 'probe', 'hearing', 'hearings', 'testified', 'testimony', 'testifies', 'facing', 'faces', 'could lose', 'shut down', 'shutdown', 'committee', 'subpoena', 'damages', 'penalty', 'penalties', 'divorce', 'custody']);

  return {
    conflict: Math.round(conflict),
    surprise: Math.round(surprise),
    money: Math.round(money),
    mystery: Math.round(mystery),
    celebrity: Math.round(celebrity),
    emotional_intensity: Math.round(emotional),
    tech_business_angle: Math.round(techBiz),
    visual_potential: Math.round(visual),
    consequence: Math.round(consequence),
  };
}

export function spiceScore(f: SpiceFactors): number {
  const w = SPICE_WEIGHTS;
  const s =
    w.conflict * f.conflict +
    w.surprise * f.surprise +
    w.money * f.money +
    w.mystery * f.mystery +
    w.celebrity * f.celebrity +
    w.emotional_intensity * f.emotional_intensity +
    w.tech_business_angle * f.tech_business_angle +
    w.visual_potential * f.visual_potential +
    w.consequence * f.consequence;
  return Math.round(Math.min(100, s));
}

// Channel-fit score for personality-led entertainment/controversy stories.
export function peopleStoryFitScore(f: SpiceFactors): number {
  return Math.round(
    0.22 * f.conflict +
    0.15 * f.surprise +
    0.10 * f.money +
    0.15 * f.mystery +
    0.12 * f.celebrity +
    0.10 * f.emotional_intensity +
    0.06 * f.tech_business_angle +
    0.05 * f.visual_potential +
    0.05 * f.consequence
  );
}

// ------------------------------------------------------------
// Risk + Opportunity
// ------------------------------------------------------------

export function computeRiskFactors(args: {
  evidenceCount: number;
  primaryCount: number;
  reputableCount: number;
  hasLegalClaims: boolean;
  entityAmbiguous: boolean;
  socialOnlySources: boolean;
}): RiskFactors {
  const hasEvidence = args.evidenceCount > 0;
  const rumor = !hasEvidence && args.socialOnlySources ? 45 : !hasEvidence ? 30 : 8;
  const sourcing = args.primaryCount >= 2 ? 5
    : args.primaryCount === 1 ? 12
    : args.reputableCount >= 3 ? 12
    : args.reputableCount >= 1 ? 20
    : 28;
  const reputable = args.reputableCount >= 3 ? 5 : args.reputableCount >= 1 ? 10 : 18;
  const ambiguity = args.entityAmbiguous ? 30 : 6;
  const legal = args.hasLegalClaims ? 22 : 0;
  return {
    rumor_penalty: rumor,
    sourcing_penalty: sourcing,
    ambiguity_penalty: ambiguity,
    legal_claim_penalty: legal,
  };
}

export function riskScore(f: RiskFactors): number {
  return Math.round(Math.min(100,
    f.rumor_penalty + f.sourcing_penalty + f.ambiguity_penalty + f.legal_claim_penalty));
}

export interface OpportunityInput {
  momentum: number;
  spice: number;
  novelty: number;
  visualFit: number;
  searchability: number;
  saturation: number;
  risk: number;
}

export function opportunityScore(inp: OpportunityInput): number {
  const w = OPPORTUNITY_WEIGHTS;
  const s =
    w.momentum * inp.momentum +
    w.spice * inp.spice +
    w.novelty * inp.novelty +
    w.visual_fit * inp.visualFit +
    w.searchability * inp.searchability -
    w.saturation_penalty * inp.saturation -
    w.risk_penalty * inp.risk;
  return Math.round(Math.max(0, Math.min(100, s)));
}

// ------------------------------------------------------------
// Alert level (same ladder as the app, WATCH floor configurable)
// ------------------------------------------------------------

export function alertLevel(args: {
  opportunity: number;
  risk: number;
  ageHours: number;
  evidenceConfidence: number;
  thresholds: {
    strikeOpportunity: number;
    strikeMaxAgeHours: number;
    strikeEvidenceConfidence: number;
    researchGateOpportunity: number;
    researchGateRisk: number;
  };
  watchFloor?: number;
}): AlertLevel {
  const t = args.thresholds;
  if (
    args.opportunity >= t.strikeOpportunity &&
    args.ageHours <= t.strikeMaxAgeHours &&
    args.evidenceConfidence >= t.strikeEvidenceConfidence
  ) {
    return 'STRIKE NOW';
  }
  if (args.opportunity >= t.researchGateOpportunity && args.risk <= t.researchGateRisk) {
    return 'STRIKE WINDOW';
  }
  if (args.opportunity >= (args.watchFloor ?? WATCH_FLOOR)) return 'WATCH';
  return 'ARCHIVE';
}

// ------------------------------------------------------------
// Momentum (0-100) from per-source ratios
// ------------------------------------------------------------

export function momentumScore(ratios: {
  trendRatio: number;
  newsRatio: number;
  communityRatio: number;
}): number {
  // 2x ~ 33, 5x ~ 78, 10x ~ 100 (breakout-scaled)
  const m = (r: number) => clamp01(Math.log2(Math.max(1, r)) / 3.5) * 100;
  return Math.round(
    0.45 * m(ratios.trendRatio) +
    0.30 * m(ratios.newsRatio) +
    0.25 * m(ratios.communityRatio)
  );
}

export function currentScoreVersion(): string {
  return SCORE_VERSION;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
