/**
 * Serialization utilities for APEX episodes and embeddings.
 * Phase 1: JSON-based serialization. Binary formats in later phases.
 */

import type { Episode } from '../types.js';

/**
 * Serialize an Episode to a Buffer (JSON, Phase 1).
 * BigInt values (simhash) are converted to string for JSON compatibility.
 */
export function serializeEpisode(episode: Episode): Buffer {
  return Buffer.from(JSON.stringify(episode), 'utf-8');
}

/**
 * Deserialize a Buffer back to an Episode.
 */
export function deserializeEpisode(data: Buffer): Episode {
  return JSON.parse(data.toString('utf-8')) as Episode;
}

/**
 * Serialize a numeric embedding to a compact binary Buffer (Float32Array).
 */
export function serializeEmbedding(embedding: number[]): Buffer {
  const float32 = new Float32Array(embedding);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * Deserialize a binary Buffer back to a numeric embedding array.
 */
export function deserializeEmbedding(data: Buffer): number[] {
  const float32 = new Float32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(float32);
}
