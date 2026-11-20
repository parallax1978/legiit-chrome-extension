/**
 * Markdown export of a client brief. White-label: it carries the agency's
 * name and no Legiit branding. Page-derived text is escaped so it cannot
 * inject Markdown or HTML into the exported document.
 */
import type { Brief } from './compose';

export interface AgencyIdentity {
  name: string;
  logoDataUrl: string | null;
}

/** Escapes Markdown and HTML control characters in untrusted text. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]<>|~])/g, '\\$1')
    .replace(/^(\s*)([#>+-]|\d+\.)(\s)/gm, '$1\\$2$3')
    .replace(/\r?\n+/g, ' ');
}

export function briefToMarkdown(brief: Brief, agency: AgencyIdentity): string {
  const lines: string[] = [];
  const date = new Date(brief.createdAt).toISOString().slice(0, 10);
  lines.push(`# Client brief: ${escapeMarkdown(brief.businessName)}`, '');
  lines.push(agency.name ? `Prepared by ${escapeMarkdown(agency.name)} · ${date}` : `Prepared ${date}`, '');
  lines.push(`Source: ${escapeMarkdown(brief.siteUrl)}`, '');

  for (const section of brief.sections) {
    lines.push(`## ${section.title}`, '');
    if (section.note) lines.push(`_${escapeMarkdown(section.note)}_`, '');
    for (const paragraph of section.paragraphs) lines.push(escapeMarkdown(paragraph), '');
    if (section.facts.length > 0) {
      for (const fact of section.facts) lines.push(`- **${escapeMarkdown(fact.label)}:** ${escapeMarkdown(fact.value)}`);
      lines.push('');
    }
    for (const list of section.lists) {
      lines.push(`### ${escapeMarkdown(list.label)}`, '');
      for (const item of list.items) lines.push(`- ${escapeMarkdown(item)}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
