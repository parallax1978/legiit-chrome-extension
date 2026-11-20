import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Rect } from '@/model/schemas';
import type { ParseEnv } from '@/serp/parse';
import type { ChromeMock } from './chrome-mock';

export const FIXTURES_DIR = resolve(__dirname, '../../fixtures');

export function fixtureText(relativePath: string): string {
  return readFileSync(resolve(FIXTURES_DIR, relativePath), 'utf8');
}

export function fixtureJson<T = unknown>(relativePath: string): T {
  return JSON.parse(fixtureText(relativePath)) as T;
}

export function fixtureDoc(relativePath: string): Document {
  return new DOMParser().parseFromString(fixtureText(relativePath), 'text/html');
}

export interface Scenario {
  me: { name: string; domain: string; aliases: string[] };
  competitors: { name: string; domain: string; aliases: string[] }[];
  keywords: Record<string, string>;
  urls: Record<string, string>;
}

export const scenario = fixtureJson<Scenario>('scenario.json');

/** Tracked brands for the fixture scenario, in the shape the matcher takes. */
export const scenarioBrands = {
  mine: [{ id: 'me', name: scenario.me.name, domains: [scenario.me.domain], aliases: scenario.me.aliases }],
  competitors: scenario.competitors.map((c, i) => ({ id: `c${i + 1}`, name: c.name, domains: [c.domain], aliases: c.aliases })),
};

/** Rectangle stamped into a Google fixture by scripts/build-fixtures.mjs. */
export function stampedRect(el: Element): Rect | null {
  const raw = el.getAttribute('data-lens-rect');
  if (!raw) return null;
  const [x, y, width, height] = raw.split(',').map(Number);
  if ([x, y, width, height].some((n) => n === undefined || Number.isNaN(n))) return null;
  return { x: x!, y: y!, width: width!, height: height! };
}

/** Parse environment that replays the layout recorded in a stamped fixture. */
export function serpEnv(doc: Document, url: string): ParseEnv {
  const [w, h] = (doc.documentElement.getAttribute('data-lens-viewport') ?? '1280x800').split('x').map(Number);
  return {
    url,
    viewport: { width: w ?? 1280, height: h ?? 800, dpr: 1 },
    documentHeight: Number(doc.documentElement.getAttribute('data-lens-doc-height') ?? 0),
    now: Date.UTC(2026, 10, 20, 12, 0, 0),
    pageId: 'fixture-page',
    rectOf: stampedRect,
    isVisible: (el) => el.hasAttribute('data-lens-rect'),
  };
}

export function chromeMock(): ChromeMock {
  return (globalThis as unknown as { __chromeMock: ChromeMock }).__chromeMock;
}
