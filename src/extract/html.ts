/**
 * Helpers for reading HTML that came from a web page, a fetched source or a
 * Wayback capture. Documents are created with DOMParser, which never runs
 * scripts or loads sub-resources, and are only ever read, never rendered.
 */
import { cleanText, safeHttpUrl } from '@/lib/sanitize';

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Resolves an href against the page URL. A parsed document has no base URL of
 * its own, so relative links must be resolved explicitly. Fragment-only and
 * non-http(s) links (mailto:, javascript:, data:…) return null.
 */
export function resolveHref(href: string | null | undefined, pageUrl: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return safeHttpUrl(trimmed, pageUrl);
}

/** The URL relative links resolve against: <base href> when the page declares one, else the page URL. */
export function documentBase(doc: Document, pageUrl: string): string {
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  return (baseHref && safeHttpUrl(baseHref, pageUrl)) || pageUrl;
}

export function metaContent(doc: Document, selector: string, max = 1000): string | null {
  const value = doc.querySelector(selector)?.getAttribute('content');
  const cleaned = cleanText(value ?? '', max);
  return cleaned || null;
}

export function textOf(node: Element | null | undefined, max = 500): string {
  return cleanText(node?.textContent ?? '', max);
}

export interface JsonLdNode {
  [key: string]: unknown;
}

/** Parses every JSON-LD block, flattening arrays and @graph. Malformed blocks are skipped. */
export function readJsonLd(doc: Document): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as JsonLdNode;
    nodes.push(node);
    if ('@graph' in node) visit(node['@graph'], depth + 1);
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    const raw = script.textContent ?? '';
    if (!raw.trim() || raw.length > 500_000) continue;
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      // Not valid JSON: ignore, the page is untrusted input.
    }
  }
  return nodes;
}

/** All @type values of a JSON-LD node as strings. */
export function typesOf(node: JsonLdNode): string[] {
  const type = node['@type'];
  if (typeof type === 'string') return [cleanText(type, 80)];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string').map((t) => cleanText(t, 80));
  return [];
}

/** Collects @type values from every node, including nested objects (address, author, offers…). */
export function collectJsonLdTypes(doc: Document): string[] {
  const types = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as JsonLdNode;
    for (const t of typesOf(node)) if (t) types.add(t);
    for (const key of Object.keys(node)) {
      if (key !== '@type' && key !== '@context') visit(node[key], depth + 1);
    }
  };
  for (const node of readJsonLd(doc)) visit(node, 0);
  return [...types].sort((a, b) => a.localeCompare(b));
}

export function stringProp(node: JsonLdNode | undefined, key: string, max = 300): string | null {
  const value = node?.[key];
  if (typeof value === 'string') return cleanText(value, max) || null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as JsonLdNode)['name'] ?? (value as JsonLdNode)['@id'] ?? (value as JsonLdNode)['url'];
    if (typeof inner === 'string') return cleanText(inner, max) || null;
  }
  return null;
}

export function listProp(node: JsonLdNode | undefined, key: string, max = 200): string[] {
  const value = node?.[key];
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') out.push(cleanText(item, max));
    else if (item && typeof item === 'object') {
      const name = (item as JsonLdNode)['name'] ?? (item as JsonLdNode)['url'] ?? (item as JsonLdNode)['@id'];
      if (typeof name === 'string') out.push(cleanText(name, max));
    }
  }
  return out.filter(Boolean);
}
