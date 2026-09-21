// ============================================================
// Trend Radar — main orchestrator
//
// Every run:
//   load state -> fetch cheap signals -> dedupe -> extract people
//   -> resolve against state -> emergence gate -> cluster -> score
//   -> TTS/window gate -> update CSV/MD/state -> (Actions commits)
//
// Adaptive two-stage (quota + money discipline):
//   Stage 1 every run: Trends RSS + GDELT (free, no keys).
//   Stage 2 only for spike candidates (2+ source lanes):
//     Reddit search + YouTube probe (+ LLM angles if configured).
// ============================================================

import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  THRESHOLDS,
  DEFAULT_BASELINE_VOLUME,
  SCORE_VERSION,
} from './engine/config';
import type { Signal, RiskFactors, AlertLevel, NoveltyClass } from './engine/types';
import { extractNameCandidates, expandAliases, resolveDeterministic, classifyNovelty } from './engine/ner';
import {
  baselineRatio,
  log1p,
  velocity,
  acceleration,
  computeSpiceFactors,
  spiceScore,
  peopleStoryFitScore,
  computeRiskFactors,
  riskScore,
  opportunityScore,
  alertLevel,
  momentumScore,
  crossSourceScore,
  youtubeSaturation,
} from './engine/metrics';
import { clusterSignalsKeywordOnly, titleCase } from './engine/cluster';
import {
  classifyArchetype,
  forecastTts,
  externalMomentum,
  youtubeMomentum,
  computeOpportunityWindow,
  windowGateAllowsStrike,
} from './engine/time-to-saturation';
import type { SaturationProbe } from './engine/time-to-saturation';
import {
  loadState,
  saveState,
  newEntityKey,
} from './engine/state';
import type { RadarState, StateEvent } from './engine/state';
import { loadRadarYaml, num as yamlNum, strList as yamlList } from './engine/yaml-config';

import { fetchTrendsRss } from './collectors/trends';
import { fetchGdelt } from './collectors/gdelt';
import { fetchReddit, hasRedditOauth } from './collectors/reddit';
import { probePersonVideos, hasYouTubeKey } from './collectors/youtube';
import { generateAngle } from './agents/angle-agent';
import { eventToCsvRow, readCsvRows, writeCsvRows } from './storage/csv-store';
import { writeRadarMarkdown } from './storage/markdown-report';

// Compiled to CommonJS (package.json has no "type": "module"), so the
// Node global __dirname is available and points at dist/.
const REPO_ROOT = path.resolve(__dirname, '..');

const REPUTABLE_DOMAINS = new Set([
  'reuters.com', 'apnews.com', 'bloomberg.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com',
  'washingtonpost.com', 'wsj.com', 'theguardian.com', 'ft.com', 'cnbc.com', 'npr.org',
  'variety.com', 'hollywoodreporter.com', 'deadline.com', 'theverge.com', 'techcrunch.com',
]);

const WIRE_DOMAINS = new Set(['reuters.com', 'apnews.com', 'bloomberg.com']);

interface RunRow {
  event: StateEvent;
  spice: number;
  risk: number;
  acceleration: number;
  trendRatio: number;
  newsRatio: number;
  communityRatio: number;
  reasons: string[];
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const yaml = loadRadarYaml(REPO_ROOT);
  const state = loadState(REPO_ROOT);
  state.runCount += 1;
  const runNo = state.runCount;
  const errors: string[] = [];
  const addErr = (e: string) => { if (!errors.includes(e)) errors.push(e); };
  const sourcesUsed: string[] = [];
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    console.log(s);
  };

  const redditSubs = yamlList(yaml, 'reddit_subreddits', [
    'technology', 'entertainment', 'music', 'movies', 'gaming', 'popculturechat', 'youtubedrama', 'news',
  ]);
  const gateWindowMin = yamlNum(yaml, 'gate_window_minutes', 45);
  const deepPassMinSources = yamlNum(yaml, 'deep_pass_min_sources', 2);
  const probeGateCrossSource = yamlNum(yaml, 'probe_gate_cross_source', 25);
  const highConfTrendScore = yamlNum(yaml, 'high_conf_trend_score', 75);
  const gdeltMinutesBack = yamlNum(yaml, 'gdelt_minutes_back', 60);

  say(`RUN #${runNo} — ${new Date().toISOString()}`);

  // ----------------------------------------------------------
  // Stage 1: cheap discovery (always free)
  // ----------------------------------------------------------
  const signals: Signal[] = [];
  const trends = await fetchTrendsRss();
  signals.push(...trends.signals);
  trends.errors.forEach(addErr);
  if (trends.signals.length) sourcesUsed.push(`trends(${trends.signals.length})`);

  const gdelt = await fetchGdelt({ minutesBack: gdeltMinutesBack, maxRecords: 75 });
  signals.push(...gdelt.signals);
  gdelt.errors.forEach(addErr);
  if (gdelt.signals.length) sourcesUsed.push(`gdelt(${gdelt.signals.length})`);

  // ----------------------------------------------------------
  // Dedupe (URL + text)
  // ----------------------------------------------------------
  const nowIso = new Date().toISOString();
  const fresh: Signal[] = [];
  const observed: Signal[] = [];
  const seenText = new Set<string>();
  for (const s of signals) {
    const urlKey = s.url ? `u:${s.url}` : null;
    const textKey = `t:${s.source}:${s.text.toLowerCase().trim()}`;
    // Frequency-preserving dedupe: exact repeats (same URL or text) only
    // count once per run, but different signals about the same story all
    // count — repeat attention across runs must stay observable.
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);
    if (urlKey && state.seenUrls[urlKey]) continue;
    fresh.push(s);
    observed.push(s);
  }
  // Observed-but-already-seen signals still count as current attention
  // (a trend topic persisting across runs is momentum, not noise).
  for (const s of signals) {
    const textKey = `t:${s.source}:${s.text.toLowerCase().trim()}`;
    if (seenText.has(textKey)) continue;
    seenText.add(textKey);
    observed.push(s);
  }
  // Record everything observed so later runs can dedupe.
  for (const s of signals) {
    const textKey = `t:${s.source}:${s.text.toLowerCase().trim()}`;
    state.seenText[textKey] = nowIso;
    if (s.url) state.seenUrls[s.url] = state.seenUrls[s.url] ?? nowIso;
  }
  say(
    `ingest: ${signals.length} fetched -> ${fresh.length} fresh / ${observed.length} observed this run`
  );

  // ----------------------------------------------------------
  // Extract + resolve people (deterministic; state is memory)
  // ----------------------------------------------------------
  const entities = state.entities;
  const perPersonSignals = new Map<string, Signal[]>();
  const noveltyByPerson = new Map<string, { novelty: NoveltyClass; isNew: boolean }>();

  for (const s of observed) {
    const cands = extractNameCandidates(s.text);
    for (const c of cands.slice(0, 3)) {
      const res = resolveDeterministic(c, Object.values(entities));
      let key: string;
      let isNew = false;
      if (res.matched) {
        key = res.matched.key;
        if (!noveltyByPerson.has(key)) {
          // Classify BEFORE touching lastSeen/mentionCount.
          const nov = classifyNovelty(
            { mentionCount: res.matched.mentionCount, lastSeen: res.matched.lastSeen, status: res.matched.status },
            0
          );
          noveltyByPerson.set(key, { novelty: nov.novelty, isNew: false });
        }
      } else {
        key = newEntityKey(c.name);
        isNew = true;
        if (!entities[key]) {
          entities[key] = {
            key,
            canonicalName: c.name,
            aliases: expandAliases(c.name).filter((a) => a.toLowerCase() !== c.name.toLowerCase()),
            type: 'person',
            confidence: res.confidence,
            firstSeen: nowIso,
            lastSeen: nowIso,
            mentionCount: 0,
            momentumHistory: [],
            baselineVolume: DEFAULT_BASELINE_VOLUME,
            lastSources: [],
            status: 'monitoring',
          };
          noveltyByPerson.set(key, { novelty: 'NEW', isNew: true });
        }
      }
      const ent = entities[key];
      ent.mentionCount += 1;
      ent.lastSeen = nowIso;
      if (!ent.lastSources.includes(s.source)) ent.lastSources = [...ent.lastSources, s.source].slice(-8);
      const arr = perPersonSignals.get(key) ?? [];
      arr.push(s);
      perPersonSignals.set(key, arr);
    }
  }
  say(`extraction: ${perPersonSignals.size} distinct people touched`);

  // ----------------------------------------------------------
  // Emergence gate: which candidates get the deep pass?
  // ----------------------------------------------------------
  const GATE_WINDOW_MS = gateWindowMin * 60_000;
  const deepCandidates = [...perPersonSignals.entries()].filter(([key, sigs]) => {
    const recent = sigs.filter((s) => {
      const t = s.observedAt ? new Date(s.observedAt).getTime() : Date.now();
      return Date.now() - t <= GATE_WINDOW_MS;
    });
    const lanes = new Set(recent.map((s) => s.source));
    if (lanes.size >= deepPassMinSources) return true;
    // Multiple DISTINCT headlines about one person within the window are
    // independent confirmation too (different articles = different
    // coverage decisions), even inside one lane.
    if (recent.length >= 3) return true;
    // Sustained-story pass: an already-open event with fresh mentions
    // always gets the deep pass — this is the KEEP/BOOST loop.
    for (const ev of Object.values(state.events)) {
      if (ev.entityKey === key && ev.status !== 'ARCHIVED') return true;
    }
    // Calibration escape hatch: a strong Google Trends rank is enough
    // to earn a deep pass even before the radar has a mature cross-source
    // baseline. This lets YouTube measure saturation on genuinely strong
    // emerging attention instead of waiting for historical momentum.
    const strongestTrend = Math.max(
      ...recent
        .filter((s) => s.source === 'trends' || (s.source === 'news' && (s.metric ?? '').startsWith('via trends')))
        .map((s) => s.score ?? 0),
      0
    );
    if (strongestTrend >= highConfTrendScore) return true;
    // Single Trends lane + sustained mention pressure remains valid.
    if (lanes.has('trends') && entities[key].mentionCount >= 3) return true;
    return false;
  });
  say(`gate: ${deepCandidates.length}/${perPersonSignals.size} candidates pass -> deep pass`);

  // ----------------------------------------------------------
  // Stage 2: deep pass (Reddit for gated candidates)
  // ----------------------------------------------------------
  for (const [key, sigs] of deepCandidates.slice(0, 8)) {
    const ent = entities[key];
    // Reddit is an optional enrichment lane. In GitHub Actions, the
    // public JSON endpoint is commonly blocked; don't turn that expected
    // absence into collector failures or waste retries. OAuth enables it.
    if (hasRedditOauth()) {
      const reddit = await fetchReddit({
        query: ent.canonicalName,
        subreddits: redditSubs,
        minutesBack: 24 * 60,
        limit: 15,
      });
      sigs.push(...reddit.signals);
      reddit.errors.forEach(addErr);
      if (reddit.signals.length) sourcesUsed.push(`reddit:${ent.canonicalName}(${reddit.signals.length})`);
    }
  }

  // ----------------------------------------------------------
  // Score each deep candidate -> events
  // ----------------------------------------------------------
  const rows: RunRow[] = [];
  for (const [key, sigs] of deepCandidates) {
    const ent = entities[key];
    const corpus = sigs.map((s) => s.text).join(' ');
    // One active story-thread per person: the event key must be stable
    // across runs or momentum history cannot accumulate (the keyword
    // phrase in the title drifts; the person is the stable join key).
    // A new thread opens only after the old one is archived (14d quiet).
    const eventKey = `story-${key}`;
    const ev = state.events[eventKey] ?? null;

    // Lane counts (this run's signals + accumulated for existing events).
    const laneCounts = countLanes(sigs);
    let sources: string[];
    let sourceCounts: Record<string, number>;
    if (ev) {
      for (const [src, n] of laneCounts) {
        if (!ev.sources.includes(src)) ev.sources.push(src);
        ev.sourceCounts[src] = (ev.sourceCounts[src] ?? 0) + n;
      }
      sources = ev.sources;
      sourceCounts = ev.sourceCounts;
    } else {
      sources = [...laneCounts.keys()];
      sourceCounts = Object.fromEntries(laneCounts);
    }

    const trendCount =
      (laneCounts.get('trends') ?? 0) +
      // News items attached to a trending topic are part of Google's
      // trend spike for that topic — credit the trend lane at half
      // weight (avoids double counting with the news lane).
      sigs.filter((s) => s.source === 'news' && (s.metric ?? '').startsWith('via trends')).length;
    const newsCount = (laneCounts.get('news') ?? 0) + (laneCounts.get('gdelt') ?? 0);
    const communityCount = laneCounts.get('reddit') ?? 0;

    // Baselines + ratios (log1p volumes, ε-smoothed).
    const totalMentions = sigs.length;
    const baseline = Math.max(ent.baselineVolume, 0.3);
    const vol = log1p(totalMentions);
    const baselineVol = log1p(baseline * 2);
    const vel = velocity([baselineVol, vol], Math.max(15, minutesSinceLastRun(state)));
    const acc = acceleration([0, vel]);
    void acc;

    // Ratios on log1p volumes (as in the app pipeline): raw counts under
    // the ε floor vanish; log1p keeps small-but-real volumes visible.
    const trendRatio = baselineRatio(log1p(trendCount), log1p(baseline * 0.3));
    const newsRatio = baselineRatio(log1p(newsCount), log1p(baseline * 0.3));
    const communityRatio = baselineRatio(log1p(communityCount), log1p(baseline * 0.2));
    const momentum = momentumScore({ trendRatio, newsRatio, communityRatio });

    // Momentum history drives cross-run acceleration.
    ent.momentumHistory.push(momentum);
    const hist = ent.momentumHistory;
    const momentumAcc = hist.length >= 2 ? momentum - hist[hist.length - 2] : 0;

    // Cross-source confirmation.
    const crossSource = crossSourceScore({
      trend: clamp01(trendCount / 3),
      news: clamp01(newsCount / 5),
      community: clamp01(communityCount / 5),
      youtube: 0,
    });

    // Spice from the combined signal text.
    const spiceFactors = computeSpiceFactors(corpus);
    const spice = spiceScore(spiceFactors);
    const peopleStoryFit = peopleStoryFitScore(spiceFactors);

    // YouTube probe gate: quota only when attention is real.
    const t0Ms = ev ? new Date(ev.t0).getTime() : Date.now();
    let probes: SaturationProbe[] = ev?.probeHistory ?? [];
    let probeVideos = probes.length > 0 ? probes[probes.length - 1].videoCount : 0;
    const trendLinkedEvidence = sigs.some(
      (s) =>
        (s.source === 'trends' || (s.source === 'news' && (s.metric ?? '').startsWith('via trends'))) &&
        (s.score ?? 0) >= highConfTrendScore
    );
    const shouldProbe = (crossSource >= probeGateCrossSource || trendLinkedEvidence) && hasYouTubeKey();
    if (shouldProbe) {
      const probe = await probePersonVideos(ent.canonicalName, 6);
      probe.errors.forEach(addErr);
      if (probe.unitsUsed > 0) {
        probes = [
          ...probes,
          { hoursAfterT0: round2((Date.now() - t0Ms) / 3600_000), videoCount: probe.videos.length },
        ].slice(-12);
        probeVideos = probe.videos.length;
        say(`youtube probe: ${ent.canonicalName} -> ${probe.videos.length} videos (${probe.unitsUsed} units)`);
      }
    }

    const saturation = youtubeSaturation({
      recentVideoCount: probeVideos,
      medianViewsPerHour: 0,
      creatorNormalizedVelocity: 0,
    });

    // Sourcing tiers for risk.
    const domains = new Set(
      sigs
        .map((s) => {
          try {
            return s.url ? new URL(s.url).hostname.replace(/^www\./, '') : '';
          } catch {
            return '';
          }
        })
        .filter(Boolean)
    );
    const reputableCount = [...domains].filter((d) => REPUTABLE_DOMAINS.has(d)).length;
    const primaryCount = [...domains].filter((d) => WIRE_DOMAINS.has(d)).length;
    const socialOnly = sigs.every((s) => s.source === 'reddit');

    const riskFactors: RiskFactors = computeRiskFactors({
      evidenceCount: reputableCount,
      primaryCount,
      reputableCount,
      hasLegalClaims: /\b(lawsuit|sued|sues|charged|fraud|subpoena)\b/i.test(corpus),
      entityAmbiguous: ent.confidence < 0.85,
      socialOnlySources: socialOnly && sigs.length < 3,
    });
    const risk = riskScore(riskFactors);

    // Novelty + opportunity.
    const nov = noveltyByPerson.get(key) ?? { novelty: 'KNOWN' as NoveltyClass, isNew: false };
    const noveltyScore = nov.isNew ? 100 : nov.novelty === 'REACTIVATED' ? 80 : 55;
    const archetypeInfo = classifyArchetype(corpus);
    const visualFit = archetypeInfo.archetype.key === 'business_tech' ? 70 : 85;
    const searchability = Math.min(100, 50 + ent.mentionCount * 2);

    const opportunity = opportunityScore({
      momentum,
      spice: Math.round((spice * 0.75) + (peopleStoryFit * 0.25)),
      novelty: noveltyScore,
      visualFit,
      searchability,
      saturation,
      risk,
    });

    // TTS + dual-momentum window gate.
    const t0 = new Date(t0Ms);
    const tts = forecastTts({ text: corpus, t0, now: new Date(), probes });
    const ext = externalMomentum({ trend: trendRatio, news: newsRatio, community: communityRatio });
    const ytMom = youtubeMomentum(probes, archetypeInfo.archetype, (Date.now() - t0Ms) / 3600_000);
    const win = computeOpportunityWindow({ t0, now: new Date(), forecast: tts, ext, yt: ytMom });

    // Alert ladder + evidence-confidence gate + window gate.
    const ageHours = (Date.now() - t0Ms) / 3600_000;
    const evidenceConfidence = Math.min(
      0.9,
      0.4 + 0.1 * primaryCount + 0.08 * reputableCount + (crossSource >= 40 ? 0.2 : 0)
    );
    let alert: AlertLevel = alertLevel({
      opportunity,
      risk,
      ageHours,
      evidenceConfidence,
      thresholds: THRESHOLDS,
    });
    if (alert === 'STRIKE NOW' && !windowGateAllowsStrike(win)) {
      alert = 'STRIKE WINDOW';
    }

    // Angle (deterministic template; LLM polish only if configured).
    const title = dominantTopic(sigs, ent.canonicalName);
    const angle = await generateAngle({
      person: ent.canonicalName,
      eventTitle: title,
      archetype: tts.archetype,
      spice: spiceFactors,
      signalSample: sigs.slice(0, 6).map((s) => s.text),
    });

    const reasons = [
      `${sources.length} source lane(s): ${sources.join(', ')}`,
      `momentum ${momentum} (${momentumAcc >= 0 ? '+' : ''}${momentumAcc} vs prev run)`,
      `spice ${spice} · risk ${risk}`,
      win.reason,
    ];

    let event: StateEvent;
    if (!ev) {
      event = {
        key: eventKey,
        entityKey: key,
        entityName: ent.canonicalName,
        title,
        category: categoryOf(tts.archetype),
        t0: nowIso,
        lastSeen: nowIso,
        sources,
        sourceCounts,
        keywords: clusterSignalsKeywordOnly(sigs).keywords,
        alert,
        opportunity,
        momentum,
        spice,
        risk,
        acceleration: momentumAcc,
        status: alert === 'STRIKE NOW' || alert === 'STRIKE WINDOW' ? 'NEW' : 'RESEARCH',
        angle,
        evidenceConfidence,
        videoCount6h: probeVideos,
        archetype: tts.archetype,
        ttsForecastHours: tts.ttsMedianHours,
        windowState: win.state,
        windowRemainingMin: win.remainingMin,
        researchRuns: 0,
        probeHistory: probes,
      };
      state.events[eventKey] = event;
      say(`event: NEW "${event.title}" for ${ent.canonicalName} -> ${alert} (${opportunity}/100)`);
    } else {
      event = ev;
      ev.lastSeen = nowIso;
      ev.alert = alert;
      ev.opportunity = opportunity;
      ev.momentum = momentum;
      ev.spice = spice;
      ev.risk = risk;
      ev.acceleration = momentumAcc;
      ev.angle = angle;
      ev.videoCount6h = Math.max(ev.videoCount6h, probeVideos);
      ev.archetype = tts.archetype;
      ev.ttsForecastHours = tts.ttsMedianHours;
      ev.windowState = win.state;
      ev.windowRemainingMin = win.remainingMin;
      ev.probeHistory = probes;
      ev.keywords = clusterSignalsKeywordOnly(sigs).keywords;
      ev.status = nextStatus(ev, momentumAcc);
      say(`event: UPDATE "${ev.title}" -> ${alert} (${opportunity}/100, status ${ev.status})`);
    }

    // Baseline learning (EMA) so ratios mean something after ~12 runs.
    ent.baselineVolume = ent.baselineVolume * 0.8 + Math.min(20, totalMentions) * 0.2;

    rows.push({
      event,
      spice,
      risk,
      acceleration: momentumAcc,
      trendRatio,
      newsRatio,
      communityRatio,
      reasons,
    });
  }

  // Age out stale events (14 days quiet -> ARCHIVED).
  for (const ev of Object.values(state.events)) {
    if (ev.status !== 'ARCHIVED' && Date.now() - new Date(ev.lastSeen).getTime() > 14 * 86_400_000) {
      ev.status = 'ARCHIVED';
      ev.alert = 'ARCHIVE';
    }
  }

  // ----------------------------------------------------------
  // Persist: state.json + CSV + MD + snapshot + run log
  // ----------------------------------------------------------
  state.lastRunAt = nowIso;
  saveState(REPO_ROOT, state);

  const csvRows = readCsvRows(REPO_ROOT);
  for (const r of rows) {
    csvRows[r.event.key] = eventToCsvRow(r.event, {
      acceleration: r.acceleration,
      spice: r.spice,
      risk: r.risk,
      scoreVersion: SCORE_VERSION,
    });
  }
  // The story bank persists: archived events keep their rows.
  for (const [k, ev] of Object.entries(state.events)) {
    if (!csvRows[k]) {
      csvRows[k] = eventToCsvRow(ev, {
        acceleration: ev.acceleration,
        spice: ev.spice,
        risk: ev.risk,
        scoreVersion: SCORE_VERSION,
      });
    }
  }
  writeCsvRows(REPO_ROOT, csvRows);

  writeRadarMarkdown(REPO_ROOT, {
    runNumber: runNo,
    updatedAt: new Date(),
    rows,
    errors,
    sourcesUsed,
  });

  const snapDir = path.join(REPO_ROOT, 'data', 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapDir, `run-${String(runNo).padStart(5, '0')}.json`),
    JSON.stringify(
      {
        runNo,
        at: nowIso,
        rows: rows.map((r) => ({
          event: r.event.key,
          alert: r.event.alert,
          opportunity: r.event.opportunity,
          momentum: r.event.momentum,
          window: r.event.windowState,
        })),
        errors,
      },
      null,
      2
    ) + '\n'
  );

  const logDir = path.join(REPO_ROOT, 'data', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, `run-${String(runNo).padStart(5, '0')}.log`),
    log.join('\n') + '\n'
  );

  say(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${rows.length} scored, ${errors.length} collector issue(s)`);
}

// ------------------------------------------------------------
// helpers
// ------------------------------------------------------------

function countLanes(sigs: Signal[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sigs) m.set(s.source, (m.get(s.source) ?? 0) + 1);
  return m;
}

function dominantTopic(sigs: Signal[], personName: string): string {
  const personLower = personName.toLowerCase();
  const ranked = [...sigs]
    .filter((s) => s.text.toLowerCase().includes(personLower))
    .sort((a, b) => {
      const spiceA = spiceScore(computeSpiceFactors(a.text));
      const spiceB = spiceScore(computeSpiceFactors(b.text));
      return spiceB - spiceA;
    });
  const sourceText = ranked[0]?.text ?? sigs[0]?.text ?? 'trending now';
  const cleaned = sourceText.toLowerCase().startsWith(personLower)
    ? sourceText.slice(personName.length).replace(/^[\s:–—-]+/, '').trim()
    : sourceText.trim();
  return personName + ': ' + (cleaned.length > 3 ? cleaned.slice(0, 110) : 'trending now');
}

function trendLinkedSignal(sigs: Signal[], threshold: number): boolean {
  return sigs.some(
    (s) =>
      (s.source === 'trends' ||
        (s.source === 'news' && (s.metric ?? '').startsWith('via trends'))) &&
      (s.score ?? 0) >= threshold
  );
}

function categoryOf(archetype: string): string {
  const map: Record<string, string> = {
    breaking_scandal: 'scandal',
    creator_drama: 'creator',
    business_tech: 'tech',
    celebrity_echo: 'celebrity',
    slow_burn: 'institutional',
  };
  return map[archetype] ?? 'general';
}

function nextStatus(ev: StateEvent, momentumAcc: number): StateEvent['status'] {
  if (ev.status === 'ARCHIVED') return 'ARCHIVED';
  if (momentumAcc > 5) return 'BOOSTED';
  if (momentumAcc >= 0) return ev.status === 'NEW' ? 'RESEARCH' : 'KEPT';
  if (momentumAcc < -10) return 'ARCHIVED';
  return ev.status;
}

function minutesSinceLastRun(state: RadarState): number {
  if (!state.lastRunAt) return 60;
  return Math.max(1, (Date.now() - new Date(state.lastRunAt).getTime()) / 60_000);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
