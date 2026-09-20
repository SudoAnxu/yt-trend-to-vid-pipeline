// ============================================================
// Trend Radar — Angle Agent (deterministic + optional LLM polish)
// Templates are truthful frames tied to the archetype and the
// dominant spice factors; the LLM (if configured) only sharpens
// wording, it never invents facts.
// ============================================================

import { completeJson, hasLlm } from './llm';
import type { SpiceFactors } from '../engine/types';

const TEMPLATE_BY_ARCHETYPE: Record<string, string[]> = {
  breaking_scandal: [
    'What the {person} {event} filings actually say — line by line',
    'Everyone is covering the {person} headline; nobody read the document',
    'The {person} story in 6 minutes: what is confirmed vs alleged',
  ],
  creator_drama: [
    'The {person} situation is weirder than the clips suggest',
    'Timeline of the {person} drama — and the part nobody clips',
    'Why the {person} blowup matters beyond the drama',
  ],
  business_tech: [
    'The {person} {event} story is actually a money story',
    'What {person} just changed — explained without hype',
    'The second-order effect of the {person} news nobody covers',
  ],
  celebrity_echo: [
    'The {person} story is a proxy fight about something bigger',
    'Why the {person} moment hit so hard',
    'The {person} coverage missed the actual turning point',
  ],
  slow_burn: [
    'The {person} filing that will matter in six months',
    'Connecting the documents in the {person} story',
    'The {person} story deserves better than hot takes',
  ],
};

function dominantFactor(f: SpiceFactors): string {
  const entries: [string, number][] = [
    ['conflict', f.conflict],
    ['money', f.money],
    ['mystery', f.mystery],
    ['consequence', f.consequence],
    ['surprise', f.surprise],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

const HOOK_BY_FACTOR: Record<string, string> = {
  conflict: 'the other side of the fight',
  money: 'the number behind the headline',
  mystery: 'the detail nobody has explained',
  consequence: 'what happens next',
  surprise: 'the part that was not supposed to be public',
};

export function deterministicAngle(person: string, eventTitle: string, archetype: string, spice: SpiceFactors): string {
  const templates = TEMPLATE_BY_ARCHETYPE[archetype] ?? TEMPLATE_BY_ARCHETYPE.business_tech;
  const base = templates[0]
    .replace('{person}', person)
    .replace('{event}', eventTitle.toLowerCase());
  const hook = HOOK_BY_FACTOR[dominantFactor(spice)];
  return `${base} — ${hook}`;
}

export async function generateAngle(args: {
  person: string;
  eventTitle: string;
  archetype: string;
  spice: SpiceFactors;
  signalSample: string[];
}): Promise<string> {
  const fallback = deterministicAngle(args.person, args.eventTitle, args.archetype, args.spice);
  if (!hasLlm()) return fallback;
  const result = await completeJson<{ angle?: string }>({
    system:
      'You sharpen YouTube video angles for a news-explainer channel. ' +
      'Rewrite the given truthful angle into one punchy sentence (max 90 chars). ' +
      'Never add facts that are not in the evidence. Return JSON: {"angle":"..."}.',
    user:
      `Person: ${args.person}\nEvent: ${args.eventTitle}\nArchetype: ${args.archetype}\n` +
      `Angle: ${fallback}\nEvidence headlines:\n${args.signalSample.slice(0, 5).map((s) => `- ${s}`).join('\n')}`,
    temperature: 0.3,
    maxTokens: 120,
  });
  const angle = result?.angle?.trim();
  return angle && angle.length >= 12 && angle.length <= 140 ? angle : fallback;
}
