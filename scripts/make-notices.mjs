#!/usr/bin/env node
/**
 * Writes public/THIRD-PARTY-NOTICES.txt: the open-source components that are
 * bundled into the extension package, with their licences. The file ships
 * inside the package (and release.zip), as those licences require.
 *
 * Versions and licence texts are read from node_modules, so the file follows
 * package.json. `npm run build` regenerates it; `--check` fails if the
 * committed file is out of date.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const out = join(root, 'public', 'THIRD-PARTY-NOTICES.txt');

/** Packages whose code ends up in dist/ (see the module comments in the unminified build output). */
const BUNDLED = [
  ['react', 'UI of the side panel and extension pages'],
  ['react-dom', 'UI of the side panel and extension pages'],
  ['scheduler', 'used by react-dom'],
  ['@huggingface/transformers', 'runs the on-device sentence-embedding model (New or Noise, Why Not Me passages)'],
  ['@huggingface/jinja', 'included in @huggingface/transformers'],
  ['@huggingface/tokenizers', 'included in @huggingface/transformers'],
  ['onnxruntime-web', 'WebAssembly runtime for the model (files under /ort)'],
  ['onnxruntime-common', 'used by onnxruntime-web'],
  ['@mozilla/readability', 'main-content extraction'],
  ['idb', 'IndexedDB wrapper'],
  ['valibot', 'validation of messages and stored data'],
  ['wxt', 'small runtime helpers from the build tool'],
];

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const rule = (char = '-') => char.repeat(78);
const clean = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

function describe(name, purpose) {
  const dir = join(root, 'node_modules', name);
  if (!existsSync(join(dir, 'package.json'))) return null;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? '');
  const licenceFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  const lines = [
    rule(),
    `${name} ${pkg.version}`,
    `Licence: ${pkg.license ?? 'see repository'}`,
    `Used for: ${purpose}`,
    repo ? `Source: ${repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')}` : null,
    author ? `Author (from its package.json): ${author}` : null,
    rule(),
    '',
  ].filter((line) => line !== null);
  if (licenceFile) {
    lines.push(clean(readFileSync(join(dir, licenceFile), 'utf8')));
  } else if (pkg.license === 'MIT') {
    lines.push(
      'The npm distribution of this package carries no licence file. It is released under the MIT licence;',
      'the copyright notice is in the source repository above. The MIT licence terms are:',
      '',
      MIT_TEXT,
    );
  } else {
    lines.push(`Released under ${pkg.license}. See the source repository above for the licence text.`);
  }
  return lines.join('\n');
}

const lock = JSON.parse(readFileSync(join(root, 'models.lock.json'), 'utf8'));
const sections = [];
for (const [name, purpose] of BUNDLED) {
  const section = describe(name, purpose);
  if (section) sections.push(section);
}

const modelLines = lock.models.map((model) =>
  [
    rule(),
    `Model: ${model.id} (revision ${model.revision})`,
    `Licence: ${model.license}`,
    'Used for: sentence embeddings, computed on the device',
    `Source: https://huggingface.co/${model.id}`,
    `Upstream: ${model.upstream}`,
    rule(),
    '',
    'The model files under /models are redistributed unmodified under the Apache License, Version 2.0.',
    'The full text of that licence is reproduced above under @huggingface/transformers.',
  ].join('\n'),
);

const text = `${[
  'Legiit Lens: third-party notices',
  rule('='),
  '',
  'This extension contains the open-source components listed below. Each is used',
  'unmodified. Their licences require that this notice travels with the software.',
  '',
  ...sections.flatMap((s) => [s, '']),
  ...modelLines.flatMap((s) => [s, '']),
].join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (current !== text) {
    console.error('public/THIRD-PARTY-NOTICES.txt is out of date. Run: node scripts/make-notices.mjs');
    process.exit(1);
  }
  console.log('third-party notices are up to date');
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out.slice(root.length + 1)} (${sections.length} packages, ${lock.models.length} model, ${(text.length / 1024).toFixed(1)} KB)`);
}
