// ============================================================
// Trend Radar — GDELT DOC 2.0 collector (no key)
// Fresh English news mentioning creator/celebrity/exec context
// words. GDELT is the widest free news firehose available to a
// scheduled job; queries stay deliberately cheap.
// ============================================================

import type { Signal } from '../engine/types';
import { fetchText, decodeEntities } from './trends';

const DOC_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

/** Max lookback GDELT allows per query window. */
export const GDELT_MAX_MINUTES = 60;

export interface GdeltResult {
  signals: Signal[];
  errors: string[];
}

export async function fetchGdelt(opts: {
  minutesBack: number;
  maxRecords?: number;
  query?: string;
}): Promise<GdeltResult> {
  const out: Signal[] = [];
  const errors: string[] = [];
  const minutes = Math.min(GDELT_MAX_MINUTES, Math.max(5, Math.round(opts.minutesBack)));
  const maxRecords = opts.maxRecords ?? 75;
  const query = opts.query ??
    '(streamer OR youtuber OR influencer OR "content creator" OR celebrity OR "ceo") (feud OR drama OR responds OR lawsuit OR accused OR launched OR quit OR fired OR controversy OR apology OR exposed)';
  const params = new URLSearchParams({
    query: `${query} sourcelang:english`,
    mode: 'artlist',
    maxrecords: String(maxRecords),
    format: 'json',
    timespan: `${minutes}min`,
    sort: 'datedesc',
  });
  try {
    const url = `${DOC_URL}?${params.toString()}`;
    // GDELT rate-limits aggressively (429); back off and retry twice.
    let raw: string | null = null;
    let lastErr: unknown = null;
    for (const waitMs of [0, 4000, 10_000]) {
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      try {
        raw = await fetchText(url);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!String(e).includes('429')) throw e;
      }
    }
    if (lastErr || raw == null) throw lastErr ?? new Error('unreachable');
    const json = JSON.parse(raw) as { articles?: GdeltArticle[] };
    for (const a of json.articles ?? []) {
      if (!a.title) continue;
      out.push({
        source: 'gdelt',
        text: decodeEntities(a.title),
        url: a.url,
        observedAt: a.seendate ? parseGdeltDate(a.seendate) : undefined,
        metric: a.domain ? `via ${a.domain}` : undefined,
      });
    }
  } catch (e) {
    errors.push(`gdelt: ${String(e)}`);
  }
  return { signals: out, errors };
}

export interface GdeltArticle {
  url: string;
  title: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

/** GDELT seendate format: 20260921T120000Z. */
export function parseGdeltDate(s: string): string | undefined {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Evidence probe for the research step: fresh coverage for one person,
 * with outlet domains so the sourcing tiers can be scored.
 */
export async function fetchGdeltForPerson(person: string, minutesBack = 24 * 60): Promise<Signal[]> {
  const r = await fetchGdelt({
    minutesBack,
    maxRecords: 30,
    query: `"${person}"`,
  });
  return r.signals;
}
