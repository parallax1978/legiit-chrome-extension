#!/usr/bin/env node
/**
 * Final step of `npm run build`.
 *
 * WXT has already produced the production build (.output/chrome-mv3) and its
 * zip. This script copies them to the two artefacts the release process uses:
 *
 *   dist/         the unpacked extension (load it at chrome://extensions)
 *   release.zip   the file to upload to the Chrome Web Store
 *
 * and refuses to finish if the package breaks one of the store hard rules.
 */
import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const built = join(root, '.output', 'chrome-mv3');
const dist = join(root, 'dist');
const releaseZip = join(root, 'release.zip');

const STORE_ZIP_LIMIT = 2 * 1024 ** 3; // "The maximum supported file size for an extension package is 2GB."
const ALLOWED_PERMISSIONS = ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'];

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ path: full.slice(base.length + 1), size: (await stat(full)).size });
  }
  return out;
}

const manifest = JSON.parse(await readFile(join(built, 'manifest.json'), 'utf8'));
check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(
  JSON.stringify([...(manifest.permissions ?? [])].sort()) === JSON.stringify(ALLOWED_PERMISSIONS),
  `permissions must be exactly ${ALLOWED_PERMISSIONS.join(', ')} (found ${manifest.permissions})`,
);
check((manifest.host_permissions ?? []).length === 2, `expected exactly two required hosts (found ${manifest.host_permissions})`);
check((manifest.host_permissions ?? []).includes('https://web.archive.org/*'), 'web.archive.org must be a required host');
check(!(manifest.host_permissions ?? []).some((h) => /[*]:\/\/[*]\/|<all_urls>|^https?:\/\/\*\//.test(h)), 'no broad host may be required at install');
check(
  JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(['*://*/*']),
  'optional_host_permissions must be exactly ["*://*/*"]: Chrome refuses a per-site request ("*://*.example.com/*") unless it fits inside one optional pattern',
);
check(manifest.web_accessible_resources === undefined, 'the package must not expose web-accessible resources');
check(!Object.keys(manifest.commands ?? {}).some((c) => c.startsWith('dev-')), 'development commands must not ship');
const csp = String(manifest.content_security_policy?.extension_pages);
const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
check(scriptSrc.trim() === "'self' 'wasm-unsafe-eval'", `script-src must be exactly 'self' 'wasm-unsafe-eval' (found ${scriptSrc})`);
check(/default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /frame-src 'none'/.test(csp), 'CSP must keep default-src, object-src and frame-src locked down');
check(!/https?:\/\/[a-z0-9]/i.test(csp), 'CSP must not name any remote host');
check((manifest.description ?? '').length <= 132, 'the manifest description (store summary) is limited to 132 characters');
for (const banned of ['tabs', 'history', 'cookies', 'webRequest', 'debugger', 'notifications', 'offscreen', 'downloads']) {
  check(!(manifest.permissions ?? []).includes(banned), `permission "${banned}" is not allowed`);
}

const files = await walk(built);
check(!files.some((f) => f.path.endsWith('.map')), 'source maps must not ship');
for (const file of files.filter((f) => f.path.endsWith('.html'))) {
  const html = await readFile(join(built, file.path), 'utf8');
  check(!/<(script|link)[^>]+(src|href)=["']https?:/i.test(html), `${file.path} loads a remote script or stylesheet`);
  check(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html), `${file.path} contains an inline script`);
}
for (const file of files.filter((f) => /\.(js|mjs)$/.test(f.path) && !f.path.startsWith('ort/'))) {
  const code = await readFile(join(built, file.path), 'utf8');
  check(!/data-lens-saved|function saveFixture/.test(code), `${file.path} contains the dev-only fixture saver`);
}

const zips = (await readdir(join(root, '.output'))).filter((name) => name.endsWith('-chrome.zip'));
check(zips.length === 1, `expected one zip in .output (found ${zips.length}); run "wxt zip"`);

if (problems.length > 0) {
  console.error('\nThe build broke a packaging rule:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await cp(built, dist, { recursive: true });
await rm(releaseZip, { force: true });
await cp(join(root, '.output', zips[0]), releaseZip);

const zipSize = (await stat(releaseZip)).size;
if (zipSize >= STORE_ZIP_LIMIT) {
  console.error(`release.zip is ${(zipSize / 1024 ** 2).toFixed(1)} MB, over the Chrome Web Store limit of 2 GB.`);
  process.exit(1);
}
const unpacked = files.reduce((sum, f) => sum + f.size, 0);
const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 4);
console.log(`\ndist/         ${files.length} files, ${(unpacked / 1024 ** 2).toFixed(1)} MB unpacked`);
console.log(`release.zip   ${(zipSize / 1024 ** 2).toFixed(1)} MB (store limit: 2048 MB)`);
console.log(`largest files ${largest.map((f) => `${f.path} ${(f.size / 1024 ** 2).toFixed(1)} MB`).join(', ')}`);
console.log(`version       ${manifest.version}, ${manifest.permissions.length} permissions, ${manifest.host_permissions.length} required hosts`);
