import { GOOGLE_SEARCH_DOMAINS } from './google-domains';

export type AiSiteId = 'chatgpt' | 'gemini' | 'perplexity' | 'copilot';

export interface AiSiteConfig {
  id: AiSiteId;
  label: string;
  hosts: readonly string[];
  /** Match patterns for the static content script. */
  matches: readonly string[];
}

/** The four AI answer sites Legiit Lens reads. Nothing else gets a static content script. */
export const AI_SITES: Readonly<Record<AiSiteId, AiSiteConfig>> = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com'],
    matches: ['https://chatgpt.com/*'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    hosts: ['gemini.google.com'],
    matches: ['https://gemini.google.com/*'],
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    hosts: ['www.perplexity.ai', 'perplexity.ai'],
    matches: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    hosts: ['copilot.microsoft.com'],
    matches: ['https://copilot.microsoft.com/*'],
  },
};

export const AI_SITE_IDS = Object.keys(AI_SITES) as AiSiteId[];

export const AI_SITE_MATCHES: string[] = AI_SITE_IDS.flatMap((id) => [...AI_SITES[id].matches]);

/** Google Search lives on www.<domain>/search. One pattern per country domain. */
export const GOOGLE_SEARCH_MATCHES: string[] = GOOGLE_SEARCH_DOMAINS.map(
  (domain) => `https://www.${domain}/search*`,
);

export function aiSiteForHost(host: string): AiSiteId | null {
  const h = host.toLowerCase();
  for (const id of AI_SITE_IDS) {
    if (AI_SITES[id].hosts.includes(h)) return id;
  }
  return null;
}

export function isGoogleSearchHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.startsWith('www.') && GOOGLE_SEARCH_DOMAINS.includes(h.slice(4));
}
