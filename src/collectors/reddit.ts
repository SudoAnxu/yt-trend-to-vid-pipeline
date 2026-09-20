// ============================================================
// Trend Radar — Reddit collector
// Prefers the OAuth app-only connector (port of the app's
// reddit.ts: client-credentials, token cache, backoff) when
// REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are set; otherwise
// falls back to public listings (fine for a low-rate CI job).
// Stateless CI runs get a fresh breaker each run; the backoff and
// User-Agent contract still protect against hammering.
// ============================================================

import type { Signal } from '../engine/types';
import { fetchText } from './trends';

const UA = 'trend-radar/1.0 (github action; contact via repo issues)';

// ------------------------------------------------------------
// OAuth app-only path
// ------------------------------------------------------------

let cachedToken: { token: string; exp: number } | null = null;

// Public-JSON circuit breaker: without OAuth, reddit.com often 403/429s
// cloud IPs. One failure opens the breaker for the rest of the process
// so a CI run fails in seconds instead of backing off 8×3 times.
let publicJsonOpen = false;

export function hasRedditOauth(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

async function getAppOnlyToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const id = process.env.REDDIT_CLIENT_ID as string;
  const secret = process.env.REDDIT_CLIENT_SECRET as string;
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
      },
      body: 'grant_type=client_credentials',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`token HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  } finally {
    clearTimeout(timer);
  }
}

export interface RedditPost {
  title: string;
  subreddit: string;
  permalink: string;
  score: number;
  comments: number;
  createdUtc: number;
}

/** Search subreddits for fresh posts mentioning the query. */
export async function fetchReddit(opts: {
  query: string;
  subreddits?: string[];
  minutesBack?: number;
  limit?: number;
}): Promise<{ signals: Signal[]; errors: string[] }> {
  const out: Signal[] = [];
  const errors: string[] = [];
  const subs = opts.subreddits?.length
    ? opts.subreddits
    : ['technology', 'entertainment', 'music', 'movies', 'gaming', 'popculturechat', 'youtubedrama', 'news'];
  const limit = opts.limit ?? 25;
  const cutoff = Date.now() - (opts.minutesBack ?? 120) * 60_000;

  for (const sub of subs) {
    if (!hasRedditOauth() && publicJsonOpen) {
      errors.push(`reddit: public-json breaker open (configure REDDIT_CLIENT_ID/SECRET)`);
      break;
    }
    try {
      const posts = await searchSubreddit(sub, opts.query, limit);
      for (const p of posts) {
        if (p.createdUtc * 1000 < cutoff) continue;
        out.push({
          source: 'reddit',
          text: p.title,
          url: `https://reddit.com${p.permalink}`,
          score: p.score,
          comments: p.comments,
          observedAt: new Date(p.createdUtc * 1000).toISOString(),
          metric: `r/${p.subreddit} · ${p.score}↑ ${p.comments}💬`,
          query: opts.query,
        });
      }
    } catch (e) {
      errors.push(`reddit r/${sub}: ${String(e)}`);
    }
  }
  return { signals: out, errors };
}

async function searchSubreddit(sub: string, query: string, limit: number): Promise<RedditPost[]> {
  const path = `/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=day&limit=${limit}`;
  const json = await redditGet(path);
  const children = (json as { data?: { children?: { data: RedditPost }[] } }).data?.children ?? [];
  return children.map((c) => c.data);
}

async function redditGet(pathAndQuery: string): Promise<unknown> {
  const backoffMs = [0, 2000, 6000];
  let lastErr: unknown = new Error('unreachable');
  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i] > 0) await sleep(backoffMs[i]);
    if (!hasRedditOauth() && publicJsonOpen) {
      throw new Error('public-json circuit breaker open');
    }
    try {
      if (hasRedditOauth()) {
        const token = await getAppOnlyToken();
        const res = await fetch(`https://oauth.reddit.com${pathAndQuery}`, {
          headers: { authorization: `Bearer ${token}`, 'user-agent': UA },
        });
        if (res.status === 429 || res.status === 503) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }
      // Public fallback (no OAuth secrets configured)
      if (publicJsonOpen) {
        throw new Error('public-json circuit breaker open (configure REDDIT_CLIENT_ID/SECRET)');
      }
      const res = await fetch(`https://www.reddit.com${pathAndQuery}`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      if (res.status === 429 || res.status === 403) {
        publicJsonOpen = true;
        lastErr = new Error(`HTTP ${res.status} (public JSON restricted; configure REDDIT_CLIENT_ID/SECRET)`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
