/**
 * Instant Brief, step 3: turn extracted facts into a client brief.
 *
 * This is the deterministic composer ("provider 3: none"). Every sentence is
 * built from facts read off the site; the three customer avatars are drafts
 * and are labelled as such. An AI provider, when the user has one, may
 * rewrite the avatars and next steps (see src/ai) but never the facts.
 */
import { stripWww } from '@/lib/sanitize';
import { pluralize, titleCase } from '@/lib/text';
import type { BusinessFacts } from './extract';
import type { Issue } from './issues';

export interface BriefCompetitor {
  name: string;
  domain: string | null;
  /** Where the competitor came from: typed in, tracked in settings, or an open results page. */
  source: 'manual' | 'tracked' | 'results';
}

export interface SearchEntry {
  keyword: string;
  capturedAt: number;
  viewport: string;
  gradeLetter: string;
  gradeScore: number;
  firstOrganicTop: number | null;
  /** The business's best organic position on that page, if it was there. */
  myPosition: number | null;
  myFold: string | null;
  /** Surfaces where competitors appear and the business does not. */
  gapSurfaces: string[];
  competitorsSeen: string[];
}

export interface Avatar {
  name: string;
  /** One-line description of who this is. */
  who: string;
  wants: string;
  worries: string;
  searches: string[];
  /** What the site already offers this person, from the extracted facts. */
  proof: string;
}

export interface BriefSection {
  id: 'business' | 'offer' | 'customers' | 'competitors' | 'search' | 'issues' | 'next';
  title: string;
  /** A note shown under the title, e.g. "Draft". */
  note: string | null;
  facts: { label: string; value: string }[];
  lists: { label: string; items: string[] }[];
  paragraphs: string[];
}

export interface Brief {
  id: string;
  createdAt: number;
  siteUrl: string;
  businessName: string;
  facts: BusinessFacts;
  competitors: BriefCompetitor[];
  search: SearchEntry[];
  issues: Issue[];
  avatars: Avatar[];
  nextSteps: string[];
  sections: BriefSection[];
  /** Which provider wrote the avatars and next steps. */
  writtenBy: 'template' | 'legiit' | 'chrome-prompt';
}

export interface ComposeInput {
  id: string;
  now: number;
  facts: BusinessFacts;
  issues: Issue[];
  competitors: BriefCompetitor[];
  search?: SearchEntry[];
}

const CATEGORY_NOUNS: readonly [RegExp, string][] = [
  [/Dentist/i, 'dentist'],
  [/Physician|MedicalClinic|MedicalBusiness|Clinic/i, 'clinic'],
  [/Attorney|LegalService/i, 'law firm'],
  [/Plumber/i, 'plumber'],
  [/Electrician/i, 'electrician'],
  [/RoofingContractor/i, 'roofer'],
  [/Restaurant|FoodEstablishment|Cafe/i, 'restaurant'],
  [/RealEstateAgent/i, 'real estate agent'],
  [/AutoRepair|AutomotiveBusiness/i, 'auto shop'],
  [/HairSalon|BeautySalon|HealthAndBeautyBusiness/i, 'salon'],
  [/Store|Shop/i, 'store'],
  [/LodgingBusiness|Hotel/i, 'hotel'],
  [/FinancialService|AccountingService/i, 'financial firm'],
];

/** A plain noun for the kind of business, from its structured-data type. */
export function categoryNoun(facts: BusinessFacts): string {
  for (const type of facts.organisation?.types ?? []) {
    for (const [pattern, noun] of CATEGORY_NOUNS) if (pattern.test(type)) return noun;
  }
  return 'business';
}

function primaryArea(facts: BusinessFacts): string | null {
  if (facts.serviceAreas[0]) return facts.serviceAreas[0];
  const locality = /,\s*([\p{L} .'-]+),\s*[A-Z]{2}\b/u.exec(facts.addresses[0] ?? '');
  return locality ? locality[1]!.trim() : null;
}

function lower(service: string): string {
  return service.charAt(0).toLowerCase() + service.slice(1);
}

/** Three draft customer avatars built from the offer, the area and the proof on the site. */
export function draftAvatars(facts: BusinessFacts): Avatar[] {
  const noun = categoryNoun(facts);
  const area = primaryArea(facts);
  const inArea = area ? ` in ${area}` : '';
  const services = facts.services.length > 0 ? facts.services : ['its main service'];
  const urgent = services.find((s) => /emergency|urgent|same[- ]day|24|repair/i.test(s)) ?? services[0]!;
  // A purchase people research before committing to.
  const considered =
    services.find((s) => s !== urgent && /whiten|implant|invisalign|aligner|crown|cosmetic|veneer|brace|remodel|install|replace|design|surgery|package|plan|custom/i.test(s)) ??
    services.find((s) => s !== urgent && !/emergency|urgent/i.test(s)) ??
    services[services.length - 1]!;
  const routine = services.find((s) => /clean|exam|check|maint|routine|consult|membership|plan/i.test(s)) ?? services[0]!;
  const rating = facts.organisation?.rating?.value ? `a ${facts.organisation.rating.value}-star rating${facts.organisation.rating.count ? ` from ${facts.organisation.rating.count} reviews` : ''}` : null;
  const testimonial = facts.testimonials[0] ? `a testimonial from ${facts.testimonials[0].author ?? 'a customer'}` : null;
  const phone = facts.phones[0] ? `a phone number (${facts.phones[0]}) on every page` : null;
  const prices = facts.pages.some((p) => p.kind === 'pricing') ? 'a public pricing page' : null;
  const proofOr = (...options: (string | null)[]): string => {
    const present = options.filter((o): o is string => Boolean(o));
    if (present.length === 0) return 'The site has little to reassure this person yet.';
    const joined = present.length === 1 ? present[0]! : `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
    return `The site already offers ${joined}.`;
  };

  return [
    {
      name: 'The urgent need',
      who: `Someone${inArea} who needs ${lower(urgent)} now and has not chosen a ${noun} yet.`,
      wants: 'To be seen quickly, to know the price before committing, and to reach a person on the first try.',
      worries: 'Being kept waiting, surprise costs, and picking the wrong provider under pressure.',
      searches: [`${lower(urgent)}${area ? ` ${area.toLowerCase()}` : ' near me'}`, `${noun} open now${area ? ` ${area.toLowerCase()}` : ''}`, `same day ${noun}`],
      proof: proofOr(phone, prices),
    },
    {
      name: 'The careful researcher',
      who: `Someone comparing two or three ${noun === 'business' ? 'providers' : `${noun}s`}${inArea} before booking ${lower(considered)}.`,
      wants: 'Evidence: reviews, real results, clear pricing, and a sense of who they will be dealing with.',
      worries: 'Paying too much, being upsold, and not being able to tell providers apart.',
      searches: [`best ${noun}${area ? ` in ${area.toLowerCase()}` : ''}`, `${lower(considered)} cost`, `${(facts.name ?? noun).toLowerCase()} reviews`],
      proof: proofOr(rating, testimonial, prices),
    },
    {
      name: 'The regular',
      who: `An existing customer or a household${inArea} that wants one dependable ${noun} for ${lower(routine)} and everything after.`,
      wants: 'Convenience, continuity, reminders, and fair prices for coming back.',
      worries: 'Being treated like a stranger each visit, and awkward booking.',
      searches: [`${(facts.name ?? noun).toLowerCase()}`, `${noun}${area ? ` ${area.toLowerCase()}` : ''} ${lower(routine)}`, `${(facts.name ?? noun).toLowerCase()} hours`],
      proof: proofOr(facts.organisation?.openingHours.length ? 'published opening hours' : null, testimonial),
    },
  ];
}

/** Concrete next steps, most important first, each tied to something found on the site or in search. */
export function draftNextSteps(facts: BusinessFacts, issues: readonly Issue[], search: readonly SearchEntry[], competitors: readonly BriefCompetitor[]): string[] {
  const steps: string[] = [];
  for (const issue of issues.filter((i) => i.severity === 'high')) steps.push(`Fix now: ${issue.title.toLowerCase()} (${pluralize(issue.pages.length, 'page')}).`);
  const gapKeywords = search.filter((s) => s.gapSurfaces.length > 0);
  for (const entry of gapKeywords.slice(0, 2)) {
    steps.push(`For “${entry.keyword}”, competitors appear in ${entry.gapSurfaces.join(', ').toLowerCase()} and ${facts.name ?? 'the business'} does not. Review the gap list for pages to get included on.`);
  }
  const below = search.find((s) => s.myPosition !== null && s.myFold !== null && s.myFold !== 'Above the fold');
  if (below) {
    steps.push(
      `“${below.keyword}”: the site ranks #${below.myPosition} but sits ${(below.myFold ?? '').toLowerCase()}; the first screen is taken by other blocks (grade ${below.gradeLetter}, estimate).`,
    );
  }
  const missing = search.filter((s) => s.myPosition === null);
  if (missing[0]) steps.push(`The site has no organic result for “${missing[0].keyword}”. Decide whether an existing page should target it or a new one is needed.`);
  for (const issue of issues.filter((i) => i.severity === 'medium').slice(0, 3)) steps.push(`${issue.title} (${pluralize(issue.pages.length, 'page')}).`);
  if (facts.testimonials.length === 0) steps.push('No customer testimonials were found on the site. Add a few, with names and locations.');
  if (!facts.organisation) steps.push('Add LocalBusiness or Organization structured data with name, address, phone and opening hours.');
  if (facts.serviceAreas.length === 0) steps.push('State the areas served in plain text so people and search engines can see them.');
  if (!facts.pages.some((p) => p.kind === 'pricing')) steps.push('Consider publishing prices or price ranges; no pricing page was found in the navigation.');
  if (competitors.length === 0) steps.push('Name two or three competitors so their visibility can be compared with this site.');
  if (search.length === 0) steps.push('Review Google results for the focus keywords to record where the site and its competitors appear.');
  return steps.slice(0, 8);
}

function hostOf(url: string): string {
  try {
    return stripWww(new URL(url).hostname);
  } catch {
    return url;
  }
}

export function buildSections(brief: Omit<Brief, 'sections'>): BriefSection[] {
  const { facts } = brief;
  const fact = (label: string, value: string | null | undefined) => (value ? [{ label, value }] : []);

  const business: BriefSection = {
    id: 'business',
    title: 'Business',
    note: null,
    facts: [
      ...fact('Name', facts.name),
      ...fact('Website', hostOf(facts.siteUrl)),
      ...fact('Type', facts.organisation?.types.join(', ')),
      ...fact('Phone', facts.phones.join(' · ')),
      ...fact('Email', facts.emails.join(' · ')),
      ...fact('Address', facts.addresses.join(' · ')),
      ...fact('Opening hours', facts.organisation?.openingHours.join(' · ')),
      ...fact('Price range', facts.organisation?.priceRange),
      ...fact('Rating on site', facts.organisation?.rating?.value ? `${facts.organisation.rating.value}${facts.organisation.rating.count ? ` (${facts.organisation.rating.count} reviews)` : ''}` : null),
      ...fact('Brand colours', facts.brandColors.map((c) => c.hex).join(' · ')),
      ...fact('Typefaces', facts.fonts.join(' · ')),
    ],
    lists: [
      ...(facts.serviceAreas.length ? [{ label: 'Service areas', items: facts.serviceAreas }] : []),
      ...(facts.socialProfiles.length ? [{ label: 'Social profiles', items: facts.socialProfiles.map((s) => `${s.network}: ${s.url}`) }] : []),
    ],
    paragraphs: [
      ...(facts.description ? [facts.description] : []),
      ...(facts.tone ? [`Tone of voice — ${facts.tone.traits.join('; ')}. Sample: “${facts.tone.sample}”`] : []),
    ],
  };

  const offer: BriefSection = {
    id: 'offer',
    title: 'Offer',
    note: null,
    facts: [],
    lists: [
      ...(facts.services.length ? [{ label: 'Services and products', items: facts.services }] : []),
      ...(facts.keywordCandidates.length ? [{ label: 'Focus-keyword candidates (from titles and H1s)', items: facts.keywordCandidates.map((k) => `${k.phrase} (${pluralize(k.pages, 'page')})`) }] : []),
      ...(facts.testimonials.length ? [{ label: 'On-site testimonials', items: facts.testimonials.map((t) => `“${t.quote}”${t.author ? ` — ${t.author}` : ''}`) }] : []),
    ],
    paragraphs: facts.services.length === 0 ? ['No services or products could be read from the navigation or the services page.'] : [],
  };

  const customers: BriefSection = {
    id: 'customers',
    title: 'Customers',
    note: 'Draft avatars. Starting points written from the site, not research. Confirm with the client.',
    facts: [],
    lists: brief.avatars.map((a) => ({
      label: `Draft — ${a.name}`,
      // An AI rewrite may leave out the searches or the proof: a line with nothing in it is not printed.
      items: [a.who, `Wants: ${a.wants}`, `Worries about: ${a.worries}`, ...(a.searches.length ? [`Searches for: ${a.searches.join(' · ')}`] : []), ...(a.proof ? [a.proof] : [])],
    })),
    paragraphs: [],
  };

  const competitors: BriefSection = {
    id: 'competitors',
    title: 'Competitors',
    note: null,
    facts: [],
    lists: brief.competitors.length ? [{ label: 'Named competitors', items: brief.competitors.map((c) => (c.domain && c.domain !== c.name ? `${c.name} (${c.domain})` : c.name)) }] : [],
    paragraphs: brief.competitors.length === 0 ? ['No competitors have been added yet.'] : [],
  };

  const search: BriefSection = {
    id: 'search',
    title: 'Search presence',
    note: brief.search.length ? 'From Google results pages reviewed for this brief. Grades are estimates.' : null,
    facts: [],
    lists: brief.search.map((s) => ({
      label: `“${s.keyword}” — ${new Date(s.capturedAt).toISOString().slice(0, 10)}, ${s.viewport}`,
      items: [
        s.myPosition !== null ? `Organic position #${s.myPosition}${s.myFold ? ` (${s.myFold.toLowerCase()})` : ''}` : 'No organic result on the page',
        s.firstOrganicTop !== null ? `First organic result starts ${s.firstOrganicTop.toLocaleString('en-US')} px down; organic click potential ${s.gradeLetter} (${s.gradeScore}/100, estimate)` : 'Organic results were not measured',
        ...(s.gapSurfaces.length ? [`Competitors present and the business absent in: ${s.gapSurfaces.join(', ')}`] : []),
        ...(s.competitorsSeen.length ? [`Competitors seen: ${s.competitorsSeen.join(', ')}`] : []),
      ],
    })),
    paragraphs: brief.search.length === 0 ? ['No search data yet. Open a Google results page for a focus keyword and it will appear here.'] : [],
  };

  const issues: BriefSection = {
    id: 'issues',
    title: 'Issues',
    note: `${pluralize(facts.pages.length, 'page')} read: ${facts.pages.map((p) => new URL(p.url).pathname).join(', ')}`,
    facts: [],
    lists: (['high', 'medium', 'low'] as const)
      .map((severity) => ({
        label: `${titleCase(severity)} priority`,
        items: brief.issues.filter((i) => i.severity === severity).map((i) => `${i.title}. ${i.detail}`),
      }))
      .filter((l) => l.items.length > 0),
    paragraphs: brief.issues.length === 0 ? ['No basic on-page issues were found on the pages that were read.'] : [],
  };

  const next: BriefSection = {
    id: 'next',
    title: 'Next steps',
    note: null,
    facts: [],
    lists: brief.nextSteps.length ? [{ label: 'Recommended', items: brief.nextSteps }] : [],
    paragraphs: [],
  };

  return [business, offer, customers, competitors, search, issues, next];
}

export function composeBrief(input: ComposeInput): Brief {
  const search = input.search ?? [];
  const partial: Omit<Brief, 'sections'> = {
    id: input.id,
    createdAt: input.now,
    siteUrl: input.facts.siteUrl,
    businessName: input.facts.name ?? hostOf(input.facts.siteUrl),
    facts: input.facts,
    competitors: input.competitors,
    search,
    issues: input.issues,
    avatars: draftAvatars(input.facts),
    nextSteps: draftNextSteps(input.facts, input.issues, search, input.competitors),
    writtenBy: 'template',
  };
  return { ...partial, sections: buildSections(partial) };
}

/** Replaces avatars and next steps (for example with AI-written ones) and rebuilds the sections. */
export function withRewrites(brief: Brief, rewrites: { avatars?: Avatar[]; nextSteps?: string[]; writtenBy: Brief['writtenBy'] }): Brief {
  const partial: Omit<Brief, 'sections'> = {
    ...brief,
    avatars: rewrites.avatars && rewrites.avatars.length === 3 ? rewrites.avatars : brief.avatars,
    nextSteps: rewrites.nextSteps && rewrites.nextSteps.length > 0 ? rewrites.nextSteps.slice(0, 8) : brief.nextSteps,
    writtenBy: rewrites.writtenBy,
  };
  return { ...partial, sections: buildSections(partial) };
}
