/** Lets an AI provider rewrite a brief's draft avatars and next steps. The facts are never rewritten. */
import { withRewrites, type Avatar, type Brief } from '@/features/instant-brief/compose';
import { isUnavailable } from '@/legiit/client';
import { cleanText } from '@/lib/sanitize';
import type { AiProvider, AiRequest } from './provider';

/** How much of each part of a rewrite is kept. Longer text is cut, never a reason to throw the reply away. */
const KEEP = { name: 80, text: 400, search: 120, searches: 6, steps: 8 } as const;

/** JSON Schema sent to the model (Prompt API responseConstraint / Legiit responseSchema). */
export const BRIEF_REWRITE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['avatars', 'nextSteps'],
  additionalProperties: false,
  properties: {
    avatars: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['name', 'who', 'wants', 'worries', 'searches', 'proof'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          who: { type: 'string' },
          wants: { type: 'string' },
          worries: { type: 'string' },
          searches: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          proof: { type: 'string' },
        },
      },
    },
    nextSteps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
  },
};

export function briefRewriteRequest(brief: Brief): AiRequest {
  const { facts } = brief;
  return {
    task: 'brief',
    instruction:
      'Rewrite the three draft customer avatars and the next steps for this business so they are specific to it. Keep exactly three avatars. Base everything on the facts.',
    facts: [
      `Business: ${brief.businessName} (${facts.organisation?.types.join(', ') ?? 'type unknown'})`,
      `Website: ${brief.siteUrl}`,
      // The drafts come early: the facts are cut off at a length budget, and what is to be rewritten must not be what is lost.
      ...brief.avatars.map((a) => `Draft avatar "${a.name}": ${a.who}`),
      ...brief.nextSteps.map((s) => `Draft next step: ${s}`),
      ...(facts.description ? [`Description: ${facts.description}`] : []),
      ...(facts.services.length ? [`Services: ${facts.services.join(', ')}`] : []),
      ...(facts.serviceAreas.length ? [`Service areas: ${facts.serviceAreas.join(', ')}`] : []),
      ...(facts.organisation?.rating?.value ? [`On-site rating: ${facts.organisation.rating.value} from ${facts.organisation.rating.count ?? 'an unknown number of'} reviews`] : []),
      ...facts.testimonials.slice(0, 2).map((t) => `Testimonial: "${t.quote}"`),
      ...(brief.competitors.length ? [`Competitors: ${brief.competitors.map((c) => c.name).join(', ')}`] : []),
      ...brief.search.map((s) => `Search: "${s.keyword}" position ${s.myPosition ?? 'none'}, grade ${s.gradeLetter}, gaps in ${s.gapSurfaces.join(', ') || 'none'}`),
      ...brief.issues.slice(0, 6).map((i) => `Issue (${i.severity}): ${i.title}`),
    ],
    fallback: brief.nextSteps,
    responseSchema: BRIEF_REWRITE_JSON_SCHEMA,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** One clean line of at most `max` characters; "" for anything that is not text. */
const line = (value: unknown, max: number): string => cleanText(typeof value === 'number' ? String(value) : value, max);
const lines = (value: unknown, max: number, count: number): string[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => line(entry, max))
    .filter(Boolean)
    .slice(0, count);

/**
 * Reads a model reply. The reply is used when it holds three usable avatars
 * and at least one next step; everything else about it is repaired rather
 * than refused, because models rarely keep to length limits: over-long text
 * is cut, empty entries are skipped, and extra avatars or steps are ignored.
 * Returns null when there is not enough to use.
 */
export function parseBriefRewrite(reply: string): { avatars: Avatar[]; nextSteps: string[] } | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const avatars: Avatar[] = [];
  for (const raw of Array.isArray(json['avatars']) ? json['avatars'] : []) {
    if (!isRecord(raw)) continue;
    const avatar: Avatar = {
      name: line(raw['name'], KEEP.name),
      who: line(raw['who'], KEEP.text),
      wants: line(raw['wants'], KEEP.text),
      worries: line(raw['worries'], KEEP.text),
      searches: lines(raw['searches'], KEEP.search, KEEP.searches),
      proof: line(raw['proof'], KEEP.text),
    };
    // An avatar is usable when it says who it is, what they want and what worries them.
    if (avatar.name && avatar.who && avatar.wants && avatar.worries) avatars.push(avatar);
    if (avatars.length === 3) break;
  }
  const nextSteps = lines(json['nextSteps'], KEEP.text, KEEP.steps);
  return avatars.length === 3 && nextSteps.length > 0 ? { avatars, nextSteps } : null;
}

export interface BriefRewriteOutcome {
  brief: Brief;
  /** Why the template text was kept, when the provider's reply could not be used. */
  keptTemplateBecause: string | null;
  /** Set when the provider is Legiit and its AI endpoint turned out not to exist. */
  endpointMissing?: true;
}

export async function rewriteBrief(brief: Brief, provider: AiProvider, signal?: AbortSignal): Promise<BriefRewriteOutcome> {
  if (provider.id === 'none') return { brief, keptTemplateBecause: null };
  try {
    const rewrite = parseBriefRewrite(await provider.complete(briefRewriteRequest(brief), signal));
    if (!rewrite) return { brief, keptTemplateBecause: 'The AI reply was not in the expected format' };
    return { brief: withRewrites(brief, { ...rewrite, writtenBy: provider.id }), keptTemplateBecause: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { brief, keptTemplateBecause: error instanceof Error ? error.message : 'The AI provider failed', ...(isUnavailable(error) ? { endpointMissing: true as const } : {}) };
  }
}
