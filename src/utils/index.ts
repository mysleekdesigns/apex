/**
 * APEX shared utilities — barrel export.
 */

export {
  extractKeywords,
  tfidfVector,
  simHash,
  simHashSimilarity,
  SemanticEmbedder,
  getEmbedding,
  getEmbeddingAsync,
  getSemanticEmbedder,
} from './embeddings.js';
export type { EmbeddingResult } from './embeddings.js';

export {
  cosineSimilarity,
  jaccardSimilarity,
  combinedSimilarity,
} from './similarity.js';

export {
  fnv1aHash,
  contentHash,
} from './hashing.js';

export {
  serializeEpisode,
  deserializeEpisode,
  serializeEmbedding,
  deserializeEmbedding,
} from './serialization.js';

export { RingBuffer } from './ring-buffer.js';

export { EventBus } from './event-bus.js';

export { Logger } from './logger.js';
export type { LogLevel, LoggerOptions } from './logger.js';

export { HNSWIndex } from './vector-index.js';
export type { HNSWConfig, SearchResult } from './vector-index.js';
