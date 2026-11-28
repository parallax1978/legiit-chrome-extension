/**
 * Checks on the package itself: dist/ (what gets loaded unpacked) and
 * release.zip (what gets uploaded). These are the store "hard rules" that can
 * be verified by reading files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { GOOGLE_SEARCH_DOMAINS as GOOGLE_DOMAINS } from '../src/config/google-domains';
import { DIST, ROOT } from './lens';

interface ManifestFile {
  manifest_version: number;
  name: string;
  description: string;
  version: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  optional_permissions?: string[];
  content_scripts: { matches: string[]; js: string[]; run_at?: string; all_frames?: boolean; world?: string }[];
  content_security_policy: { extension_pages: string; sandbox?: string };
  background: { service_worker: string; type?: string };
  action: { default_title?: string; default_popup?: string };
  commands: Record<string, unknown>;
  icons: Record<string, string>;
  side_panel: { default_path: string };
  options_ui: { page: string; open_in_tab: boolean };
  minimum_chrome_version: string;
  [key: string]: unknown;
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as ManifestFile;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}
const files = walk(DIST).map((path) => relative(DIST, path).split('\\').join('/')).sort();
const read = (file: string) => readFileSync(join(DIST, file), 'utf8');
const scripts = files.filter((f) => /\.(js|mjs)$/.test(f));
/** Files (of `list`) whose text contains `needle`. Used so that a failure names the file instead of printing it. */
const containing = (list: readonly string[], needle: string | RegExp) => list.filter((f) => (typeof needle === 'string' ? read(f).includes(needle) : needle.test(read(f))));
/** Calls of the global fetch (not a method such as `client.fetch(` and not a word such as `prefetch(`). */
const bareFetchCalls = (source: string) => (source.match(/(?<![.\w$])fetch\(/g) ?? []).length;

/** File names and sizes from a zip's central directory. */
function zipEntries(path: string): { name: string; size: number }[] {
  const data = readFileSync(path);
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a zip file');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries: { name: string; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    entries.push({ name: data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), size: data.readUInt32LE(offset + 24) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test.describe('manifest', () => {
  test('is Manifest V3 with the minimum permissions and nothing else', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage']);
    expect(manifest.optional_permissions).toBeUndefined();
    for (const banned of ['tabs', 'history', 'cookies', 'webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'debugger', 'notifications', 'offscreen', 'downloads', 'webNavigation', 'management', 'nativeMessaging', 'unlimitedStorage']) {
      expect(manifest.permissions, banned).not.toContain(banned);
    }
  });

  test('requires only web.archive.org and the Legiit API host; every other site is optional', () => {
    expect(manifest.host_permissions).toEqual(['https://web.archive.org/*', 'https://lens.legiit.com/*']);
    // One pattern for http and https: a site is requested as "*://*.example.com/*", which must fit inside a single optional pattern.
    expect(manifest.optional_host_permissions).toEqual(['*://*/*']);
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
  });

  test('runs static content scripts only on Google Search and the four AI sites', () => {
    expect(manifest.content_scripts).toHaveLength(2);
    const ai = manifest.content_scripts.find((c) => c.js.includes('content-scripts/ai.js'))!;
    const google = manifest.content_scripts.find((c) => c.js.includes('content-scripts/google.js'))!;
    expect([...ai.matches].sort()).toEqual(['https://chatgpt.com/*', 'https://copilot.microsoft.com/*', 'https://gemini.google.com/*', 'https://perplexity.ai/*', 'https://www.perplexity.ai/*']);
    // Match patterns have no TLD wildcard: one explicit pattern per Google country domain, from one list.
    expect(GOOGLE_DOMAINS.length).toBeGreaterThan(180);
    expect([...google.matches].sort()).toEqual(GOOGLE_DOMAINS.map((domain) => `https://www.${domain}/search*`).sort());
    for (const pattern of google.matches) expect(pattern).toMatch(/^https:\/\/www\.google\.[a-z.]{2,10}\/search\*$/);
    for (const script of manifest.content_scripts) {
      expect(script.all_frames ?? false).toBe(false);
      expect(script.world ?? 'ISOLATED').toBe('ISOLATED');
      expect(script.run_at).toBe('document_idle');
    }
  });

  test('exposes nothing to web pages or other extensions', () => {
    for (const key of ['web_accessible_resources', 'externally_connectable', 'sandbox', 'update_url', 'key', 'oauth2', 'chrome_url_overrides', 'devtools_page', 'declarative_net_request', 'file_browser_handlers', 'nacl_modules']) {
      expect(manifest[key], key).toBeUndefined();
    }
    expect(manifest.content_security_policy.sandbox).toBeUndefined();
  });

  test('has a strict extension-page CSP: local scripts only, WebAssembly allowed, no eval', () => {
    const csp = manifest.content_security_policy.extension_pages;
    const directive = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(csp)?.[1]?.trim();
    expect(directive('script-src')).toBe("'self' 'wasm-unsafe-eval'");
    expect(directive('default-src')).toBe("'self'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('frame-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    // No remote host is named anywhere in the policy.
    expect(csp).not.toMatch(/https?:\/\/[a-z0-9]/i);
  });

  test('the toolbar action has no popup, so a click invokes the extension and grants activeTab', () => {
    expect(manifest.action.default_popup).toBeUndefined();
    expect(Object.keys(manifest.commands)).toEqual(['_execute_action']);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116);
  });

  test('carries the store listing basics', () => {
    expect(manifest.name).toBe('Legiit Lens');
    expect(manifest.name.length).toBeLessThanOrEqual(75);
    expect(manifest.description).toBe('Shows how visible a web page or brand is in Google results and AI answers, and what explains it.');
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const size of [16, 32, 48, 128]) {
      const png = readFileSync(join(DIST, manifest.icons[String(size)]!));
      expect(png.subarray(1, 4).toString(), `icon ${size}`).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], `icon ${size}`).toEqual([size, size]);
    }
  });
});

test.describe('all logic ships in the package', () => {
  test('pages load only local scripts and styles, with no inline script', () => {
    const pages = files.filter((f) => f.endsWith('.html'));
    expect(pages.sort()).toEqual(['health.html', 'onboarding.html', 'options.html', 'print.html', 'sidepanel.html']);
    for (const page of pages) {
      const html = read(page);
      for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) expect(src, page).toMatch(/^\/(chunks|assets)\/[\w.-]+\.js$/);
      for (const [, href] of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) expect(href, page).toMatch(/^\/(chunks|assets|icon)\/[\w.-]+\.(js|css|png)$/);
      expect(html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/g) ?? [], page).toEqual([]);
      expect(html, page).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, page).not.toMatch(/https?:\/\//);
    }
  });

  test('no script uses eval, new Function, remote imports or importScripts', () => {
    expect(containing(scripts, /(?<![.\w$])eval\(/), 'eval').toEqual([]);
    expect(containing(scripts, 'new Function('), 'new Function').toEqual([]);
    expect(containing(scripts, 'importScripts('), 'importScripts').toEqual([]);
    expect(containing(scripts, /import\(\s*["'`]https?:/), 'remote import').toEqual([]);
    expect(containing(scripts, /\bset(?:Timeout|Interval)\(\s*["'`]/), 'string timer').toEqual([]);
    expect(containing(scripts, /<script[^>]+src=["']https?:/), 'remote script tag').toEqual([]);
  });

  test('the output is readable and standard: not minified, no source maps, no obfuscation', () => {
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    for (const file of ['background.js', 'content-scripts/google.js', 'content-scripts/ai.js', 'page-agent.js']) {
      const lines = read(file).split('\n');
      expect(lines.length, file).toBeGreaterThan(300);
      const average = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
      expect(average, `${file}: average line length`).toBeLessThan(80);
      // Comments from the source survive, e.g. the reason each file exists.
      expect(read(file), file).toMatch(/\/\*\*|\/\/ /);
    }
    for (const file of scripts) expect(read(file), file).not.toMatch(/\b_0x[0-9a-f]{4,}\b/);
  });

  test('ships no development-only code', () => {
    expect(Object.keys(manifest.commands).filter((c) => c.startsWith('dev'))).toEqual([]);
    expect(containing(scripts, 'DEVELOPMENT ONLY')).toEqual([]);
    expect(containing(scripts, 'function saveFixture')).toEqual([]);
    // No development server address (the dev build talks to Vite on localhost; the production build must not).
    expect(containing(scripts, /localhost:\d|127\.0\.0\.1|ws:\/\//)).toEqual([]);
    expect(containing(files.filter((f) => f.endsWith('.html')), /localhost|ws:\/\//)).toEqual([]);
  });

  test('bundles the embedding model and runtime, byte for byte as pinned', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'models.lock.json'), 'utf8')) as { models: { id: string; files: { path: string; sha256: string; bytes: number }[] }[] };
    for (const model of lock.models) {
      for (const file of model.files) {
        const data = readFileSync(join(DIST, 'models', model.id, file.path));
        expect(data.length, file.path).toBe(file.bytes);
        expect(createHash('sha256').update(data).digest('hex'), file.path).toBe(file.sha256);
      }
    }
    // One WebAssembly runtime (CPU), not the four that ONNX Runtime ships.
    expect(files.filter((f) => f.endsWith('.wasm'))).toEqual(['ort/ort-wasm-simd-threaded.wasm']);
    expect(files.filter((f) => f.startsWith('ort/')).sort()).toEqual(['ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm']);
  });
});

test.describe('network call sites in the package', () => {
  test('the service worker cannot make a request: it contains no network API at all', () => {
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'RTCPeerConnection']) expect(containing(['background.js'], api), api).toEqual([]);
  });

  test('extension pages have one fetch call site: the guarded one', () => {
    const chunks = scripts.filter((f) => f.startsWith('chunks/'));
    const withFetch = chunks.filter((f) => bareFetchCalls(read(f)) > 0);
    expect(withFetch).toHaveLength(1);
    const source = read(withFetch[0]!);
    expect(bareFetchCalls(source)).toBe(1);
    // It is the function that checks purpose, host and Chrome's permission before every request, and sends no cookies.
    const guard = source.slice(source.indexOf('var NetworkPolicyError'), source.indexOf('fetch(target.href') + 400);
    expect(guard).toContain('Only http(s) URLs can be requested');
    expect(guard).toContain('Wayback requests must go to');
    expect(guard).toContain('Legiit requests must go to');
    expect(guard).toContain('PermissionRequiredError');
    expect(guard).toContain('credentials: "omit"');
    expect(guard).toContain('referrerPolicy: "no-referrer"');
    for (const api of ['new XMLHttpRequest', 'new WebSocket', 'new EventSource', 'sendBeacon(', 'RTCPeerConnection']) expect(containing(chunks, api), api).toEqual([]);
  });

  test('content scripts can only read the page’s own site', () => {
    const contentScripts = ['content-scripts/google.js', 'content-scripts/ai.js', 'page-agent.js'];
    for (const file of contentScripts) {
      const source = read(file);
      // Two call sites, both in the same-origin reader (pages, and the site logo).
      expect(bareFetchCalls(source), file).toBe(2);
      expect(source.match(/const url = sameOriginUrl\(/g) ?? [], file).toHaveLength(2);
      expect(source.match(/credentials: "omit"/g) ?? [], file).toHaveLength(2);
    }
    for (const api of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'innerHTML =', 'outerHTML =', 'insertAdjacentHTML', 'document.write']) expect(containing(contentScripts, api), api).toEqual([]);
  });

  test('the embedding worker blocks every address outside the package, including the library’s own fetch', () => {
    const [worker] = scripts.filter((f) => f.startsWith('assets/embed.worker'));
    const source = read(worker!);
    for (const marker of ['Blocked: the embedding worker only loads files from the extension package', 'env.fetch = scope.fetch;', 'env.allowRemoteModels = false;']) {
      expect(source.includes(marker), marker).toBe(true);
    }
  });

  test('every web address in the code is accounted for', () => {
    /** Hosts that appear as text in the package, and why. None is contacted except the first two. */
    const KNOWN: Record<string, string> = {
      'web.archive.org': 'Rewind: the Wayback Machine (required host)',
      'lens.legiit.com': 'Legiit Command Center API, only when connected (required host)',
      'chatgpt.com': 'content-script match and site list; read only',
      'gemini.google.com': 'content-script match and site list; read only',
      'perplexity.ai': 'content-script match and site list; read only',
      'www.perplexity.ai': 'content-script match and site list; read only',
      'copilot.microsoft.com': 'content-script match and site list; read only',
      'www.w3.org': 'XML/SVG/MathML namespace identifiers',
      'huggingface.co': 'default hub address inside transformers.js; remote models are disabled and the worker blocks it',
      'cdn.jsdelivr.net': 'default WebAssembly location inside ONNX Runtime; replaced by the packaged /ort files and blocked by the worker',
      'github.com': 'links in library comments and error messages',
      'gist.github.com': 'link in a library error message',
      'developer.mozilla.org': 'links in library comments',
      'react.dev': 'links in React error messages',
      'rolldown.rs': 'link in a bundler runtime error message',
      'web.dev': 'link in a library warning',
      'searchfox.org': 'link in a comment of the bundled Readability library',
      'pillow.readthedocs.io': 'link in a library comment',
      'jinja.palletsprojects.com': 'links in the tokenizer template library’s comments',
      'example.com': 'placeholder text in input fields and code comments',
      'example.org': 'placeholder text in input fields',
      'www.example.com': 'example in a code comment',
      'www.Example.com': 'example in a code comment',
      'schema.org': 'JSON-LD vocabulary names',
      // A result that Google labels "Reddit · r/SEO" shows no address: the label names the platform, the table
      // below names its site. The site is shown as text; none of these addresses is ever requested.
      'www.reddit.com': 'platform label on a results page to its site; text only',
      'www.quora.com': 'platform label on a results page to its site; text only',
      'www.youtube.com': 'platform label on a results page to its site; text only',
      'www.facebook.com': 'platform label on a results page to its site; text only',
      'www.linkedin.com': 'platform label on a results page to its site; text only',
      'www.instagram.com': 'platform label on a results page to its site; text only',
      'www.tiktok.com': 'platform label on a results page to its site; text only',
      'www.pinterest.com': 'platform label on a results page to its site; text only',
      'medium.com': 'platform label on a results page to its site; text only',
      'encrypted-tbn0.gstatic.com': 'example in a code comment: the address of a site icon on a results page',
      'legiit.com': 'links to pages of the Legiit marketplace in the Overview; the user clicks them, the extension requests none',
      'www.': 'a string fragment used when normalising domains',
    };
    const unknown = new Map<string, string>();
    for (const file of files.filter((f) => /\.(js|mjs|html|css|json)$/.test(f) && !f.startsWith('models/'))) {
      for (const [, host] of read(file).matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        if (KNOWN[host!] || /^www\.google\.[a-z.]+$/.test(host!)) continue;
        unknown.set(host!, file);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});

test.describe('release package', () => {
  test('release.zip contains exactly the files of dist/, with the manifest at its root', () => {
    const zip = join(ROOT, 'release.zip');
    expect(existsSync(zip)).toBe(true);
    const entries = zipEntries(zip).filter((e) => !e.name.endsWith('/'));
    expect(entries.map((e) => e.name).sort()).toEqual(files);
    expect(entries.some((e) => e.name === 'manifest.json')).toBe(true);
    for (const entry of entries) expect(entry.size, entry.name).toBe(statSync(join(DIST, entry.name)).size);
  });

  test('stays lean: far below the store limit of 2 GB', () => {
    const zipBytes = statSync(join(ROOT, 'release.zip')).size;
    const unpackedBytes = files.reduce((sum, f) => sum + statSync(join(DIST, f)).size, 0);
    expect(zipBytes).toBeLessThan(25 * 1024 * 1024);
    expect(unpackedBytes).toBeLessThan(45 * 1024 * 1024);
    // Everything except the model and the WebAssembly runtime is small.
    const code = files.filter((f) => !f.startsWith('models/') && !f.startsWith('ort/')).reduce((sum, f) => sum + statSync(join(DIST, f)).size, 0);
    expect(code).toBeLessThan(3 * 1024 * 1024);
    expect(files.length).toBeLessThan(60);
  });
});
