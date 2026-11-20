/**
 * The message protocol between extension contexts.
 *
 *  side panel / service worker ──(chrome.tabs.sendMessage)──▶ content script or page agent   : TabRequest
 *  content script ──(chrome.runtime.sendMessage)──▶ service worker / side panel             : ContentEvent
 *  service worker ──(chrome.runtime.sendMessage)──▶ side panel                               : PanelEvent
 *
 * Every receiver checks `type` against these lists and validates payloads
 * (see src/model/schemas.ts) before using them.
 */
import type { SerpData } from './schemas';

export interface HighlightGroup {
  /** Class of sentence: said by most, said by some, or only on this page. */
  kind: 'most' | 'some' | 'only';
  sentences: string[];
}

export type TabRequest =
  | { type: 'lens:ping' }
  | { type: 'lens:get-serp' }
  | { type: 'lens:get-answer' }
  | { type: 'lens:get-page' }
  | { type: 'lens:fetch-same-origin'; urls: string[] }
  | { type: 'lens:get-brand-style' }
  | { type: 'lens:highlight'; groups: HighlightGroup[] }
  | { type: 'lens:clear-highlight' }
  | { type: 'lens:selector-health' }
  /** Settings changed (tracked brands, strip on/off): re-read the content configuration. */
  | { type: 'lens:config-changed' }
  | { type: 'lens:dev-save-fixture' };

export const TAB_REQUEST_TYPES: readonly TabRequest['type'][] = [
  'lens:ping',
  'lens:get-serp',
  'lens:get-answer',
  'lens:get-page',
  'lens:fetch-same-origin',
  'lens:get-brand-style',
  'lens:highlight',
  'lens:clear-highlight',
  'lens:selector-health',
  'lens:config-changed',
  'lens:dev-save-fixture',
];

export type ContentEvent =
  | { type: 'lens:open-panel' }
  | { type: 'lens:get-content-config' }
  | { type: 'lens:set-strip-collapsed'; collapsed: boolean }
  | { type: 'lens:save-snapshot'; serp: SerpData }
  | { type: 'lens:page-changed'; agent: 'google' | 'ai' | 'page' };

export const CONTENT_EVENT_TYPES: readonly ContentEvent['type'][] = [
  'lens:open-panel',
  'lens:get-content-config',
  'lens:set-strip-collapsed',
  'lens:save-snapshot',
  'lens:page-changed',
];

export type InvokeSource = 'action' | 'context-menu' | 'strip';
export type InvokeIntent = 'analyze' | 'selection';

export type PanelEvent = {
  type: 'lens:invoked';
  tabId: number;
  source: InvokeSource;
  intent: InvokeIntent;
};

/** What the service worker hands to content scripts (they cannot read extension storage directly). */
export interface ContentConfig {
  brands: {
    mine: { id: string; name: string; domains: string[]; aliases: string[] }[];
    competitors: { id: string; name: string; domains: string[]; aliases: string[] }[];
  };
  strip: { enabled: boolean; collapsed: boolean };
  autoSaveSnapshots: boolean;
  selectorOverrides: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cheap structural check used inside content scripts (which do not carry the schema library). */
export function asTabRequest(message: unknown): TabRequest | null {
  if (!isRecord(message) || typeof message.type !== 'string') return null;
  if (!(TAB_REQUEST_TYPES as readonly string[]).includes(message.type)) return null;
  if (message.type === 'lens:fetch-same-origin') {
    if (!Array.isArray(message.urls) || message.urls.length > 12) return null;
    if (!message.urls.every((u) => typeof u === 'string' && u.length <= 2048)) return null;
  }
  if (message.type === 'lens:highlight') {
    if (!Array.isArray(message.groups) || message.groups.length > 3) return null;
    for (const group of message.groups as unknown[]) {
      if (!isRecord(group)) return null;
      if (group.kind !== 'most' && group.kind !== 'some' && group.kind !== 'only') return null;
      if (!Array.isArray(group.sentences) || group.sentences.length > 2000) return null;
      if (!group.sentences.every((s) => typeof s === 'string' && s.length <= 2000)) return null;
    }
  }
  return message as TabRequest;
}
