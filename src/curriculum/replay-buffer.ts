/**
 * Experience Replay Buffer — prioritized sampling of past episodes for learning.
 *
 * Uses a ring buffer backing for fixed memory with O(1) push/eviction.
 * Supports prioritized sampling by TD-error / surprise score, importance
 * sampling weights for bias correction, and compressed episode storage
 * with quantized embeddings.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

import type { Episode } from '../types.js';
import { RingBuffer } from '../utils/ring-buffer.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Small constant added to priorities to ensure non-zero sampling probability. */
const EPSILON = 1e-6;

/** Default buffer capacity. */
const DEFAULT_CAPACITY = 10_000;

/** Default prioritization exponent (0 = uniform, 1 = fully prioritized). */
const DEFAULT_ALPHA = 0.6;

/** Default importance-sampling correction exponent. */
const DEFAULT_BETA = 0.4;

/** Default per-sample increment for beta toward 1.0. */
const DEFAULT_BETA_INCREMENT = 0.001;

/** Default priority assigned when no TD-error is provided. */
const DEFAULT_PRIORITY = 1.0;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the replay buffer.
 */
export interface ReplayBufferOptions {
  /** Maximum number of episodes the buffer can hold. */
  capacity?: number;

  /** Prioritization exponent. 0 = uniform sampling, 1 = fully prioritized. */
  alpha?: number;

  /** Importance-sampling correction exponent. Anneals toward 1.0 over time. */
  beta?: number;

  /** Per-sample increment applied to beta after each `sample()` call. */
  betaIncrement?: number;
}

/**
 * Compressed representation of an episode for memory-efficient storage.
 *
 * Strips the full actions array and flattens outcome fields to reduce
 * per-entry memory footprint.
 */
export interface CompressedEpisode {
  /** Episode identifier. */
  id: string;

  /** The task description that was attempted. */
  task: string;

  /** Scalar reward signal from the episode. */
  reward: number;

  /** Unix-epoch ms timestamp of the episode. */
  timestamp: number;

  /** Number of actions taken (instead of storing the full array). */
  actionCount: number;

  /** Whether the episode outcome was successful. */
  outcomeSuccess: boolean;

  /** Machine-friendly error category, if the episode failed. */
  errorType?: string;

  /** TD-error / surprise score used for prioritized sampling. */
  priority: number;

  /**
   * Quantized embedding compressed from float64/float32 to Int8Array.
   * Stored as a plain number array for JSON serialization; converted
   * to Int8Array at runtime when needed.
   */
  quantizedEmbedding?: number[];

  /** Min value used during quantization (needed for dequantization). */
  embeddingMin?: number;

  /** Scale factor used during quantization (needed for dequantization). */
  embeddingScale?: number;
}

/**
 * A single sample returned by `sample()`, including the compressed episode
 * and its importance-sampling weight for bias correction.
 */
export interface ReplaySample {
  /** The compressed episode data. */
  episode: CompressedEpisode;

  /** Importance-sampling weight for bias correction. */
  weight: number;

  /** Index of this sample in the internal buffer (for priority updates). */
  index: number;
}

/**
 * Aggregate statistics about the replay buffer's current state.
 */
export interface ReplayBufferStats {
  /** Number of episodes currently stored. */
  length: number;

  /** Maximum capacity of the buffer. */
  capacity: number;

  /** Whether the buffer has reached full capacity. */
  isFull: boolean;

  /** Current prioritization exponent. */
  alpha: number;

  /** Current importance-sampling correction exponent. */
  beta: number;

  /** Highest priority value in the buffer. */
  maxPriority: number;

  /** Lowest priority value in the buffer. */
  minPriority: number;

  /** Mean priority across all stored episodes. */
  meanPriority: number;

  /** Total number of episodes ever added (including evicted). */
  totalAdded: number;

  /** Total number of sample() calls made. */
  totalSampled: number;
}

// ---------------------------------------------------------------------------
// Quantization helpers
// ---------------------------------------------------------------------------

/**
 * Compress a float embedding into an Int8-range array.
 *
 * Maps the float range `[min, max]` linearly to `[-128, 127]`. Returns
 * the quantized values along with the `min` and `scale` parameters
 * needed for dequantization.
 *
 * @param embedding - The original float embedding vector.
 * @returns The quantized values and reconstruction parameters.
 */
export function quantizeEmbedding(embedding: number[]): {
  quantized: number[];
  min: number;
  scale: number;
} {
  if (embedding.length === 0) {
    return { quantized: [], min: 0, scale: 1 };
  }

  let min = embedding[0];
  let max = embedding[0];
  for (let i = 1; i < embedding.length; i++) {
    if (embedding[i] < min) min = embedding[i];
    if (embedding[i] > max) max = embedding[i];
  }

  const range = max - min;
  // Avoid division by zero when all values are identical
  const scale = range === 0 ? 1 : range / 255;

  const quantized: number[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    // Map to [-128, 127]
    quantized[i] = Math.round((embedding[i] - min) / scale) - 128;
  }

  return { quantized, min, scale };
}

/**
 * Reconstruct a float embedding from quantized Int8 values.
 *
 * @param quantized - The Int8-range values.
 * @param min       - The original minimum value.
 * @param scale     - The quantization scale factor.
 * @returns Reconstructed float embedding (approximate).
 */
export function dequantizeEmbedding(
  quantized: number[],
  min: number,
  scale: number,
): number[] {
  const result: number[] = new Array(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    result[i] = (quantized[i] + 128) * scale + min;
  }
  return result;
}

// ---------------------------------------------------------------------------
// ReplayBuffer class
// ---------------------------------------------------------------------------

/**
 * Prioritized experience replay buffer for sampling past episodes.
 *
 * Episodes are stored in compressed form inside a fixed-capacity ring buffer.
 * Sampling probability is proportional to `priority^alpha`, and importance-
 * sampling weights correct for the resulting bias.
 */
export class ReplayBuffer {
  private readonly buffer: RingBuffer<CompressedEpisode>;
  private readonly _capacity: number;
  private readonly alpha: number;
  private beta: number;
  private readonly betaIncrement: number;
  private readonly logger: Logger;

  /** Running count of episodes ever added. */
  private totalAdded: number = 0;

  /** Running count of sample() calls. */
  private totalSampled: number = 0;

  constructor(options: ReplayBufferOptions = {}) {
    this._capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
    this.beta = options.beta ?? DEFAULT_BETA;
    this.betaIncrement = options.betaIncrement ?? DEFAULT_BETA_INCREMENT;
    this.buffer = new RingBuffer<CompressedEpisode>(this._capacity);
    this.logger = new Logger({ prefix: 'replay-buffer' });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add an episode to the replay buffer.
   *
   * The episode is compressed before storage. Priority is set to
   * `|tdError| + epsilon` if a TD-error is provided, otherwise a default
   * priority is used.
   *
   * @param episode - The full episode to store.
   * @param tdError - Optional TD-error / surprise score for prioritization.
   * @returns The evicted compressed episode if the buffer was full, or undefined.
   */
  add(episode: Episode, tdError?: number): CompressedEpisode | undefined {
    const priority =
      tdError !== undefined ? Math.abs(tdError) + EPSILON : DEFAULT_PRIORITY;
    const compressed = this.compress(episode, priority);
    const evicted = this.buffer.push(compressed);
    this.totalAdded++;

    this.logger.debug('Episode added to replay buffer', {
      id: episode.id,
      priority,
      bufferLength: this.buffer.length,
    });

    return evicted;
  }

  /**
   * Sample a batch of episodes using prioritized replay.
   *
   * Sampling probability is proportional to `priority^alpha`. Each returned
   * sample includes an importance-sampling weight for bias correction,
   * computed as `(1/N * 1/P(i))^beta` and normalized by the maximum weight
   * in the batch.
   *
   * Beta is incremented toward 1.0 after each call.
   *
   * @param batchSize - Number of episodes to sample.
   * @returns Array of replay samples with IS weights.
   */
  sample(batchSize: number): ReplaySample[] {
    const n = this.buffer.length;
    if (n === 0) {
      return [];
    }

    const effectiveBatch = Math.min(batchSize, n);

    // Build priority^alpha array and compute sum
    const priorities: number[] = new Array(n);
    let prioritySum = 0;
    for (let i = 0; i < n; i++) {
      const p = Math.pow(this.buffer.get(i).priority, this.alpha);
      priorities[i] = p;
      prioritySum += p;
    }

    // Sample indices proportional to priority^alpha (without replacement)
    const sampledIndices = new Set<number>();
    const samples: ReplaySample[] = [];

    while (sampledIndices.size < effectiveBatch) {
      const r = Math.random() * prioritySum;
      let cumulative = 0;
      for (let i = 0; i < n; i++) {
        cumulative += priorities[i];
        if (cumulative >= r && !sampledIndices.has(i)) {
          sampledIndices.add(i);
          break;
        }
      }
      // If we didn't find a unique index due to floating-point edge cases,
      // fall back to linear scan for an unsampled entry
      if (sampledIndices.size < samples.length + 1) {
        for (let i = 0; i < n; i++) {
          if (!sampledIndices.has(i)) {
            sampledIndices.add(i);
            break;
          }
        }
      }
    }

    // Compute IS weights
    const beta = this.beta;
    let maxWeight = 0;

    for (const idx of sampledIndices) {
      const prob = priorities[idx] / prioritySum;
      const weight = Math.pow(1 / (n * prob), beta);
      if (weight > maxWeight) maxWeight = weight;

      samples.push({
        episode: this.buffer.get(idx),
        weight, // will be normalized below
        index: idx,
      });
    }

    // Normalize weights by max weight for stability
    if (maxWeight > 0) {
      for (const s of samples) {
        s.weight /= maxWeight;
      }
    }

    // Anneal beta toward 1.0
    this.beta = Math.min(1.0, this.beta + this.betaIncrement);
    this.totalSampled++;

    this.logger.debug('Sampled from replay buffer', {
      batchSize: effectiveBatch,
      beta: this.beta,
    });

    return samples;
  }

  /**
   * Update priorities for previously sampled episodes.
   *
   * Typically called after a learning step with updated TD-errors.
   *
   * @param updates - Array of `{ id, priority }` pairs to update.
   */
  updatePriorities(updates: Array<{ id: string; priority: number }>): void {
    const idMap = new Map(updates.map((u) => [u.id, u.priority]));
    const n = this.buffer.length;

    for (let i = 0; i < n; i++) {
      const entry = this.buffer.get(i);
      const newPriority = idMap.get(entry.id);
      if (newPriority !== undefined) {
        entry.priority = Math.abs(newPriority) + EPSILON;
      }
    }

    this.logger.debug('Updated priorities', { count: updates.length });
  }

  /**
   * Return aggregate statistics about the buffer's current state.
   */
  getStats(): ReplayBufferStats {
    const n = this.buffer.length;
    let maxPriority = 0;
    let minPriority = Infinity;
    let sumPriority = 0;

    for (let i = 0; i < n; i++) {
      const p = this.buffer.get(i).priority;
      if (p > maxPriority) maxPriority = p;
      if (p < minPriority) minPriority = p;
      sumPriority += p;
    }

    if (n === 0) {
      minPriority = 0;
    }

    return {
      length: n,
      capacity: this._capacity,
      isFull: this.buffer.isFull,
      alpha: this.alpha,
      beta: this.beta,
      maxPriority,
      minPriority,
      meanPriority: n > 0 ? sumPriority / n : 0,
      totalAdded: this.totalAdded,
      totalSampled: this.totalSampled,
    };
  }

  /**
   * Persist the buffer contents and configuration to a JSON file.
   *
   * @param filePath - Absolute path to write the JSON file.
   */
  async save(filePath: string): Promise<void> {
    const data = {
      capacity: this._capacity,
      alpha: this.alpha,
      beta: this.beta,
      betaIncrement: this.betaIncrement,
      totalAdded: this.totalAdded,
      totalSampled: this.totalSampled,
      episodes: this.buffer.toArray(),
    };

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    this.logger.info('Replay buffer saved', { filePath, length: this.buffer.length });
  }

  /**
   * Load buffer contents from a previously saved JSON file.
   *
   * Replaces the current buffer contents. The loaded capacity must match
   * the buffer's configured capacity; episodes are re-inserted in order.
   *
   * @param filePath - Absolute path to the JSON file.
   */
  async load(filePath: string): Promise<void> {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as {
      capacity: number;
      alpha: number;
      beta: number;
      betaIncrement: number;
      totalAdded: number;
      totalSampled: number;
      episodes: CompressedEpisode[];
    };

    this.buffer.clear();
    for (const ep of data.episodes) {
      this.buffer.push(ep);
    }

    this.beta = data.beta;
    this.totalAdded = data.totalAdded;
    this.totalSampled = data.totalSampled;

    this.logger.info('Replay buffer loaded', {
      filePath,
      length: this.buffer.length,
      beta: this.beta,
    });
  }

  /**
   * Remove all episodes from the buffer and reset counters.
   */
  clear(): void {
    this.buffer.clear();
    this.totalAdded = 0;
    this.totalSampled = 0;
    this.logger.info('Replay buffer cleared');
  }

  /** Number of episodes currently in the buffer. */
  get length(): number {
    return this.buffer.length;
  }

  /** Maximum capacity of the buffer. */
  get capacity(): number {
    return this._capacity;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Compress a full episode into a memory-efficient representation.
   *
   * Strips the actions array (keeping only the count), flattens outcome
   * fields, and optionally quantizes the embedding vector.
   */
  private compress(episode: Episode, priority: number): CompressedEpisode {
    const compressed: CompressedEpisode = {
      id: episode.id,
      task: episode.task,
      reward: episode.reward,
      timestamp: episode.timestamp,
      actionCount: episode.actions.length,
      outcomeSuccess: episode.outcome.success,
      priority,
    };

    if (episode.outcome.errorType) {
      compressed.errorType = episode.outcome.errorType;
    }

    if (episode.embedding && episode.embedding.length > 0) {
      const { quantized, min, scale } = quantizeEmbedding(episode.embedding);
      compressed.quantizedEmbedding = quantized;
      compressed.embeddingMin = min;
      compressed.embeddingScale = scale;
    }

    return compressed;
  }
}
