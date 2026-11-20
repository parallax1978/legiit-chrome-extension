/** Main-thread side of the embedding worker, and the engine picker with its lexical fallback. */
import { AbortError } from '@/lib/async';
import {
  DenseVectors,
  EMBEDDING_PASSAGE_THRESHOLD,
  EMBEDDING_SAME_THRESHOLD,
  LexicalEngine,
  splitDense,
  type EncodeOptions,
  type SimilarityEngine,
  type Vectors,
} from './engine';
import type { EmbedRequest, EmbedResponse } from './embed.worker';

const INIT_TIMEOUT_MS = 90_000;

interface Pending {
  resolve: (value: DenseVectors) => void;
  reject: (reason: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

export class EmbeddingEngine implements SimilarityEngine {
  readonly kind = 'embedding' as const;
  readonly label = 'on-device sentence embeddings (all-MiniLM-L6-v2)';
  readonly sameThreshold = EMBEDDING_SAME_THRESHOLD;
  readonly passageThreshold = EMBEDDING_PASSAGE_THRESHOLD;

  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<EmbedResponse>) => this.onMessage(event.data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'The embedding worker stopped'));
  }

  /** Starts the worker and loads the bundled model. Rejects if the model cannot be loaded. */
  static create(): Promise<EmbeddingEngine> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('Loading the on-device model timed out'));
      }, INIT_TIMEOUT_MS);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || 'The embedding worker failed to start'));
      };
      worker.onmessage = (event: MessageEvent<EmbedResponse>) => {
        clearTimeout(timer);
        if (event.data.type === 'ready') {
          resolve(new EmbeddingEngine(worker));
        } else {
          worker.terminate();
          reject(new Error(event.data.type === 'error' ? event.data.message : 'Unexpected reply from the embedding worker'));
        }
      };
      worker.postMessage({ type: 'init' } satisfies EmbedRequest);
    });
  }

  private onMessage(message: EmbedResponse): void {
    if (message.type === 'ready') return;
    if (message.id === null) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message.done, message.total);
    } else if (message.type === 'result') {
      this.pending.delete(message.id);
      entry.resolve(new DenseVectors(message.data, message.dims));
    } else {
      this.pending.delete(message.id);
      entry.reject(new Error(message.message));
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private embed(texts: string[], options: EncodeOptions): Promise<DenseVectors> {
    if (texts.length === 0) return Promise.resolve(new DenseVectors(new Float32Array(0), 384));
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onProgress: options.onProgress });
      options.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(id)) reject(new AbortError());
        },
        { once: true },
      );
      this.worker.postMessage({ type: 'embed', id, texts } satisfies EmbedRequest);
    });
  }

  async encodeGroups(groups: readonly (readonly string[])[], options: EncodeOptions = {}): Promise<Vectors[]> {
    const all = await this.embed(groups.flat(), options);
    return splitDense(all, groups);
  }

  dispose(): void {
    this.failAll(new AbortError());
    this.worker.terminate();
  }
}

export interface EngineChoice {
  engine: SimilarityEngine;
  /** Set when the bundled model could not be used and word overlap is used instead. */
  fallbackReason: string | null;
}

let shared: Promise<EngineChoice> | null = null;

/**
 * Returns the embedding engine, or the lexical engine with the reason the
 * model was unavailable. The result is shared for the lifetime of the page.
 */
export function getEngine(): Promise<EngineChoice> {
  shared ??= (async (): Promise<EngineChoice> => {
    if (typeof Worker === 'undefined') {
      return { engine: new LexicalEngine(), fallbackReason: 'Workers are not available in this context' };
    }
    try {
      return { engine: await EmbeddingEngine.create(), fallbackReason: null };
    } catch (error) {
      return { engine: new LexicalEngine(), fallbackReason: error instanceof Error ? error.message : String(error) };
    }
  })();
  return shared;
}

/** For tests and for "retry loading the model". */
export function resetEngine(): void {
  void shared?.then((choice) => choice.engine.dispose?.());
  shared = null;
}
