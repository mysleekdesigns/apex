/**
 * Memory-efficient embedding storage with quantization and batch operations.
 *
 * Supports three representation levels:
 * - Full float (Float32Array) for accurate similarity
 * - Int8 scalar quantization (4x compression, ~99% accuracy)
 * - Binary quantization (32x compression, for fast pre-filtering)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { cosineSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

/** Int8 quantized representation with reconstruction parameters. */
export interface QuantizedInt8 {
  data: Int8Array;
  min: number;
  scale: number;
}

/** Search result entry. */
export interface SearchResult {
  id: string;
  score: number;
}

/** Store statistics. */
export interface EmbeddingStoreStats {
  entryCount: number;
  dimension: number;
  estimatedMemoryBytes: number;
  quantization: {
    binaryAvailable: boolean;
    int8Available: boolean;
  };
}

/** Pre-filtering threshold — use binary quantization above this count. */
const PREFILTER_THRESHOLD = 1000;

/**
 * Memory-efficient embedding storage with quantization and batch search.
 *
 * Stores dense float vectors keyed by string ID. Provides binary and int8
 * quantization for compression, and batch cosine similarity search with
 * optional binary pre-filtering for large stores.
 */
export class EmbeddingStore {
  private readonly embeddings: Map<string, Float32Array> = new Map();
  private readonly logger: Logger;
  private dimension = 0;

  constructor(options: { logger?: Logger } = {}) {
    this.logger = options.logger ?? new Logger({ prefix: 'embedding-store' });
  }

  // ---------------------------------------------------------------------------
  // Core CRUD
  // ---------------------------------------------------------------------------

  /**
   * Store an embedding vector for the given ID.
   * Sets the store dimension on first insertion; subsequent vectors must match.
   */
  set(id: string, embedding: number[]): void {
    if (embedding.length === 0) {
      this.logger.warn('Attempted to store zero-length embedding', { id });
      return;
    }

    if (this.dimension === 0) {
      this.dimension = embedding.length;
    } else if (embedding.length !== this.dimension) {
      throw new Error(
        `Dimension mismatch: expected ${this.dimension}, got ${embedding.length}`,
      );
    }

    this.embeddings.set(id, new Float32Array(embedding));
    this.logger.debug('Stored embedding', { id, dimension: this.dimension });
  }

  /** Retrieve an embedding by ID, or null if not found. */
  get(id: string): number[] | null {
    const vec = this.embeddings.get(id);
    if (!vec) return null;
    return Array.from(vec);
  }

  /** Delete an embedding by ID. */
  delete(id: string): void {
    this.embeddings.delete(id);
    if (this.embeddings.size === 0) {
      this.dimension = 0;
    }
  }

  /** Check whether an embedding exists for the given ID. */
  has(id: string): boolean {
    return this.embeddings.has(id);
  }

  // ---------------------------------------------------------------------------
  // Binary quantization (1-bit, 32x compression)
  // ---------------------------------------------------------------------------

  /**
   * Convert a float vector to a binary quantized Uint8Array.
   *
   * Each bit represents the sign of the corresponding float value:
   * 1 if >= 0, 0 if < 0. Packs 8 dimensions per byte.
   */
  quantizeBinary(embedding: number[]): Uint8Array {
    const byteLength = Math.ceil(embedding.length / 8);
    const result = new Uint8Array(byteLength);

    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] >= 0) {
        result[i >>> 3] |= 1 << (7 - (i & 7));
      }
    }

    return result;
  }

  /**
   * Compute Hamming distance between two binary-quantized vectors.
   *
   * Returns the number of differing bits.
   */
  binaryHammingDistance(a: Uint8Array, b: Uint8Array): number {
    const len = Math.min(a.length, b.length);
    let distance = 0;

    for (let i = 0; i < len; i++) {
      let xor = a[i] ^ b[i];
      // Popcount via Brian Kernighan's algorithm
      while (xor) {
        xor &= xor - 1;
        distance++;
      }
    }

    return distance;
  }

  // ---------------------------------------------------------------------------
  // Int8 scalar quantization (4x compression)
  // ---------------------------------------------------------------------------

  /**
   * Quantize a float vector to Int8 using min/max normalization.
   *
   * Maps the float range [min, max] to [-128, 127].
   */
  quantizeInt8(embedding: number[]): QuantizedInt8 {
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < embedding.length; i++) {
      if (embedding[i] < min) min = embedding[i];
      if (embedding[i] > max) max = embedding[i];
    }

    const range = max - min;
    const scale = range === 0 ? 1 : range / 255;
    const data = new Int8Array(embedding.length);

    for (let i = 0; i < embedding.length; i++) {
      // Map to [0, 255] then shift to [-128, 127]
      data[i] = Math.round((embedding[i] - min) / scale) - 128;
    }

    return { data, min, scale };
  }

  /**
   * Reconstruct a float vector from Int8 quantized representation.
   */
  dequantizeInt8(quantized: QuantizedInt8): number[] {
    const { data, min, scale } = quantized;
    const result = new Array<number>(data.length);

    for (let i = 0; i < data.length; i++) {
      result[i] = (data[i] + 128) * scale + min;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Batch similarity search
  // ---------------------------------------------------------------------------

  /**
   * Find the top-K most similar embeddings to the query vector.
   *
   * For stores with more than 1000 entries, uses binary quantization
   * for fast pre-filtering before re-ranking with full cosine similarity.
   */
  search(query: number[], topK: number): SearchResult[] {
    if (this.embeddings.size === 0 || this.dimension === 0) {
      return [];
    }

    if (query.length !== this.dimension) {
      throw new Error(
        `Query dimension mismatch: expected ${this.dimension}, got ${query.length}`,
      );
    }

    const usePrefilter = this.embeddings.size > PREFILTER_THRESHOLD;

    if (usePrefilter) {
      return this.searchWithPrefilter(query, topK);
    }

    return this.searchBruteForce(query, topK);
  }

  /** Brute-force cosine similarity against all entries. */
  private searchBruteForce(query: number[], topK: number): SearchResult[] {
    const results: SearchResult[] = [];

    for (const [id, vec] of this.embeddings) {
      const score = cosineSimilarity(query, Array.from(vec));
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Two-phase search: binary pre-filter then full cosine re-rank.
   *
   * Phase 1: Compute Hamming distance with binary quantized vectors
   *          to select top 4*topK candidates.
   * Phase 2: Re-rank candidates using full float cosine similarity.
   */
  private searchWithPrefilter(query: number[], topK: number): SearchResult[] {
    const queryBinary = this.quantizeBinary(query);
    const candidateCount = Math.min(topK * 4, this.embeddings.size);

    // Phase 1: binary pre-filter
    const candidates: Array<{ id: string; distance: number }> = [];

    for (const [id, vec] of this.embeddings) {
      const vecBinary = this.quantizeBinary(Array.from(vec));
      const distance = this.binaryHammingDistance(queryBinary, vecBinary);
      candidates.push({ id, distance });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    const shortlist = candidates.slice(0, candidateCount);

    // Phase 2: full cosine re-rank
    const results: SearchResult[] = [];

    for (const { id } of shortlist) {
      const vec = this.embeddings.get(id)!;
      const score = cosineSimilarity(query, Array.from(vec));
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ---------------------------------------------------------------------------
  // File-backed persistence
  // ---------------------------------------------------------------------------

  /**
   * Serialize all embeddings to a binary file.
   *
   * Format:
   * - Header: entry count (uint32 LE) + dimension (uint32 LE) = 8 bytes
   * - Per entry: id length (uint16 LE) + id bytes (UTF-8) + float32 array (LE)
   */
  async save(filePath: string): Promise<void> {
    const entryCount = this.embeddings.size;
    const floatBytesPerEntry = this.dimension * 4;

    // Calculate total buffer size
    let totalSize = 8; // header
    for (const [id] of this.embeddings) {
      totalSize += 2 + Buffer.byteLength(id, 'utf-8') + floatBytesPerEntry;
    }

    const buffer = Buffer.alloc(totalSize);
    let offset = 0;

    // Header
    buffer.writeUInt32LE(entryCount, offset);
    offset += 4;
    buffer.writeUInt32LE(this.dimension, offset);
    offset += 4;

    // Entries
    for (const [id, vec] of this.embeddings) {
      const idBytes = Buffer.from(id, 'utf-8');

      buffer.writeUInt16LE(idBytes.length, offset);
      offset += 2;

      idBytes.copy(buffer, offset);
      offset += idBytes.length;

      for (let i = 0; i < vec.length; i++) {
        buffer.writeFloatLE(vec[i], offset);
        offset += 4;
      }
    }

    await writeFile(filePath, buffer);
    this.logger.info('Saved embedding store', { filePath, entryCount });
  }

  /**
   * Deserialize embeddings from a binary file.
   *
   * Clears existing store contents before loading.
   */
  async load(filePath: string): Promise<void> {
    const data = await readFile(filePath);
    const buffer = Buffer.from(data);

    if (buffer.length < 8) {
      throw new Error('Invalid embedding file: too short for header');
    }

    let offset = 0;

    // Header
    const entryCount = buffer.readUInt32LE(offset);
    offset += 4;
    const dimension = buffer.readUInt32LE(offset);
    offset += 4;

    // Clear existing data
    this.embeddings.clear();
    this.dimension = dimension;

    // Entries
    for (let i = 0; i < entryCount; i++) {
      if (offset + 2 > buffer.length) {
        throw new Error(`Invalid embedding file: truncated at entry ${i}`);
      }

      const idLength = buffer.readUInt16LE(offset);
      offset += 2;

      if (offset + idLength > buffer.length) {
        throw new Error(`Invalid embedding file: truncated id at entry ${i}`);
      }

      const id = buffer.toString('utf-8', offset, offset + idLength);
      offset += idLength;

      const floatBytes = dimension * 4;
      if (offset + floatBytes > buffer.length) {
        throw new Error(`Invalid embedding file: truncated vector at entry ${i}`);
      }

      const vec = new Float32Array(dimension);
      for (let j = 0; j < dimension; j++) {
        vec[j] = buffer.readFloatLE(offset);
        offset += 4;
      }

      this.embeddings.set(id, vec);
    }

    this.logger.info('Loaded embedding store', {
      filePath,
      entryCount,
      dimension,
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /** Return store statistics including memory usage estimates. */
  stats(): EmbeddingStoreStats {
    const entryCount = this.embeddings.size;
    // Float32Array: 4 bytes per element
    const vectorBytes = entryCount * this.dimension * 4;
    // Rough estimate for Map overhead + string keys
    let keyBytes = 0;
    for (const [id] of this.embeddings) {
      keyBytes += id.length * 2; // JS strings are ~2 bytes per char
    }
    const mapOverhead = entryCount * 64; // rough per-entry Map overhead

    return {
      entryCount,
      dimension: this.dimension,
      estimatedMemoryBytes: vectorBytes + keyBytes + mapOverhead,
      quantization: {
        binaryAvailable: entryCount > 0,
        int8Available: entryCount > 0,
      },
    };
  }
}
