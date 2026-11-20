/**
 * The same bundled model the extension runs in its worker, loaded through the
 * Node build of transformers.js so unit tests can check real embeddings
 * against the documented thresholds. Never touches the network.
 */
import { resolve } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import {
  DenseVectors,
  EMBEDDING_PASSAGE_THRESHOLD,
  EMBEDDING_SAME_THRESHOLD,
  splitDense,
  type SimilarityEngine,
  type Vectors,
} from '@/similarity/engine';

let extractor: Promise<FeatureExtractionPipeline> | null = null;

export class NodeEmbeddingEngine implements SimilarityEngine {
  readonly kind = 'embedding' as const;
  readonly label = 'on-device sentence embeddings (all-MiniLM-L6-v2)';
  readonly sameThreshold = EMBEDDING_SAME_THRESHOLD;
  readonly passageThreshold = EMBEDDING_PASSAGE_THRESHOLD;

  async encodeGroups(groups: readonly (readonly string[])[]): Promise<Vectors[]> {
    if (!extractor) {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = `${resolve(__dirname, '../../public/models')}/`;
      extractor = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    }
    const model = await extractor;
    const texts = groups.flat();
    if (texts.length === 0) return groups.map(() => new DenseVectors(new Float32Array(0), 384));
    const output = await model(texts, { pooling: 'mean', normalize: true });
    return splitDense(new DenseVectors(output.data as Float32Array, output.dims[1] ?? 384), groups);
  }
}
