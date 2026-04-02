/**
 * APEX Curriculum & Experience Replay — barrel exports.
 */

export {
  ReplayBuffer,
  quantizeEmbedding,
  dequantizeEmbedding,
  type CompressedEpisode,
  type ReplayBufferOptions,
  type ReplaySample,
  type ReplayBufferStats,
} from './replay-buffer.js';

export {
  DifficultyEstimator,
  type DifficultyEstimate,
  type DifficultyEstimatorOptions,
} from './difficulty.js';

export {
  CurriculumGenerator,
  type CurriculumSuggestion,
  type DomainProgress,
  type CurriculumGeneratorOptions,
} from './generator.js';

export {
  SkillExtractor,
  type ActionPattern,
  type SkillCandidate,
  type SkillChain,
  type SkillExtractorOptions,
} from './skill-extractor.js';
