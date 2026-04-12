/**
 * Integration module — effectiveness tracking, telemetry, episode detection,
 * and implicit reward signal utilities.
 */

export { EffectivenessTracker } from './effectiveness-tracker.js';
export type {
  SessionMetrics,
  EffectivenessSuggestion,
  EffectivenessReport,
} from './effectiveness-tracker.js';

export { TelemetryCollector } from './telemetry.js';
export type {
  TelemetryEvent,
  ToolStats,
  TelemetrySummary,
  TelemetryCollectorOptions,
} from './telemetry.js';

export { EpisodeDetector } from './episode-detector.js';
export type {
  DetectionRule,
  DetectedEpisode,
  EpisodeDetectorOptions,
} from './episode-detector.js';

export { ImplicitRewardEngine } from './implicit-rewards.js';
export type {
  RewardSignal,
  EpisodeReward,
  SessionRewardSummary,
  ImplicitRewardOptions,
} from './implicit-rewards.js';
