#!/usr/bin/env node
/**
 * Renders store/privacy-policy.md to store/privacy-policy.html: one
 * self-contained page (no scripts, no external files) that can be hosted
 * anywhere. Text in [SQUARE BRACKETS — placeholder] is highlighted so that
 * nobody publishes it by accident.
 *
 * Supports the small part of Markdown the policy uses: headings, paragraphs,
 * bullet lists, tables, **bold** and [links](https://…).
 *
 *   node scripts/render-privacy-policy.mjs           write the HTML
 *   node scripts/render-privacy-policy.mjs --check   fail if it is out of date
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const source = join(root, 'store', 'privacy-policy.md');
const target = join(root, 'store', 'privacy-policy.html');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]*placeholder[^\]]*)\]/g, '<mark>[$1]</mark>');
}

function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let title = 'Privacy Policy';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) title = heading[2];
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(`  <li>${inline(lines[i++].slice(2))}</li>`);
      html.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      html.push(
        `<table>\n  <thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>\n  <tbody>\n${body
          .map((row) => `    <tr>${cells(row).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('\n')}\n  </tbody>\n</table>`,
      );
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|- |\|)/.test(lines[i])) paragraph.push(lines[i++]);
    html.push(`<p>${paragraph.map(inline).join('<br>\n')}</p>`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<!-- Generated from store/privacy-policy.md by scripts/render-privacy-policy.mjs. Edit the Markdown, not this file. -->
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2933; background: #fff; margin: 0; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 36px 0 8px; }
  p, ul { margin: 0 0 14px; }
  ul { padding-left: 22px; }
  li { margin-bottom: 6px; }
  a { color: #1d4ed8; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 14px; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #d9dee5; }
  th { font-weight: 600; }
  mark { background: #fde68a; padding: 0 3px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e9f0; background: #12161c; }
    a { color: #93b4ff; }
    th, td { border-color: #323a46; }
    mark { background: #7c5e10; color: #fff; }
  }
</style>
</head>
<body>
<main>
${html.join('\n')}
</main>
</body>
</html>
`;
}

const output = render(readFileSync(source, 'utf8'));
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== output) {
    console.error('store/privacy-policy.html is out of date. Run: node scripts/render-privacy-policy.mjs');
    process.exit(1);
  }
  console.log('store/privacy-policy.html is up to date');
} else {
  writeFileSync(target, output);
  console.log(`wrote store/privacy-policy.html (${(output.length / 1024).toFixed(1)} KB)`);
}
