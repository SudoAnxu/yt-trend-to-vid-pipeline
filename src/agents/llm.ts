// ============================================================
// Trend Radar — optional LLM angle polish
// Works with any OpenAI-compatible endpoint (set LLM_API_KEY and
// optionally LLM_BASE_URL / LLM_MODEL). Without a key the radar
// stays fully deterministic — angles come from templates.
// ============================================================

export function hasLlm(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

export async function completeJson<T>(args: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<T | null> {
  if (!hasLlm()) return null;
  const base = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.LLM_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: args.temperature ?? 0,
        max_tokens: args.maxTokens ?? 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
