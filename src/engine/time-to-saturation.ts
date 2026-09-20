// ============================================================
// Trend Radar — Time-to-Saturation (TTS)
// Faithful port of the app engine's time-to-saturation.ts.
//
// The competitive advantage is not "can we find trending people"
// — it is "can we find them while everyone else hasn't made the
// video yet". TTS models exactly that: for a story archetype,
// how many hours after T0 does YouTube coverage saturate, and is
// OUR first-mover window still open?
//
// Dual-momentum gate:
//   external momentum accelerating + YouTube momentum still low
//   => OPPORTUNITY WINDOW => STRIKE NOW
// ============================================================

type Say = (step: string, message: string, level?: 'info' | 'warn' | 'error', count?: number) => void;

export interface Archetype {
  key: string;
  label: string;
  ttsMedianHours: number;
  ttsLow: number;
  ttsHigh: number;
  priorVideosAt1h: number;
  priorVideosAt6h: number;
}

export const ARCHETYPES: Archetype[] = [
  { key: 'breaking_scandal', label: 'Breaking scandal / allegation', ttsMedianHours: 3.5, ttsLow: 2, ttsHigh: 6, priorVideosAt1h: 2, priorVideosAt6h: 28 },
  { key: 'creator_drama', label: 'Creator drama / feud', ttsMedianHours: 4.2, ttsLow: 2.5, ttsHigh: 8, priorVideosAt1h: 3, priorVideosAt6h: 42 },
  { key: 'business_tech', label: 'Business / tech story', ttsMedianHours: 7.5, ttsLow: 4, ttsHigh: 14, priorVideosAt1h: 1, priorVideosAt6h: 12 },
  { key: 'celebrity_echo', label: 'Celebrity mainstream echo', ttsMedianHours: 6.0, ttsLow: 3, ttsHigh: 12, priorVideosAt1h: 2, priorVideosAt6h: 35 },
  { key: 'slow_burn', label: 'Slow-burn institutional story', ttsMedianHours: 16.0, ttsLow: 9, ttsHigh: 36, priorVideosAt1h: 0, priorVideosAt6h: 5 },
];

const ARCHETYPE_SIGNALS: Record<string, { any?: string[] }> = {
  breaking_scandal: {
    any: ['lawsuit', 'sued', 'charged', 'arrested', 'allegations', 'alleged', 'fraud', 'investigation', 'leaked', 'walked off', 'fired'],
  },
  creator_drama: {
    any: ['feud', 'beef', 'drama', 'responds', 'responded', 'called out', 'claps back', 'streamer', 'youtuber', 'creator', 'discord', 'stream'],
  },
  business_tech: {
    any: ['merger', 'acquisition', 'funding', 'ipo', 'startup', 'launches', 'launched', 'ai', 'app', 'valuation', 'acquires', 'shutdown', 'bankrupt'],
  },
  celebrity_echo: {
    any: ['actor', 'singer', 'rapper', 'star', 'celebrity', 'icon', 'award', 'album', 'movie', 'film',
      'wnba', 'nba', 'nfl', 'nhl', 'mlb', 'ufc', 'boxing', 'olympics', 'fifa', 'soccer', 'tennis'],
  },
  slow_burn: {
    any: ['testified', 'committee', 'hearing', 'report', 'study', 'policy', 'regulator', 'senate', 'inquiry', 'documents'],
  },
};

export function classifyArchetype(text: string): { archetype: Archetype; scores: Record<string, number> } {
  const t = ` ${text.toLowerCase()} `;
  const scores: Record<string, number> = {};
  for (const [key, pats] of Object.entries(ARCHETYPE_SIGNALS)) {
    let s = 0;
    for (const p of pats.any ?? []) {
      if (t.includes(p)) s += 1;
    }
    scores[key] = s;
  }
  let bestKey = 'business_tech';
  let best = -1;
  for (const [key, s] of Object.entries(scores)) {
    if (s > best) {
      best = s;
      bestKey = key;
    }
  }
  const archetype = ARCHETYPES.find((a) => a.key === bestKey) ?? ARCHETYPES[2];
  return { archetype, scores };
}

/**
 * Weighted mean with more weight on evidence than prior when we have
 * at least a couple of probe points, capped so priors never vanish.
 */
export function blendEstimates(prior: number, observed: number[], maxObservedWeight = 0.7): number {
  if (observed.length === 0) return prior;
  const w = Math.min(maxObservedWeight, 0.25 * observed.length);
  const obs = observed.reduce((a, b) => a + b, 0) / observed.length;
  return (1 - w) * prior + w * obs;
}

export interface SaturationProbe {
  hoursAfterT0: number;
  videoCount: number;
}

export interface TtsForecast {
  archetype: string;
  archetypeLabel: string;
  ttsMedianHours: number;
  ttsLow: number;
  ttsHigh: number;
  basis: string;
}

/**
 * Forecast TTS given archetype + observed (hoursAfterT0, videoCount)
 * probe points. Saturation threshold: coverage reaching ~80% of the
 * archetype's typical 6h count, or crossing 15 videos.
 */
export function forecastTts(args: {
  text: string;
  t0: Date;
  now: Date;
  probes: SaturationProbe[];
}): TtsForecast {
  const { archetype, scores } = classifyArchetype(args.text);
  const ageH = Math.max(0.01, (args.now.getTime() - args.t0.getTime()) / 3600_000);

  const observedPace: number[] = [];
  for (const p of args.probes) {
    const expected = archetype.priorVideosAt6h * Math.min(1, p.hoursAfterT0 / 6);
    if (p.videoCount > expected * 1.5) {
      observedPace.push(archetype.ttsMedianHours * Math.max(0.5, expected / p.videoCount));
    } else if (p.videoCount < expected * 0.5 && p.hoursAfterT0 >= 2) {
      observedPace.push(archetype.ttsMedianHours * 1.4);
    }
  }
  const median = blendEstimates(archetype.ttsMedianHours, observedPace);
  const spreadScale = median / archetype.ttsMedianHours;

  const parts = [
    `archetype=${archetype.key} (keyword scores ${Object.entries(scores)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}:${v}`)
      .join(',') || 'none'})`,
    `age=${ageH.toFixed(1)}h`,
    `probes=${args.probes.length}`,
    observedPace.length ? `pace-adjusted x${(median / archetype.ttsMedianHours).toFixed(2)}` : 'prior-only',
  ];

  return {
    archetype: archetype.key,
    archetypeLabel: archetype.label,
    ttsMedianHours: round1(median),
    ttsLow: round1(Math.max(0.5, archetype.ttsLow * spreadScale)),
    ttsHigh: round1(archetype.ttsHigh * spreadScale),
    basis: parts.join(' | '),
  };
}

export interface DualMomentum {
  external: number;
  youtube: number;
}

export function externalMomentum(ratios: { trend: number; news: number; community: number }): number {
  const m = (r: number) => Math.min(1, Math.log2(Math.max(1, r)) / 3.5) * 100;
  return Math.round(0.45 * m(ratios.trend) + 0.3 * m(ratios.news) + 0.25 * m(ratios.community));
}

export function youtubeMomentum(
  probes: SaturationProbe[],
  archetype: Archetype,
  nowHours: number
): number {
  if (probes.length === 0) return 0;
  const latest = probes[probes.length - 1];
  const expectedNow = archetype.priorVideosAt6h * Math.min(1, nowHours / 6);
  if (expectedNow <= 0) return 0;
  const ratio = latest.videoCount / expectedNow;
  return Math.round(Math.min(1, ratio / 2) * 100);
}

export type WindowState = 'open' | 'closing' | 'closed' | 'unknown';

export interface OpportunityWindow {
  state: WindowState;
  closesAt: Date | null;
  remainingMin: number | null;
  reason: string;
}

/**
 * The opportunity window exists while:
 *   - external momentum is above threshold, AND
 *   - YouTube momentum is still low, AND
 *   - now + production buffer < T0 + forecast TTS.
 * `productionBufferHours` approximates research->upload time.
 */
export function computeOpportunityWindow(args: {
  t0: Date;
  now: Date;
  forecast: TtsForecast;
  ext: number;
  yt: number;
  externalThreshold?: number;
  youtubeThreshold?: number;
  productionBufferHours?: number;
}): OpportunityWindow {
  const extT = args.externalThreshold ?? 45;
  const ytT = args.youtubeThreshold ?? 35;
  const buffer = args.productionBufferHours ?? 2.5;

  const closesAt = new Date(args.t0.getTime() + args.forecast.ttsMedianHours * 3600_000 - buffer * 3600_000);
  const remainingMin = Math.round((closesAt.getTime() - args.now.getTime()) / 60_000);

  if (args.yt >= ytT && args.ext < extT) {
    return { state: 'closed', closesAt, remainingMin: Math.min(0, remainingMin), reason: 'YouTube momentum high while external faded — story already owned by competition' };
  }
  if (remainingMin <= 0) {
    return { state: 'closed', closesAt, remainingMin: 0, reason: `forecast window elapsed (TTS ${args.forecast.ttsMedianHours}h − ${buffer}h buffer)` };
  }
  if (args.ext < extT) {
    return { state: 'unknown', closesAt, remainingMin, reason: `external momentum ${args.ext} below ${extT} — watching, not striking` };
  }
  if (args.yt >= ytT) {
    return { state: 'closing', closesAt, remainingMin, reason: `YouTube momentum ${args.yt} ≥ ${ytT} — competition flooding in` };
  }
  return {
    state: 'open',
    closesAt,
    remainingMin,
    reason: `external accelerating (${args.ext}) + YouTube still low (${args.yt}); window ≈ ${formatRemaining(remainingMin)} (TTS ${args.forecast.ttsMedianHours}h − ${buffer}h buffer)`,
  };
}

export function windowGateAllowsStrike(w: OpportunityWindow): boolean {
  return w.state === 'open' || w.state === 'closing';
}

export function formatRemaining(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export type { Say };
