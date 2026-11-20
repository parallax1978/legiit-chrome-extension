// @vitest-environment node
/**
 * The store package and the project documents: complete, within the store's
 * limits, in step with the code, and with placeholders marked as such.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEGIIT_API_BASE_URL, PRODUCT_NAME, SINGLE_PURPOSE, WAYBACK_ORIGIN } from '@/config/constants';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const pngSize = (path: string): [number, number] => {
  const data = readFileSync(join(ROOT, path));
  expect(data.subarray(1, 4).toString(), `${path} is a PNG`).toBe('PNG');
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};
/** The fenced blocks of a Markdown file, in order. */
const blocks = (markdown: string) => [...markdown.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]!);

const config = read('wxt.config.ts');
const permissions = /permissions: \[([^\]]+)\]/.exec(config)![1]!.split(',').map((p) => p.trim().replace(/'/g, ''));

describe('store listing', () => {
  const [name, summary, description] = blocks(read('store/listing.md')) as [string, string, string];

  it('uses the product name and the single-purpose sentence verbatim as the summary', () => {
    expect(name).toBe(PRODUCT_NAME);
    expect(summary).toBe(SINGLE_PURPOSE);
    expect(summary).toBe('Shows how visible a web page or brand is in Google results and AI answers, and what explains it.');
    expect(summary.length).toBeLessThanOrEqual(132);
    expect(read('package.json')).toContain(`"description": "${SINGLE_PURPOSE}"`);
  });

  it('opens the description with what the item does', () => {
    expect(description.startsWith(`${PRODUCT_NAME} shows how visible a web page or brand is in Google results and AI answers`)).toBe(true);
    expect(description.length).toBeGreaterThan(1200);
    expect(description.length).toBeLessThan(6000);
  });

  it('does not stuff keywords, list brands without purpose, or quote testimonials', () => {
    const words = description.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
    const count = (word: string) => words.filter((w) => w === word).length;
    // Store policy: "Unnatural repetition of the same keyword more than 5 times".
    for (const keyword of ['google', 'ai', 'seo', 'search', 'results', 'ranking', 'rankings', 'rank', 'keyword', 'keywords', 'legiit', 'lens', 'chatgpt', 'gemini', 'perplexity', 'copilot', 'competitors', 'visibility', 'visible']) {
      expect(count(keyword), keyword).toBeLessThanOrEqual(5);
    }
    // The four supported assistants are named once, as information.
    for (const site of ['chatgpt', 'gemini', 'perplexity', 'copilot']) expect(count(site), site).toBe(1);
    expect(description).not.toMatch(/#1|number one|best seo|guarantee|top of google/i);
    expect(description).not.toMatch(/“[^”]{20,}”\s*[-—–]\s*[A-Z]/); // no quoted testimonial with an attribution
  });

  it('promises only what the extension does', () => {
    for (const feature of ['Click Potential', 'Why Not Me', 'Rewind', 'New or Noise', 'Instant Brief']) expect(description).toContain(feature);
    expect(description).toContain('Everything works without an account.');
    expect(description).toContain('No analytics and no tracking.');
  });
});

describe('privacy practices', () => {
  it('states the single purpose verbatim', () => {
    expect(blocks(read('store/single-purpose.md'))[0]).toBe(SINGLE_PURPOSE);
  });

  it('has one justification per permission in the manifest, per host, and the remote-code declaration', () => {
    const text = read('store/permission-justifications.md');
    const sections = text.split(/^## /m).slice(1).map((section) => ({ title: section.split('\n')[0]!.trim(), body: section }));
    expect(permissions.sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage']);
    for (const permission of permissions) {
      const section = sections.find((s) => s.title === permission);
      expect(section, permission).toBeDefined();
      expect(blocks(section!.body)[0]!.length, permission).toBeGreaterThan(120);
    }
    const titles = sections.map((s) => s.title).join('\n');
    expect(titles).toContain(new URL(WAYBACK_ORIGIN).host);
    expect(titles).toContain(new URL(DEFAULT_LEGIIT_API_BASE_URL).host);
    expect(titles).toContain('Content scripts: Google Search domains');
    expect(titles).toContain('chatgpt.com, gemini.google.com, perplexity.ai, copilot.microsoft.com');
    expect(titles).toContain('Optional host permissions');
    expect(text).toContain('**No, I am not using remote code.**');
  });

  it('answers data usage, with the certifications and the Limited Use statement', () => {
    const usage = read('store/data-usage.md');
    for (const category of ['Personally identifiable information', 'Health information', 'Financial and payment information', 'Authentication information', 'Personal communications', 'Location', 'Web history', 'User activity', 'Website content']) {
      expect(usage, category).toMatch(new RegExp(`\\| ${category} \\| \\*\\*(Yes|No)\\*\\* \\|`));
    }
    expect(usage.match(/- \[x\] I do not/g)).toHaveLength(3);
    const statement = blocks(read('store/limited-use.md'))[0]!;
    expect(statement).toContain('Chrome Web Store User Data Policy, including the Limited Use requirements');
    // The same sentence is in the policy that gets hosted.
    expect(read('store/privacy-policy.md').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')).toContain(statement);
  });

  it('ships a privacy policy in Markdown and HTML that say the same thing', () => {
    execFileSync(process.execPath, ['scripts/render-privacy-policy.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    const html = read('store/privacy-policy.html');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link|<img|src=/i);
    for (const heading of read('store/privacy-policy.md').match(/^## .+$/gm) ?? []) expect(html).toContain(`<h2>${heading.slice(3)}</h2>`);
    for (const promise of ['nothing you analyze is sent to us', 'no analytics, no advertising and no tracking', 'We do not sell your data.', 'shows the exact data it will send']) {
      expect(html.replace(/<[^>]+>/g, ''), promise).toContain(promise);
    }
  });

  it('gives the reviewer steps that need no account', () => {
    const notes = blocks(read('store/reviewer-notes.md'))[0]!;
    for (const part of ['HOW TO TEST', 'PERMISSIONS', 'REMOTE CODE: NONE', 'DATA', 'no account needed']) expect(notes).toContain(part);
    for (const permission of permissions) expect(notes, permission).toContain(permission);
  });
});

describe('store images', () => {
  it('has the icon set, including 128×128, identical to the icons in the package', () => {
    for (const size of [16, 32, 48, 128]) {
      expect(pngSize(`store/icons/icon-${size}.png`)).toEqual([size, size]);
      expect(readFileSync(join(ROOT, `store/icons/icon-${size}.png`)).equals(readFileSync(join(ROOT, `public/icon/${size}.png`)))).toBe(true);
    }
  });

  it('has five 1280×800 screenshots', () => {
    const shots = readdirSync(join(ROOT, 'store/screenshots')).filter((f) => f.endsWith('.png')).sort();
    expect(shots).toEqual(['1-click-potential.png', '2-why-not-me.png', '3-rewind.png', '4-new-or-noise.png', '5-instant-brief.png']);
    for (const shot of shots) expect(pngSize(`store/screenshots/${shot}`), shot).toEqual([1280, 800]);
  });

  it('has a 440×280 promo tile (and the optional marquee)', () => {
    expect(pngSize('store/promo/promo-small-440x280.png')).toEqual([440, 280]);
    expect(pngSize('store/promo/promo-marquee-1400x560.png')).toEqual([1400, 560]);
  });

  it('marks every placeholder as a placeholder', () => {
    const index = read('store/README.md');
    for (const asset of ['icons/icon-16.png', 'promo/promo-small-440x280.png', 'promo/promo-marquee-1400x560.png', 'screenshots/*.png', 'privacy-policy.md', 'https://api.legiit.com', 'Legiit Lens']) {
      expect(index, asset).toContain(asset);
    }
    expect(index).toContain('## Placeholders');
    expect(read('store/privacy-policy.md').match(/\[[^\]]*— placeholder\]/g)).toHaveLength(5);
    expect(read('store/privacy-policy.html').match(/<mark>/g)).toHaveLength(5);
    expect(read('store/listing.md').match(/\*\*Placeholder\*\*/g)).toHaveLength(3);
    expect(read('scripts/make-icons.mjs')).toContain('placeholder artwork');
  });
});

describe('project documents', () => {
  it('are all present', () => {
    for (const file of ['README.md', 'docs/ARCHITECTURE.md', 'docs/DECISIONS.md', 'docs/PERMISSIONS.md', 'docs/QA.md', 'docs/legiit-api/README.md', 'docs/legiit-api/reference.md', 'docs/legiit-api/openapi.yaml', 'store/README.md', 'public/THIRD-PARTY-NOTICES.txt']) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(read(file).length, file).toBeGreaterThan(1500);
    }
  });

  it('PERMISSIONS.md maps every permission and required host to code', () => {
    const doc = read('docs/PERMISSIONS.md');
    for (const permission of permissions) {
      const section = doc.split(`### \`${permission}\``)[1]?.split('\n### ')[0];
      expect(section, permission).toBeDefined();
      // Each section names at least one source file that exists.
      const files = [...section!.matchAll(/`((?:src|scripts|e2e)\/[\w./-]+\.(?:ts|tsx|mjs))`/g)].map((m) => m[1]!);
      expect(files.length, permission).toBeGreaterThan(0);
      for (const file of files) expect(existsSync(join(ROOT, file)), `${permission}: ${file}`).toBe(true);
    }
    expect(doc).toContain(`\`${WAYBACK_ORIGIN}/*\``);
    expect(doc).toContain(`\`${DEFAULT_LEGIIT_API_BASE_URL}/*\``);
    expect(doc).toContain('### Optional hosts: `*://*/*`');
    // Every file path mentioned anywhere in the document exists.
    for (const [, file] of doc.matchAll(/`((?:src|scripts|e2e|docs)\/[\w./-]+\.(?:ts|tsx|mjs|md|json))`/g)) expect(existsSync(join(ROOT, file!)), file).toBe(true);
  });

  it('other documents only point at files that exist', () => {
    for (const doc of ['README.md', 'docs/ARCHITECTURE.md', 'docs/DECISIONS.md', 'docs/QA.md', 'store/README.md', 'store/limited-use.md']) {
      for (const [, file] of read(doc).matchAll(/`((?:src|scripts|e2e|docs|store|tests|mock-server|public)\/[\w./-]+\.(?:ts|tsx|mjs|md|json|yaml|html|txt|png))`/g)) {
        expect(existsSync(join(ROOT, file!)), `${doc}: ${file}`).toBe(true);
      }
    }
  });

  it('third-party notices are current and shipped in the package', () => {
    execFileSync(process.execPath, ['scripts/make-notices.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
    const notices = read('public/THIRD-PARTY-NOTICES.txt');
    for (const name of ['react', '@huggingface/transformers', 'onnxruntime-web', '@mozilla/readability', 'idb', 'valibot', 'Xenova/all-MiniLM-L6-v2']) expect(notices).toContain(name);
    expect(notices).toContain('Apache License');
  });

  it('DECISIONS.md records the assumed Legiit host and the docs differences', () => {
    const doc = read('docs/DECISIONS.md');
    expect(doc).toContain(DEFAULT_LEGIIT_API_BASE_URL);
    expect(doc).toContain('openPanelOnActionClick');
    expect(doc).toContain('REQUIRE_ACCOUNT_AFTER_FREE_RUNS');
    expect(doc.match(/^\*\*D-\d+ · /gm)!.length).toBeGreaterThan(30);
  });
});
