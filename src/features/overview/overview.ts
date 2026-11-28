/**
 * The Overview: what a page means for the user, in one sentence, a few facts and up to three next steps.
 *
 * Everything here is built from what the tools already read from the page. Nothing is fetched and nothing is
 * guessed: a sentence is written only when its fact was read. The tools behind each step are named by id, so the
 * panel can open them.
 */
import type { BrandMatcher } from '@/brands/matcher';
import { LEGIIT_SERVICES, type LegiitLink } from '@/config/legiit-links';
import type { PageFacts } from '@/extract/page-facts';
import type { ClickPotential } from '@/features/click-potential/metrics';
import type { Issue } from '@/features/instant-brief/issues';
import { otherSites, type Presence, type SurfacePresence } from '@/features/why-not-me/presence';
import type { BlockType, SerpData } from '@/model/schemas';
import { crowdingOf, howFarDown, listOf, plural, someOf, type Crowding } from './words';

/** The tools the panel has, by the id the panel knows them under. */
export type ToolId = 'click' | 'why' | 'rewind' | 'noise' | 'brief';

export interface NextStep {
  /** Stable name of the step, for tests and for the panel. */
  id: 'lists' | 'ai-sources' | 'local' | 'compare' | 'sources' | 'history' | 'content' | 'brief' | 'details';
  text: string;
  /** The tool that does it, and what its button says. */
  open: { tool: ToolId; label: string } | null;
  /** Where on Legiit someone can be hired for it. */
  legiit: LegiitLink | null;
}

export type OverviewTone = 'good' | 'mixed' | 'bad' | 'neutral';

export interface Overview {
  kind: 'results' | 'answer' | 'page';
  headline: string;
  tone: OverviewTone;
  facts: string[];
  steps: NextStep[];
  /** Results pages only: how much room the page leaves for organic results. */
  crowding: Crowding | null;
  /** False when the user has not said which site is theirs: the Overview then cannot speak about "you". */
  personal: boolean;
}

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** Sites where a result is a thread of many voices, not one author's list. */
const FORUMS: ReadonlySet<string> = new Set(['reddit.com', 'quora.com']);

/** How many results come before this page: Google's "start" (0 on page 1). */
function resultsBefore(pageUrl: string): number {
  try {
    const start = Number(new URL(pageUrl).searchParams.get('start') ?? '0');
    return Number.isInteger(start) && start > 0 ? Math.min(start, 1000) : 0;
  } catch {
    return 0;
  }
}

/** What stands above the first organic result, in the words a searcher would use. */
const ABOVE_WORDS: Partial<Record<BlockType, string>> = {
  ai_overview: 'the AI answer',
  local_pack: 'a map of local businesses',
  featured_snippet: 'a featured answer',
  paa: 'a box of related questions',
  video: 'videos',
  image: 'images',
  shopping: 'products for sale',
  top_stories: 'news stories',
  forum: 'forum threads',
  knowledge_panel: 'an information box',
};

function aiFact(ai: SurfacePresence | undefined, personal: boolean): { text: string; mineIn: boolean } | null {
  if (!ai?.present) return null;
  const cited = ai.items.some((item) => item.mine.length > 0);
  const named = ai.textMine.length > 0;
  if (!personal) {
    const sites = otherSites(ai);
    return { text: sites.length > 0 ? `Google's AI answer draws on ${someOf(sites)}.` : 'This search shows an AI answer.', mineIn: false };
  }
  if (cited && named) return { text: "Google's AI answer names you and uses your site as a source.", mineIn: true };
  if (cited) return { text: "Google's AI answer uses your site as a source.", mineIn: true };
  if (named) return { text: "Google's AI answer names you.", mineIn: true };
  if (ai.competitorNames.length > 0) return { text: `Google's AI answer names ${listOf(ai.competitorNames.slice(0, 3))}, not you.`, mineIn: false };
  return { text: "Google's AI answer does not mention you.", mineIn: false };
}

/** A Google results page. */
export function buildResultsOverview(serp: SerpData, cp: ClickPotential, presence: Presence, matcher: BrandMatcher): Overview {
  const personal = matcher.hasMine;
  const keyword = serp.keyword;
  const before = resultsBefore(serp.url);
  const mine = cp.organic.find((o) => o.owner === 'mine') ?? null;
  const facts: string[] = [];
  const steps: NextStep[] = [];

  let headline: string;
  let tone: OverviewTone;
  if (!personal) {
    const first = cp.organic[0];
    headline = first ? `${plural(cp.organic.length, 'result')} for “${keyword}”. The first is from ${first.domain || 'a site Google does not name'}.` : `No results could be read for “${keyword}”.`;
    tone = 'neutral';
  } else if (mine) {
    headline = before > 0 ? `You are about #${before + mine.position} for “${keyword}”.` : `You are #${mine.position} for “${keyword}”.`;
    tone = before === 0 && mine.position <= 3 ? 'good' : 'mixed';
    const where = howFarDown(mine.top, serp.viewport.height);
    if (where) facts.push(where === 'on the first screen' ? 'Your result is on the first screen.' : `Your result is ${where}: people scroll to reach it.`);
  } else {
    headline = `You are not on ${before > 0 ? 'this page' : 'page 1'} for “${keyword}”.`;
    tone = 'bad';
  }

  const ai = presence.surfaces.find((s) => s.id === 'ai_overview');
  const aiSays = aiFact(ai, personal);
  if (aiSays) facts.push(aiSays.text);

  // Who holds the places above the user: tracked competitors by name, else the sites.
  const rivals = cp.tracked.filter((t) => t.owner === 'competitor' && t.position !== null).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (rivals.length > 0) {
    facts.push(`${listOf(rivals.slice(0, 3).map((r) => `${r.name} is #${r.position}`))}.`);
  } else if (personal) {
    const ahead = unique((mine ? cp.organic.filter((o) => o.position < mine.position) : cp.organic).map((o) => o.domain).filter(Boolean));
    if (ahead.length > 0) facts.push(mine ? `Ahead of you: ${someOf(ahead)}.` : `The top results are from ${someOf(ahead)}.`);
  }

  // What a searcher sees before the first organic result.
  if (cp.measured && cp.firstOrganicTop !== null) {
    const top = cp.firstOrganicTop;
    const ads = serp.blocks.filter((b) => b.type === 'ad' && b.rect !== null && b.rect.y < top).reduce((sum, b) => sum + Math.max(1, b.items.length), 0);
    const others = unique(cp.aboveFirstOrganic.map((b) => ABOVE_WORDS[b.type] ?? '').filter(Boolean));
    const parts = [...(ads > 0 ? [plural(ads, 'ad')] : []), ...others];
    const where = howFarDown(top, serp.viewport.height);
    if (parts.length > 0) {
      const single = parts.length === 1 && (ads === 1 || (ads === 0 && !/s$/.test(parts[0] ?? '')));
      const list = listOf(parts);
      facts.push(`${list.charAt(0).toUpperCase()}${list.slice(1)} ${single ? 'comes' : 'come'} before the first result${where && where !== 'on the first screen' ? `, which starts ${where}` : ''}.`);
    } else if (where === 'on the first screen') {
      facts.push('The results start at the top of the page.');
    }
  }

  if (personal) {
    // A "best of" list is a page of someone else's that ranks and could name the user. The user's own page, a
    // tracked competitor's own page and a forum thread are not that.
    const ownedBy = (domain: string): boolean => domain !== '' && matcher.matchDomain(domain).length > 0;
    const lists = serp.organic.filter((o) => o.listStyle && !ownedBy(o.domain) && !FORUMS.has(o.domain));
    if (lists.length > 0) {
      const sites = unique(lists.map((o) => o.domain).filter(Boolean));
      steps.push({
        id: 'lists',
        text:
          lists.length === 1
            ? `A page that looks like a “best of” list ranks here${sites[0] ? ` (${sites[0]})` : ''}. If it can name you, being on it puts you on this page.`
            : `${lists.length} pages that look like “best of” lists rank here${sites.length > 0 ? ` (${someOf(sites)})` : ''}. If they can name you, being on them puts you on this page.`,
        open: { tool: 'why', label: lists.length === 1 ? 'See if it names me' : 'See if they name me' },
        legiit: LEGIIT_SERVICES.guestPosts,
      });
    }
    const sources = ai?.present ? ai.items.filter((item) => item.mine.length === 0 && item.url !== null).length : 0;
    if (ai?.present && !aiSays?.mineIn && sources > 0) {
      steps.push({
        id: 'ai-sources',
        text: `The AI answer draws on ${plural(sources, 'page')}. Being on those pages is how you get into the answer.`,
        open: { tool: 'why', label: 'See the pages' },
        legiit: LEGIIT_SERVICES.backlinks,
      });
    }
    const local = presence.surfaces.find((s) => s.id === 'local_pack');
    if (local?.present && !local.minePresent) {
      steps.push({
        id: 'local',
        text: `A map with ${plural(local.items.length, 'local business', 'local businesses')} shows on this search, and you are not on it.`,
        open: { tool: 'why', label: 'See who is' },
        legiit: LEGIIT_SERVICES.localSeo,
      });
    }
    steps.push({
      id: 'compare',
      text: mine ? 'See what the pages above you say that yours does not.' : 'Check one of your pages against the pages that rank here.',
      open: { tool: 'noise', label: 'Compare my page' },
      legiit: LEGIIT_SERVICES.writing,
    });
  }

  return { kind: 'results', headline, tone, facts: facts.slice(0, 4), steps: steps.slice(0, 3), crowding: cp.measured ? crowdingOf(cp.grade.letter) : null, personal };
}

/** An AI answer: ChatGPT, Gemini, Perplexity, Copilot, Google AI Mode, or a pasted one. */
export function buildAnswerOverview(presence: Presence, matcher: BrandMatcher): Overview {
  const personal = matcher.hasMine;
  const who = presence.sourceLabel;
  const text = presence.surfaces.find((s) => s.id === 'answer_text' || s.id === 'ai_overview');
  const cites = presence.surfaces.find((s) => s.id === 'citations') ?? text;
  const named = (text?.textMine.length ?? 0) > 0;
  const cited = cites?.items.some((item) => item.mine.length > 0) ?? false;
  const rivals = unique([...(text?.competitorNames ?? []), ...(cites?.competitorNames ?? [])]);
  const sources = cites ? cites.items.filter((item) => item.mine.length === 0 && item.url !== null).length : 0;
  const facts: string[] = [];

  let headline: string;
  let tone: OverviewTone;
  if (!personal) {
    headline = sources > 0 ? `${who} draws on ${plural(sources, 'page')} for this answer.` : `${who} names no source for this answer.`;
    tone = 'neutral';
  } else if (named || cited) {
    headline = named && cited ? `${who} names you and uses your site as a source.` : named ? `${who} names you.` : `${who} uses your site as a source.`;
    tone = 'good';
  } else if (rivals.length > 0) {
    headline = `${who} names ${listOf(rivals.slice(0, 3))}, not you.`;
    tone = 'bad';
  } else {
    headline = `${who} does not mention you.`;
    tone = 'mixed';
  }
  if (presence.subject) facts.push(`The question: “${presence.subject.slice(0, 160)}”.`);
  if (personal && (named || cited) && rivals.length > 0) facts.push(`It also names ${listOf(rivals.slice(0, 3))}.`);
  const sites = cites ? otherSites(cites) : [];
  if (sites.length > 0) facts.push(`Its sources: ${someOf(sites)}.`);

  const steps: NextStep[] = [];
  if (personal && sources > 0 && !cited && !named) {
    steps.push({
      id: 'sources',
      text: `The answer draws on ${plural(sources, 'page')}. Being on those pages is how you get into answers like this one.`,
      open: { tool: 'why', label: 'See the pages and who to contact' },
      legiit: LEGIIT_SERVICES.guestPosts,
    });
  } else if (sources > 0) {
    steps.push({ id: 'details', text: 'See every page the answer draws on.', open: { tool: 'why', label: 'See the pages' }, legiit: null });
  }
  return { kind: 'answer', headline, tone, facts: facts.slice(0, 3), steps, crowding: null, personal };
}

/** What one finding of the site check means on a single page, in plain words. null for findings that need more than one page. */
function issueInWords(issue: Issue, facts: PageFacts, imagesWithoutAlt: number): string | null {
  switch (issue.code) {
    case 'not-https':
      return 'The page is not served over HTTPS, so browsers call it “not secure”.';
    case 'noindex':
      return 'The page tells search engines not to list it.';
    case 'missing-title':
      return 'The page has no title.';
    case 'short-title':
      return `The title says very little (“${facts.title ?? ''}”).`;
    case 'long-title':
      return `The title is ${(facts.title ?? '').length} characters long. Google usually cuts a title after about 60.`;
    case 'missing-description':
      return 'There is no description for search results, so Google writes its own.';
    case 'missing-h1':
      return 'The page has no main heading.';
    case 'multiple-h1':
      return `The page has ${facts.h1.length} main headings. One is clearer.`;
    case 'canonical-elsewhere':
      return 'The page says its original is at another address, so search engines list that one instead.';
    case 'missing-viewport':
      return 'The page is not set up for phone screens.';
    case 'missing-alt':
      return `${plural(imagesWithoutAlt, 'image has', 'images have')} no description for search engines and screen readers.`;
    case 'no-structured-data':
      return 'The home page has no structured data that tells Google what the business is.';
    case 'thin-content':
      return `The page has only ${plural(facts.wordCount, 'word')} of text.`;
    default:
      return null;
  }
}

/** An ordinary page: the user's own, or any other. */
export function buildPageOverview(input: { url: string; title: string; facts: PageFacts; issues: readonly Issue[]; imagesWithoutAlt: number; isMine: boolean }): Overview {
  const said = input.issues.map((issue) => ({ issue, text: issueInWords(issue, input.facts, input.imagesWithoutAlt) })).filter((x): x is { issue: Issue; text: string } => x.text !== null);
  const serious = said.some((x) => x.issue.severity === 'high');
  const whose = input.isMine ? 'your page' : 'this page';
  const headline = said.length === 0 ? `No basic problems on ${whose}.` : `${plural(said.length, 'thing')} to fix on ${whose}.`;
  const steps: NextStep[] = [
    { id: 'content', text: 'Check whether it says anything the pages it competes with do not.', open: { tool: 'noise', label: 'Check the content' }, legiit: LEGIIT_SERVICES.writing },
    { id: 'history', text: 'See how this page changed over time.', open: { tool: 'rewind', label: 'Show what changed' }, legiit: null },
    { id: 'brief', text: 'Get a report on the whole site: what it offers, who it is for, what to fix.', open: { tool: 'brief', label: 'Build the site brief' }, legiit: said.length > 0 ? LEGIIT_SERVICES.seo : null },
  ];
  return {
    kind: 'page',
    headline,
    tone: said.length === 0 ? 'good' : serious ? 'bad' : 'mixed',
    facts: said.slice(0, 4).map((x) => x.text),
    steps,
    crowding: null,
    personal: input.isMine,
  };
}
