// ============================================================
// Trend Radar — YouTube probe (quota-disciplined, port of the
// app engine's youtube-probe gating):
//   - search.list (100 units) ONLY for entities crossing the
//     attention gate (2+ external source lanes confirmed).
//   - videos.list (1 unit) refreshes tracked videos.
//   - Skipped entirely without YOUTUBE_API_KEY.
// ============================================================

import type { Signal } from '../engine/types';
import type { TrackedVideo } from '../engine/state';
import { fetchText, decodeEntities } from './trends';

const API = 'https://www.googleapis.com/youtube/v3';

export function hasYouTubeKey(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

export interface ProbeResult {
  videos: TrackedVideo[];
  unitsUsed: number;
  errors: string[];
}

/**
 * Probe competition for one person: recent videos matching their name
 * in the last `hours` (search.list), enriched with view counts
 * (videos.list, 1 unit per 50 ids).
 */
export async function probePersonVideos(person: string, hours = 6): Promise<ProbeResult> {
  const out: ProbeResult = { videos: [], unitsUsed: 0, errors: [] };
  if (!hasYouTubeKey()) return out;
  const key = process.env.YOUTUBE_API_KEY as string;
  const publishedAfter = new Date(Date.now() - hours * 3600_000).toISOString();

  try {
    const params = new URLSearchParams({
      key,
      part: 'snippet',
      q: person,
      type: 'video',
      order: 'date',
      maxResults: '25',
      publishedAfter,
    });
    const raw = await fetchText(`${API}/search?${params.toString()}`);
    out.unitsUsed += 100;
    const json = JSON.parse(raw) as SearchResponse;
    const items = json.items ?? [];
    const ids = items.map((i) => i.id?.videoId).filter((v): v is string => Boolean(v));
    const snippets = new Map<string, { title: string; channel: string; publishedAt: string }>();
    for (const it of items) {
      if (it.id?.videoId && it.snippet) {
        snippets.set(it.id.videoId, {
          title: decodeEntities(it.snippet.title),
          channel: it.snippet.channelTitle,
          publishedAt: it.snippet.publishedAt,
        });
      }
    }

    if (ids.length > 0) {
      const vParams = new URLSearchParams({
        key,
        part: 'statistics',
        id: ids.join(','),
      });
      const vRaw = await fetchText(`${API}/videos?${vParams.toString()}`);
      out.unitsUsed += 1;
      const vJson = JSON.parse(vRaw) as VideosResponse;
      for (const v of vJson.items ?? []) {
        const snip = snippets.get(v.id);
        if (!snip) continue;
        out.videos.push({
          id: v.id,
          title: snip.title,
          channel: snip.channel,
          publishedAt: snip.publishedAt,
          views: Number(v.statistics?.viewCount ?? 0),
        });
      }
    }
  } catch (e) {
    out.errors.push(`youtube: ${String(e)}`);
  }
  return out;
}

/** Cheap refresh of view counts for tracked videos (1 unit per call). */
export async function refreshVideoStats(videoIds: string[]): Promise<{
  videos: TrackedVideo[];
  unitsUsed: number;
}> {
  const out: { videos: TrackedVideo[]; unitsUsed: number } = { videos: [], unitsUsed: 0 };
  if (!hasYouTubeKey() || videoIds.length === 0) return out;
  const key = process.env.YOUTUBE_API_KEY as string;
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const params = new URLSearchParams({ key, part: 'snippet,statistics', id: batch.join(',') });
      const raw = await fetchText(`${API}/videos?${params.toString()}`);
      out.unitsUsed += 1;
      const json = JSON.parse(raw) as VideosResponse;
      for (const v of json.items ?? []) {
        out.videos.push({
          id: v.id,
          title: decodeEntities(v.snippet?.title ?? ''),
          channel: v.snippet?.channelTitle ?? '',
          publishedAt: v.snippet?.publishedAt ?? '',
          views: Number(v.statistics?.viewCount ?? 0),
        });
      }
    } catch {
      // stats refresh is best-effort
    }
  }
  return out;
}

interface SearchResponse {
  items?: { id?: { videoId?: string }; snippet?: { title: string; channelTitle: string; publishedAt: string } }[];
}
interface VideosResponse {
  items?: { id: string; snippet?: { title: string; channelTitle: string; publishedAt: string }; statistics?: { viewCount?: string } }[];
}

export type { Signal };
