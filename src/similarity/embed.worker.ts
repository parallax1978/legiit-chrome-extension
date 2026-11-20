/// <reference lib="webworker" />
/**
 * On-device sentence embeddings.
 *
 * Runs transformers.js with a quantized all-MiniLM-L6-v2 model. Both the model
 * (/models) and the ONNX Runtime WebAssembly binary (/ort) are files inside
 * the extension package. Remote models are disabled and, as a second line of
 * defence, this worker refuses every request that is not for a file in the
 * package: it cannot reach the network at all.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const packageOrigin = scope.location.origin;

const nativeFetch = scope.fetch.bind(scope);
scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let target: URL;
  try {
    target = new URL(raw, scope.location.href);
  } catch {
    return Promise.reject(new TypeError('Blocked: invalid URL'));
  }
  if (target.origin !== packageOrigin) {
    return Promise.reject(new TypeError(`Blocked: the embedding worker only loads files from the extension package (${target.host})`));
  }
  return nativeFetch(input, init);
}) as typeof fetch;
// transformers.js keeps its own reference to fetch, taken when the library was loaded (before the lines above ran).
env.fetch = scope.fetch;

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const BATCH_SIZE = 16;

export type EmbedRequest = { type: 'init' } | { type: 'embed'; id: number; texts: string[] };
export type EmbedResponse =
  | { type: 'ready'; dims: number }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; dims: number; data: Float32Array }
  | { type: 'error'; id: number | null; message: string };

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function load(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = new URL('/models/', packageOrigin).href;
    // Never used (remote models are off); pointed at the package so that no code path can build a remote address.
    env.remoteHost = new URL('/models/', packageOrigin).href;
    // The Cache API cannot store chrome-extension:// responses, and blob-URL module loading is against the extension CSP.
    env.useBrowserCache = false;
    env.useWasmCache = false;
    const wasm = env.backends.onnx.wasm;
    if (wasm) {
      wasm.wasmPaths = {
        mjs: new URL('/ort/ort-wasm-simd-threaded.mjs', packageOrigin).href,
        wasm: new URL('/ort/ort-wasm-simd-threaded.wasm', packageOrigin).href,
      };
      wasm.numThreads = 1;
      wasm.proxy = false;
    }
    extractor = pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', device: 'wasm' });
  }
  return extractor;
}

function post(message: EmbedResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = async (event: MessageEvent<EmbedRequest>) => {
  const request = event.data;
  const id = request.type === 'embed' ? request.id : null;
  try {
    const model = await load();
    if (request.type === 'init') {
      const probe = await model(['ready'], { pooling: 'mean', normalize: true });
      post({ type: 'ready', dims: probe.dims[1] ?? 0 });
      return;
    }
    const texts = request.texts;
    let dims = 0;
    let out: Float32Array | null = null;
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const output = await model(batch, { pooling: 'mean', normalize: true });
      dims = output.dims[1] ?? 0;
      out ??= new Float32Array(texts.length * dims);
      out.set(output.data as Float32Array, start * dims);
      post({ type: 'progress', id: request.id, done: Math.min(texts.length, start + batch.length), total: texts.length });
    }
    const data = out ?? new Float32Array(0);
    post({ type: 'result', id: request.id, dims, data }, [data.buffer]);
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};
