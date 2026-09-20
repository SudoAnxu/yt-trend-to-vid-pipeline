// ============================================================
// Trend Radar — keyword clustering (faithful port of the app's
// replay-cluster.ts; keep behavior in sync with the live engine).
// ============================================================

export interface ClusterInfoLite {
  keywords: string[];
}

export function clusterSignalsKeywordOnly(signals: { text: string }[]): ClusterInfoLite {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'what', 'going', 'after', 'over', 'this', 'that',
    'have', 'has', 'was', 'were', 'their', 'they', 'them', 'from', 'about', 'into', 'just',
    'here', 'more', 'than', 'will', 'would', 'could', 'should', 'been', 'being', 'when',
    'who', 'why', 'how', 'says', 'said', 'amid', 'among', 'also', 'some', 'then',
  ]);
  const freq = new Map<string, number>();
  for (const s of signals) {
    const words = s.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const w of words) {
      if (w.length < 4 || stop.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const keywords = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
  return { keywords };
}

export function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
