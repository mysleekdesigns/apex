/**
 * Tiered embedding system for APEX.
 *
 * L0: Keyword extraction + TF-IDF
 * L1: Character n-gram SimHash (64-bit)
 * L2: Placeholder for transformers.js (lazy loaded)
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

// ── L2: Semantic Embedding Placeholder ──────────────────────────────

/**
 * Placeholder for transformers.js-based semantic embeddings.
 * Will be lazy-loaded when available.
 */
export class SemanticEmbedder {
  async embed(_text: string): Promise<number[]> {
    throw new Error('L2 not configured: transformers.js semantic embeddings not yet available');
  }
}

// ── Unified Embedding Interface ─────────────────────────────────────

export interface EmbeddingResult {
  keywords: string[];
  simhash: bigint;
  embedding?: number[];
}

/**
 * Get a multi-level embedding for text.
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
    // L2 would be populated here when transformers.js is configured.
    // For now, we skip it silently — callers check for embedding?.
  }

  return result;
}
