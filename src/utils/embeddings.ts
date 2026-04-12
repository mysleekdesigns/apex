/**
 * Tiered embedding system for APEX.
 *
 * L0: Keyword extraction + TF-IDF
 * L1: Character n-gram SimHash (64-bit)
 * L2: Semantic embeddings via @huggingface/transformers (lazy loaded)
 */

// ── L0: Keyword Extraction + TF-IDF ────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'was', 'are', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'not', 'no', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'its',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'if', 'then', 'else', 'so', 'than', 'too', 'very', 'just',
  'about', 'up', 'out', 'into', 'over', 'after', 'before',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Extract keywords from text by frequency, filtering stop words.
 */
export function extractKeywords(text: string): string[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

/**
 * Compute TF-IDF vector for a text, optionally against a corpus.
 * If no corpus is provided, returns raw term frequency normalized by doc length.
 */
export function tfidfVector(
  text: string,
  corpus?: string[],
): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  const docLen = tokens.length || 1;
  const result = new Map<string, number>();

  if (!corpus || corpus.length === 0) {
    // No corpus: return normalized TF
    for (const [term, count] of tf) {
      result.set(term, count / docLen);
    }
    return result;
  }

  // Compute IDF from corpus
  const numDocs = corpus.length + 1; // +1 for the query doc itself
  const docFreq = new Map<string, number>();
  for (const doc of corpus) {
    const docTokens = new Set(tokenize(doc));
    for (const term of tf.keys()) {
      if (docTokens.has(term)) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
  }

  for (const [term, count] of tf) {
    const df = (docFreq.get(term) ?? 0) + 1; // +1 for the query doc
    const idf = Math.log(numDocs / df);
    result.set(term, (count / docLen) * idf);
  }

  return result;
}

// ── L1: Character N-gram SimHash ────────────────────────────────────

function charTrigrams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const grams: string[] = [];
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.push(normalized.slice(i, i + 3));
  }
  return grams;
}

/**
 * Simple 64-bit hash for a string, used internally by simHash.
 * Uses FNV-1a adapted to BigInt for 64-bit output.
 */
function hash64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h;
}

/**
 * Compute a 64-bit SimHash fingerprint from character trigrams.
 */
export function simHash(text: string): bigint {
  const grams = charTrigrams(text);
  if (grams.length === 0) return 0n;

  // Accumulate weighted bit vectors
  const bits = new Float64Array(64);
  for (const gram of grams) {
    const h = hash64(gram);
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) {
        bits[i] += 1;
      } else {
        bits[i] -= 1;
      }
    }
  }

  // Convert accumulated values to a fingerprint
  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (bits[i] > 0) {
      fingerprint |= 1n << BigInt(i);
    }
  }
  return fingerprint;
}

/**
 * Compute similarity between two SimHash fingerprints.
 * Returns a value from 0 (completely different) to 1 (identical).
 * Based on normalized Hamming distance.
 */
export function simHashSimilarity(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let diffBits = 0;
  while (xor > 0n) {
    diffBits += Number(xor & 1n);
    xor >>= 1n;
  }
  return 1 - diffBits / 64;
}

// ── LRU Cache ──────────────────────────────────────────────────────

/**
 * Simple Map-based LRU cache with hit/miss tracking.
 */
class LRUCache<K, V> {
  private map = new Map<K, V>();
  readonly maxSize: number;
  private _hits = 0;
  private _misses = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }

  get hitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }
}

// ── L2: Semantic Embeddings ────────────────────────────────────────

/**
 * Simple hash for cache keys — FNV-1a 32-bit.
 */
function hashCacheKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Semantic embedder using @huggingface/transformers.
 *
 * Lazy-loads the model on first `embed()` call. Uses an LRU cache to
 * avoid recomputing embeddings for repeated text. Gracefully degrades
 * if the transformers package is not installed.
 */
export class SemanticEmbedder {
  private pipeline: any | null = null;
  private modelId: string;
  private loading: Promise<void> | null = null;
  private cache: LRUCache<string, number[]>;
  private available: boolean | null = null; // null = not yet checked

  constructor(modelId?: string, cacheSize?: number) {
    this.modelId = modelId ?? 'sentence-transformers/all-MiniLM-L6-v2';
    this.cache = new LRUCache<string, number[]>(cacheSize ?? 1000);
  }

  /**
   * Lazy-load the feature-extraction pipeline.
   * Uses a loading promise to prevent concurrent model loads.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (this.available === false) {
      throw new Error(
        'L2 semantic embeddings unavailable: @huggingface/transformers is not installed. ' +
        'Run `npm install @huggingface/transformers` to enable.',
      );
    }

    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        const pipelineFn = transformers.pipeline ?? (transformers as any).default?.pipeline;
        if (!pipelineFn) {
          throw new Error('Could not find pipeline function in @huggingface/transformers');
        }
        this.pipeline = await pipelineFn('feature-extraction', this.modelId, {
          dtype: 'fp32',
        });
        this.available = true;
      } catch (err: any) {
        this.available = false;
        this.loading = null;
        if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('Cannot find')) {
          console.warn(
            '[APEX] @huggingface/transformers not installed — L2 semantic embeddings disabled. ' +
            'Install with: npm install @huggingface/transformers',
          );
          throw new Error(
            'L2 semantic embeddings unavailable: @huggingface/transformers is not installed.',
          );
        }
        throw err;
      }
    })();

    await this.loading;
  }

  /**
   * Embed a single text string, returning a dense vector.
   * Results are cached by content hash.
   */
  async embed(text: string): Promise<number[]> {
    const cacheKey = hashCacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    await this.ensureLoaded();

    const output = await this.pipeline!(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array) as number[];
    this.cache.set(cacheKey, embedding);
    return embedding;
  }

  /**
   * Embed multiple texts in batch for efficiency.
   * Each result is individually cached.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = hashCacheKey(texts[i]);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length === 0) return results;

    await this.ensureLoaded();

    // Process uncached texts one at a time (pipeline handles batching internally)
    for (let j = 0; j < uncachedTexts.length; j++) {
      const output = await this.pipeline!(uncachedTexts[j], { pooling: 'mean', normalize: true });
      const embedding = Array.from(output.data as Float32Array) as number[];
      const cacheKey = hashCacheKey(uncachedTexts[j]);
      this.cache.set(cacheKey, embedding);
      results[uncachedIndices[j]] = embedding;
    }

    return results;
  }

  /**
   * Check if the model has been loaded.
   */
  isLoaded(): boolean {
    return this.pipeline !== null;
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.cache.maxSize,
      hitRate: this.cache.hitRate,
    };
  }
}

// ── Singleton Embedder ─────────────────────────────────────────────

let _embedder: SemanticEmbedder | null = null;

/**
 * Get (or create) the singleton SemanticEmbedder instance.
 */
export function getSemanticEmbedder(modelId?: string): SemanticEmbedder {
  if (!_embedder) {
    _embedder = new SemanticEmbedder(modelId);
  }
  return _embedder;
}

// ── Unified Embedding Interface ─────────────────────────────────────

export interface EmbeddingResult {
  keywords: string[];
  simhash: bigint;
  embedding?: number[];
}

/**
 * Get a multi-level embedding for text (synchronous, L0+L1 only).
 *
 * This is the backward-compatible synchronous interface. It computes
 * L0 keywords and L1 SimHash but never includes L2 semantic embeddings.
 * Use `getEmbeddingAsync()` for L2 support.
 *
 * @param text - Input text to embed
 * @param level - 'fast' for L0+L1 only, 'full' includes L2 if available, 'auto' defaults to 'fast'
 */
export function getEmbedding(
  text: string,
  level: 'auto' | 'fast' | 'full' = 'auto',
): EmbeddingResult {
  const keywords = extractKeywords(text);
  const hash = simHash(text);

  const result: EmbeddingResult = { keywords, simhash: hash };

  if (level === 'full') {
    // L2 requires async — use getEmbeddingAsync() for semantic embeddings.
    // This sync version intentionally omits L2.
  }

  return result;
}

/**
 * Get a multi-level embedding for text (async, supports L2 semantic embeddings).
 *
 * @param text - Input text to embed
 * @param level - 'fast' for L0+L1 only, 'full' always includes L2,
 *                'auto' attempts L2 and falls back to L0+L1 if unavailable
 */
export async function getEmbeddingAsync(
  text: string,
  level: 'auto' | 'fast' | 'full' = 'auto',
): Promise<EmbeddingResult> {
  const keywords = extractKeywords(text);
  const hash = simHash(text);
  const result: EmbeddingResult = { keywords, simhash: hash };

  if (level === 'fast') {
    return result;
  }

  const embedder = getSemanticEmbedder();

  if (level === 'full') {
    // Explicit L2 request — let errors propagate
    result.embedding = await embedder.embed(text);
    return result;
  }

  // level === 'auto': attempt L2, fall back gracefully
  try {
    result.embedding = await embedder.embed(text);
  } catch {
    // L2 not available — return L0+L1 only
  }

  return result;
}
