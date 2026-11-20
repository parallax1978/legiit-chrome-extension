/**
 * Bundled selector packs, one per site. Overrides (validated data stored by
 * the selector health-check page) replace a bundled pack only when they are
 * for the same site and carry a newer version.
 */
import type { AiSiteId } from '@/config/sites';
import chatgpt from './chatgpt.json';
import copilot from './copilot.json';
import gemini from './gemini.json';
import google from './google.json';
import perplexity from './perplexity.json';
import { compareVersions, validatePack } from './resolve';
import type { SelectorPack } from './types';

export type PackSite = 'google' | AiSiteId;

export const BUNDLED_PACKS: Readonly<Record<PackSite, SelectorPack>> = {
  google: google as SelectorPack,
  chatgpt: chatgpt as SelectorPack,
  gemini: gemini as SelectorPack,
  perplexity: perplexity as SelectorPack,
  copilot: copilot as SelectorPack,
};

export const PACK_SITES = Object.keys(BUNDLED_PACKS) as PackSite[];

export function getPack(site: PackSite, overrides?: Record<string, unknown>): SelectorPack {
  const bundled = BUNDLED_PACKS[site];
  const override = validatePack(overrides?.[site], site);
  if (override && compareVersions(override.version, bundled.version) > 0) return override;
  return bundled;
}
