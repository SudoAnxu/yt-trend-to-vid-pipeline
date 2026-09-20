# 🔥 Trend Radar — 24/7 trend-to-video intelligence on GitHub Actions

A serverless deployment of the **Trend-to-Video Intelligence Engine**: GitHub's cron runs the
radar every 15 minutes, the engine discovers emerging people from free sources, scores them,
forecasts **time-to-saturation** on YouTube, and commits its own dashboard back to this repo.

No server. No database. The **repository is the storage, the audit trail, and the dashboard**:

```
GitHub Actions cron (every 15 min, off-hour minutes)
        ↓
 Google Trends RSS · GDELT news · Reddit · YouTube probe
        ↓
 discover → resolve → gate → cluster → score → TTS window gate
        ↓
 data/opportunities.csv · data/radar.md · data/state.json · data/snapshots/
        ↓
 git commit → this repo IS the dashboard
```

## Reading the radar

Open [`data/radar.md`](data/radar.md). Sections, in priority order:

- **🚨 STRIKE NOW** — opportunity ≥ 85, fresh, evidence-backed, and the opportunity window is
  still open (external momentum accelerating while YouTube competition is still low).
- **🟠 STRIKE WINDOW** — worth making soon; either evidence is still thin or the window is closing.
- **🟡 WATCH** — interesting, not actionable yet.
- **⚫ ARCHIVED** — faded or stale.

Each card shows momentum / acceleration / spice / risk bars, the recommended (template-backed)
angle, competition counts, the TTS forecast, and how long the window has left.

[`data/opportunities.csv`](data/opportunities.csv) is the machine-readable story bank — one row
per event, upserted every run, never deleted. Feed it anywhere.

## How detection works (short version)

1. **Extract names first** — rule-based NER (person-likelihood scoring with context verbs, role
   prefixes, homonym penalties). No watchlist: new names are the whole point.
2. **Resolve against history** — `data/state.json` keeps every entity's baselines and momentum
   history, so acceleration is computed *across runs*, not per run.
3. **Emergence gate** — a candidate needs 2 independent source lanes within the gate window
   (or sustained Trends pressure) before any expensive step runs.
4. **Score** — ε-smoothed baseline ratios, cross-source confirmation, 9-factor spice, risk
   penalties, opportunity score. `score_version` travels with every row.
5. **Time-to-Saturation** — the event is classified into a story archetype (scandal ≈ 3.5h to
   saturation, tech ≈ 7.5h, slow burn ≈ 16h), the forecast blends observed YouTube probe points,
   and the **opportunity window** stays open only while external momentum is up AND YouTube
   competition is still low.
6. **Commit** — every run leaves a snapshot + run log in `data/`, so any alert can be traced to
   the signals that produced it.

## Setup (one time)

1. Push this repo to GitHub (it runs entirely on the free tier).
2. Actions tab → enable workflows if prompted.
3. Optional secrets (Settings → Secrets and variables → Actions):

| Secret | Effect when absent |
|---|---|
| `YOUTUBE_API_KEY` | No YouTube probes → saturation/TTS run on priors only |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | Falls back to public Reddit JSON (rate-limited) |
| `LLM_API_KEY` (+ optional `LLM_BASE_URL`, `LLM_MODEL`) | Angles come from deterministic templates |

**The radar is fully functional with zero secrets** — keys only deepen it.

4. Trigger the first run: Actions → Trend Radar → **Run workflow**. Then check `data/radar.md`.

## Tuning

`config/radar.yaml` overrides the built-in defaults (gate thresholds, probe gate, GDELT window,
subreddit list). Weights and thresholds live in `src/engine/config.ts` with the formula
documentation. Every change is a commit — the audit trail applies to the engine too.

## Local run

```bash
npm install
npm run build
npm run radar
# inspect data/
```

## Layout

```
src/
  main.ts                 orchestrator (two-stage adaptive run)
  engine/
    config.ts             weights, thresholds, cadences (versioned)
    ner.ts                name extraction + person-likelihood + resolution
    metrics.ts            velocity, ratios, spice, risk, opportunity, alerts
    cluster.ts            keyword clustering
    time-to-saturation.ts archetypes, TTS forecast, dual-momentum window gate
    state.ts              state.json persistence (the engine's memory)
    yaml-config.ts        dependency-free YAML loader
  collectors/             trends (RSS) · gdelt (DOC 2.0) · reddit (OAuth) · youtube (probe)
  agents/                 angle agent (templates + optional LLM polish)
  storage/                csv store · markdown dashboard
data/                     committed outputs: csv · md · state.json · snapshots/ · logs/
config/radar.yaml         operator tuning
```

## Honest scope

- Validation so far: pipeline correctness + a historical replay benchmark of the detection
  logic — **not yet** a live-latency proof at scale. Treat the first weeks of runs as
  calibration data (the momentum history in `state.json` is what gets better over time).
- Angles are templates (or LLM-polished templates). The research/script agents from the full
  engine are intentionally **not** ported here — this repo is the discovery + triage loop.
