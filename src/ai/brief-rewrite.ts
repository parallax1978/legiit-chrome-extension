/** Lets an AI provider rewrite a brief's draft avatars and next steps. The facts are never rewritten. */
import * as v from 'valibot';
import { withRewrites, type Avatar, type Brief } from '@/features/instant-brief/compose';
import type { AiProvider, AiRequest } from './provider';

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));

const RewriteSchema = v.object({
  avatars: v.pipe(
    v.array(
      v.object({
        name: text(80),
        who: text(400),
        wants: text(400),
        worries: text(400),
        searches: v.pipe(v.array(text(120)), v.maxLength(6)),
        proof: text(400),
      }),
    ),
    v.length(3),
  ),
  nextSteps: v.pipe(v.array(text(400)), v.minLength(1), v.maxLength(8)),
});

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
      ...(facts.description ? [`Description: ${facts.description}`] : []),
      ...(facts.services.length ? [`Services: ${facts.services.join(', ')}`] : []),
      ...(facts.serviceAreas.length ? [`Service areas: ${facts.serviceAreas.join(', ')}`] : []),
      ...(facts.organisation?.rating?.value ? [`On-site rating: ${facts.organisation.rating.value} from ${facts.organisation.rating.count ?? 'an unknown number of'} reviews`] : []),
      ...facts.testimonials.slice(0, 2).map((t) => `Testimonial: "${t.quote}"`),
      ...(brief.competitors.length ? [`Competitors: ${brief.competitors.map((c) => c.name).join(', ')}`] : []),
      ...brief.search.map((s) => `Search: "${s.keyword}" position ${s.myPosition ?? 'none'}, grade ${s.gradeLetter}, gaps in ${s.gapSurfaces.join(', ') || 'none'}`),
      ...brief.issues.slice(0, 6).map((i) => `Issue (${i.severity}): ${i.title}`),
      ...brief.avatars.map((a) => `Draft avatar "${a.name}": ${a.who}`),
      ...brief.nextSteps.map((s) => `Draft next step: ${s}`),
    ],
    fallback: brief.nextSteps,
    responseSchema: BRIEF_REWRITE_JSON_SCHEMA,
  };
}

/** Parses a model reply. Returns null unless it is exactly the expected shape. */
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
  const parsed = v.safeParse(RewriteSchema, json);
  return parsed.success ? parsed.output : null;
}

export interface BriefRewriteOutcome {
  brief: Brief;
  /** Why the template text was kept, when the provider's reply could not be used. */
  keptTemplateBecause: string | null;
}

export async function rewriteBrief(brief: Brief, provider: AiProvider, signal?: AbortSignal): Promise<BriefRewriteOutcome> {
  if (provider.id === 'none') return { brief, keptTemplateBecause: null };
  try {
    const rewrite = parseBriefRewrite(await provider.complete(briefRewriteRequest(brief), signal));
    if (!rewrite) return { brief, keptTemplateBecause: 'The AI reply was not in the expected format' };
    return { brief: withRewrites(brief, { ...rewrite, writtenBy: provider.id }), keptTemplateBecause: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { brief, keptTemplateBecause: error instanceof Error ? error.message : 'The AI provider failed' };
  }
}
