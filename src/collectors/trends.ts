// ============================================================
// Trend Radar — Google Trends RSS collector (no key, no quota)
// Daily-trends RSS: trending queries + attached news items. The
// news items are the valuable part: they name people early.
// ============================================================

import type { Signal } from '../engine/types';
import { rankToProxyScore } from '../engine/metrics';

const RSS_URL = 'https://trends.google.com/trending/rss?geo=US';

export interface TrendsResult {
  signals: Signal[];
  errors: string[];
}

export async function fetchTrendsRss(geo = 'US'): Promise<TrendsResult> {
  const out: Signal[] = [];
  const errors: string[] = [];
  try {
    const res = await fetchText(RSS_URL.replace('geo=US', `geo=${geo}`));
    const xml = res;
    const items = xml.split(/<item>/i).slice(1);
    let rank = 0;
    for (const item of items) {
      rank++;
      const title = tagText(item, 'title');
      if (!title) continue;
      const traffic = tagText(item, 'ht:approx_traffic');
      const score = rankToProxyScore(
        rank,
        traffic ? approxVolumeFromTraffic(traffic) : undefined
      );
      // Google Trends RSS pubDate is the feed build time, not a precise
      // per-item timestamp — the honest observation time is when WE saw
      // it. (GDELT/Reddit provide real timestamps and keep theirs.)
      const observedAt = new Date().toISOString();

      out.push({
        source: 'trends',
        text: title,
        score,
        metric: traffic ? `${traffic} searches` : `rank #${rank}`,
        observedAt,
        query: title,
        region: geo,
      });

      // Attached news items name people early — treat each as its own
      // signal (the emergence gate counts independent sources, and the
      // Trends lane + News lane are independent lanes).
      const newsTitles = [...item.matchAll(/<ht:news_item_title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ht:news_item_title>/gi)]
        .map((m) => decodeEntities(m[1].trim()));
      const newsUrls = [...item.matchAll(/<ht:news_item_url>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ht:news_item_url>/gi)]
        .map((m) => decodeEntities(m[1].trim()));
      for (let ni = 0; ni < Math.min(4, newsTitles.length); ni++) {
        const nt = newsTitles[ni];
        if (!nt) continue;
        out.push({
          source: 'news',
          text: nt,
          url: newsUrls[ni] || undefined,
          score,
          metric: `via trends #${rank}`,
          observedAt,
          query: title,
          region: geo,
        });
      }
    }
  } catch (e) {
    errors.push(`trends: ${String(e)}`);
  }
  return { signals: out, errors };
}

function approxVolumeFromTraffic(traffic: string): number | undefined {
  const m = traffic.match(/([\d.,]+)([KM]\+?)?/i);
  if (!m) return undefined;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return undefined;
  const unit = (m[2] ?? '').toUpperCase();
  if (unit.startsWith('K')) n *= 1_000;
  if (unit.startsWith('M')) n *= 1_000_000;
  return Math.round(n);
}

export async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'trend-radar/1.0 (+https://github.com)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
  return m ? decodeEntities(m[1].trim()) : '';
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function parseRssDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}
