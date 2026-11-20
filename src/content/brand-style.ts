/**
 * Reads brand styling from the rendered page: dominant colours of the header,
 * buttons and links, the typefaces in use and the logo. Read-only.
 */
import { safeHttpUrl } from '@/lib/sanitize';
import type { BrandStyle } from '@/model/schemas';
import { sameOriginImageDataUrl } from './same-origin-fetch';

function toHex(color: string): string | null {
  const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(color.trim());
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) < 0.5) return null; // mostly transparent
  return `#${[m[1], m[2], m[3]].map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('')}`;
}

function isBrandLike(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min >= 28 && max > 40 && min < 235;
}

const SAMPLES: readonly { selector: string; property: 'backgroundColor' | 'color'; source: string; weight: number }[] = [
  { selector: 'header, [role="banner"], nav', property: 'backgroundColor', source: 'header background', weight: 6 },
  { selector: 'button, [role="button"], a[class*="btn" i], a[class*="button" i], input[type="submit"]', property: 'backgroundColor', source: 'button background', weight: 5 },
  { selector: 'footer, [role="contentinfo"]', property: 'backgroundColor', source: 'footer background', weight: 3 },
  { selector: 'h1, h2', property: 'color', source: 'heading colour', weight: 3 },
  { selector: 'main a, article a, p a', property: 'color', source: 'link colour', weight: 2 },
];

export async function readBrandStyle(): Promise<BrandStyle> {
  const tally = new Map<string, { weight: number; source: string }>();
  for (const sample of SAMPLES) {
    let elements: Element[] = [];
    try {
      elements = Array.from(document.querySelectorAll(sample.selector)).slice(0, 40);
    } catch {
      elements = [];
    }
    for (const el of elements) {
      const hex = toHex(getComputedStyle(el)[sample.property]);
      if (!hex || !isBrandLike(hex)) continue;
      const entry = tally.get(hex) ?? { weight: 0, source: sample.source };
      entry.weight += sample.weight;
      tally.set(hex, entry);
    }
  }
  const colors = [...tally]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 6)
    .map(([hex, { weight, source }]) => ({ hex, weight, source }));

  const fonts: string[] = [];
  for (const el of [document.body, document.querySelector('h1')]) {
    if (!el) continue;
    const family = getComputedStyle(el).fontFamily.split(',')[0]?.replace(/["']/g, '').trim();
    if (family && !fonts.includes(family) && !/^(serif|sans-serif|system-ui|monospace|-apple-system)$/i.test(family)) fonts.push(family.slice(0, 80));
  }

  const logo = document.querySelector<HTMLImageElement>(
    'header img[class*="logo" i], header img[alt*="logo" i], header img[src*="logo" i], a[class*="logo" i] img, img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]',
  );
  const logoUrl = logo ? safeHttpUrl(logo.currentSrc || logo.src, location.href) : null;
  const logoDataUrl = logoUrl ? await sameOriginImageDataUrl(logoUrl) : null;

  return { colors, logoUrl, logoDataUrl, fonts: fonts.slice(0, 4) };
}
