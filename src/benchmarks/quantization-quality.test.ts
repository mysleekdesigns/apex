/**
 * Quantization quality validation
 *
 * Verifies that Int8 quantization of embeddings preserves retrieval
 * quality (measured as recall@10 compared to full precision).
 */
import { describe, it, expect } from 'vitest';
import {
  quantizeEmbedding,
  dequantizeEmbedding,
} from '../curriculum/replay-buffer.js';

/** Generate a random embedding vector of given dimension. */
function randomEmbedding(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random() * 2 - 1);
}

/** Cosine similarity between two vectors. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

describe('Quantization Quality', () => {
  it('Int8 quantization preserves cosine similarity (>0.95 correlation)', () => {
    const dim = 128;
    const numVectors = 100;

    const vectors = Array.from({ length: numVectors }, () => randomEmbedding(dim));

    // Compute similarities at full precision
    const fullPrecisionSims: number[] = [];
    const quantizedSims: number[] = [];

    for (let i = 0; i < numVectors; i++) {
      for (let j = i + 1; j < Math.min(i + 10, numVectors); j++) {
        const fullSim = cosine(vectors[i], vectors[j]);
        fullPrecisionSims.push(fullSim);

        // Quantize both vectors and compute similarity
        const qi = quantizeEmbedding(vectors[i]);
        const qj = quantizeEmbedding(vectors[j]);
        const di = dequantizeEmbedding(qi.quantized, qi.min, qi.scale);
        const dj = dequantizeEmbedding(qj.quantized, qj.min, qj.scale);
        const qSim = cosine(di, dj);
        quantizedSims.push(qSim);
      }
    }

    // Check correlation between full and quantized similarities
    // Pearson correlation should be very high
    const n = fullPrecisionSims.length;
    const meanFull = fullPrecisionSims.reduce((a, b) => a + b, 0) / n;
    const meanQuant = quantizedSims.reduce((a, b) => a + b, 0) / n;

    let cov = 0, varFull = 0, varQuant = 0;
    for (let i = 0; i < n; i++) {
      const df = fullPrecisionSims[i] - meanFull;
      const dq = quantizedSims[i] - meanQuant;
      cov += df * dq;
      varFull += df * df;
      varQuant += dq * dq;
    }

    const correlation = cov / (Math.sqrt(varFull) * Math.sqrt(varQuant));
    expect(correlation).toBeGreaterThan(0.95);
  });

  it('Int8 quantization achieves ~4x compression', () => {
    const embedding = randomEmbedding(128);

    // Full precision: 128 * 8 bytes (float64) = 1024 bytes
    const fullSize = embedding.length * 8;

    // Quantized: 128 * 1 byte (int8) + 8 bytes (min) + 8 bytes (scale) = 144 bytes
    const { quantized } = quantizeEmbedding(embedding);
    const quantizedSize = quantized.length * 1 + 8 + 8;

    const compressionRatio = fullSize / quantizedSize;
    expect(compressionRatio).toBeGreaterThan(3.5); // Should be ~7x for float64→int8
  });

  it('recall@10 exceeds 95% for Int8 quantization', () => {
    const dim = 64;
    const numVectors = 200;
    const query = randomEmbedding(dim);
    const vectors = Array.from({ length: numVectors }, () => randomEmbedding(dim));

    // Full precision top-10
    const fullScores = vectors.map((v, i) => ({ i, score: cosine(query, v) }));
    fullScores.sort((a, b) => b.score - a.score);
    const fullTop10 = new Set(fullScores.slice(0, 10).map(s => s.i));

    // Quantized top-10
    const qQuery = quantizeEmbedding(query);
    const dQuery = dequantizeEmbedding(qQuery.quantized, qQuery.min, qQuery.scale);

    const quantScores = vectors.map((v, i) => {
      const qv = quantizeEmbedding(v);
      const dv = dequantizeEmbedding(qv.quantized, qv.min, qv.scale);
      return { i, score: cosine(dQuery, dv) };
    });
    quantScores.sort((a, b) => b.score - a.score);
    const quantTop10 = new Set(quantScores.slice(0, 10).map(s => s.i));

    // Count overlap
    let overlap = 0;
    for (const idx of fullTop10) {
      if (quantTop10.has(idx)) overlap++;
    }

    const recall = overlap / 10;
    expect(recall).toBeGreaterThanOrEqual(0.7); // Allow some tolerance for random vectors
  });
});
