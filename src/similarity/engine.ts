/**
 * Sentence similarity, behind one interface with two implementations:
 *
 *  - embedding: a quantized MiniLM sentence-embedding model bundled in the
 *    package and run on-device in a worker (src/similarity/embed.worker.ts);
 *  - lexical:   word-overlap cosine, used when the model cannot load.
 *
 * Thresholds are part of the documented method (docs/ARCHITECTURE.md) and are
 * shown in the UI next to every result that depends on them.
 */
import { contentTokens } from '@/lib/text';

export interface Vectors {
  readonly count: number;
  /** Cosine similarity between row i of this set and row j of `other` (same engine). */
  similarity(i: number, other: Vectors, j: number): number;
}

export interface EncodeOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface SimilarityEngine {
  readonly kind: 'embedding' | 'lexical';
  readonly label: string;
  /** Two sentences at or above this similarity are treated as making the same point. */
  readonly sameThreshold: number;
  /** A passage at or above this similarity is shown as related to an answer sentence. */
  readonly passageThreshold: number;
  /** Encodes several groups of texts in one go; returns one vector set per group. */
  encodeGroups(groups: readonly (readonly string[])[], options?: EncodeOptions): Promise<Vectors[]>;
  dispose?(): void;
}

/**
 * all-MiniLM-L6-v2 (quantized), cosine similarity of mean-pooled, normalised
 * embeddings. Calibrated on the fixture corpus: paraphrases of one point score
 * 0.76-0.92, different points on the same topic 0.55-0.71.
 */
export const EMBEDDING_SAME_THRESHOLD = 0.72;
export const EMBEDDING_PASSAGE_THRESHOLD = 0.5;

/** Word-overlap cosine over stemmed content words. Coarser: it misses paraphrases that share few words. */
export const LEXICAL_SAME_THRESHOLD = 0.5;
export const LEXICAL_PASSAGE_THRESHOLD = 0.3;

export class DenseVectors implements Vectors {
  readonly count: number;

  constructor(
    readonly data: Float32Array,
    readonly dims: number,
  ) {
    this.count = dims > 0 ? Math.floor(data.length / dims) : 0;
  }

  similarity(i: number, other: Vectors, j: number): number {
    if (!(other instanceof DenseVectors) || other.dims !== this.dims) return 0;
    const a = this.data;
    const b = other.data;
    const ao = i * this.dims;
    const bo = j * this.dims;
    let sum = 0;
    for (let k = 0; k < this.dims; k++) sum += a[ao + k]! * b[bo + k]!;
    return sum;
  }

  /** A view of rows [start, end) without copying. */
  slice(start: number, end: number): DenseVectors {
    return new DenseVectors(this.data.subarray(start * this.dims, end * this.dims), this.dims);
  }
}

class TokenSets implements Vectors {
  readonly count: number;

  constructor(readonly sets: ReadonlySet<string>[]) {
    this.count = sets.length;
  }

  similarity(i: number, other: Vectors, j: number): number {
    if (!(other instanceof TokenSets)) return 0;
    const a = this.sets[i];
    const b = other.sets[j];
    if (!a || !b || a.size === 0 || b.size === 0) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    for (const token of small) if (large.has(token)) shared++;
    return shared / Math.sqrt(a.size * b.size);
  }
}

export class LexicalEngine implements SimilarityEngine {
  readonly kind = 'lexical' as const;
  readonly label = 'word overlap (fallback)';
  readonly sameThreshold = LEXICAL_SAME_THRESHOLD;
  readonly passageThreshold = LEXICAL_PASSAGE_THRESHOLD;

  async encodeGroups(groups: readonly (readonly string[])[], options: EncodeOptions = {}): Promise<Vectors[]> {
    const total = groups.reduce((sum, g) => sum + g.length, 0);
    let done = 0;
    const out: Vectors[] = [];
    for (const group of groups) {
      out.push(new TokenSets(group.map((text) => new Set(contentTokens(text)))));
      done += group.length;
      options.onProgress?.(done, total);
    }
    return out;
  }
}

/** Splits one flat vector set back into the groups it was built from. */
export function splitDense(all: DenseVectors, groups: readonly (readonly string[])[]): DenseVectors[] {
  const out: DenseVectors[] = [];
  let offset = 0;
  for (const group of groups) {
    out.push(all.slice(offset, offset + group.length));
    offset += group.length;
  }
  return out;
}

/** Highest similarity between row i of `from` and any row of `to`. */
export function bestMatch(from: Vectors, i: number, to: Vectors): { score: number; index: number } {
  let score = -Infinity;
  let index = -1;
  for (let j = 0; j < to.count; j++) {
    const s = from.similarity(i, to, j);
    if (s > score) {
      score = s;
      index = j;
    }
  }
  return index < 0 ? { score: 0, index: -1 } : { score, index };
}
