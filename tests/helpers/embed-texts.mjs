#!/usr/bin/env node
/**
 * Embeds texts with the sentence model that is bundled in the extension
 * (public/models), the way the extension's worker does it
 * (src/similarity/embed.worker.ts): the quantized model, batches of 16 in the
 * order given, mean pooling, normalised vectors. Keep these settings in step
 * with the worker.
 *
 * It runs in a plain Node process, because the model runtime does not work
 * inside the jsdom test environment. tests/helpers/api-examples.ts starts it
 * to record the similarities that the example of a content analysis is built
 * from. It never touches the network: remote models are switched off.
 *
 *   stdin:  a JSON array of texts
 *   stdout: JSON { "dims": 384, "data": "<the Float32Array of all vectors, little-endian, as base64>" }
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 16;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'models')}/`;

const texts = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) throw new Error('Expected a JSON array of texts on stdin');

const model = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
let dims = 0;
let out = null;
for (let start = 0; start < texts.length; start += BATCH_SIZE) {
  const output = await model(texts.slice(start, start + BATCH_SIZE), { pooling: 'mean', normalize: true });
  dims = output.dims[1] ?? 0;
  out ??= new Float32Array(texts.length * dims);
  out.set(output.data, start * dims);
}
const data = out ?? new Float32Array(0);
process.stdout.write(JSON.stringify({ dims, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') }));
