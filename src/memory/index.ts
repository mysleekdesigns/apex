/**
 * APEX Memory System — barrel exports.
 */

export { WorkingMemory, type WorkingMemoryEntry, type WorkingMemoryOptions, type WorkingMemoryStats } from './working.js';
export { EpisodicMemory, type Segment, type HeatWeights, type EpisodicMemoryOptions, type EpisodicStats } from './episodic.js';
export { SemanticMemory, type SemanticMemoryOptions, type SemanticMemoryStats } from './semantic.js';
export { ProceduralMemory, type StoredSkill } from './procedural.js';
export { StalenessDetector, type StalenessResult, type StalenessStats } from './staleness.js';
export { SnapshotManager, type SnapshotManagerOptions } from './snapshots.js';
export { EmbeddingStore, type QuantizedInt8, type EmbeddingStoreStats } from './embedding-store.js';
export { MemoryManager, type MemoryManagerOptions, type MemoryStats } from './manager.js';
