#!/usr/bin/env node
/**
 * Downloads (or verifies) the sentence-embedding model that ships inside the
 * extension package. The model is never fetched at runtime: New or Noise runs
 * transformers.js with remote models disabled and a local model path.
 *
 * Files come from a pinned Hugging Face revision and are checked against the
 * SHA-256 digests in models.lock.json, so the package always contains exactly
 * the reviewed bytes.
 *
 *   node scripts/fetch-model.mjs                download missing files, verify all
 *   node scripts/fetch-model.mjs --verify-only  verify, never touch the network
 *   node scripts/fetch-model.mjs --write-lock   (maintainers) re-pin digests
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'models.lock.json');
const verifyOnly = process.argv.includes('--verify-only');
const writeLock = process.argv.includes('--write-lock');

const lock = JSON.parse(await readFile(lockPath, 'utf8'));

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let failed = false;
for (const model of lock.models) {
  const destDir = join(root, 'public', 'models', model.id);
  for (const file of model.files) {
    const dest = join(destDir, file.path);
    if (!(await exists(dest))) {
      if (verifyOnly) {
        console.error(`missing  ${model.id}/${file.path}`);
        failed = true;
        continue;
      }
      const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`;
      process.stdout.write(`download ${url}\n`);
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  failed: HTTP ${res.status}`);
        failed = true;
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    }
    const digest = await sha256(dest);
    const size = (await stat(dest)).size;
    if (writeLock) {
      file.sha256 = digest;
      file.bytes = size;
      console.log(`pinned   ${model.id}/${file.path}  ${digest}`);
    } else if (file.sha256 !== digest) {
      console.error(`MISMATCH ${model.id}/${file.path}\n  expected ${file.sha256}\n  actual   ${digest}`);
      failed = true;
    } else {
      console.log(`ok       ${model.id}/${file.path}  (${(size / 1048576).toFixed(2)} MB)`);
    }
  }
}

if (writeLock) {
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log('models.lock.json updated');
}
if (failed) {
  console.error('\nModel files are missing or do not match models.lock.json.');
  console.error('Run "npm run model:fetch" with network access to huggingface.co.');
  process.exit(1);
}
