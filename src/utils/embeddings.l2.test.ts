import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers before any imports that use it
// ---------------------------------------------------------------------------

const MOCK_DIM = 384;

const mockPipelineInstance = vi.fn().mockResolvedValue({
  data: new Float32Array(MOCK_DIM).fill(0.1),
});

const mockPipelineFactory = vi.fn().mockResolvedValue(mockPipelineInstance);

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipelineFactory,
}));

// ---------------------------------------------------------------------------
// Import after mock is set up
// ---------------------------------------------------------------------------

import {
  SemanticEmbedder,
  getSemanticEmbedder,
  getEmbedding,
  getEmbeddingAsync,
  extractKeywords,
  simHash,
} from './embeddings.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticEmbedder', () => {
  let embedder: SemanticEmbedder;

  beforeEach(() => {
    embedder = new SemanticEmbedder(undefined, 100);
    mockPipelineFactory.mockClear();
    mockPipelineInstance.mockClear();
    // Reset the mock to return fresh data each time
    mockPipelineInstance.mockResolvedValue({
      data: new Float32Array(MOCK_DIM).fill(0.1),
    });
  });

  describe('construction', () => {
    it('creates with default model and cache size', () => {
      const e = new SemanticEmbedder();
      expect(e.isLoaded()).toBe(false);
      expect(e.getCacheStats().size).toBe(0);
    });

    it('creates with custom model and cache size', () => {
      const e = new SemanticEmbedder('custom-model', 50);
      expect(e.isLoaded()).toBe(false);
      expect(e.getCacheStats().maxSize).toBe(50);
    });
  });

  describe('lazy loading', () => {
    it('does not load model until first embed() call', () => {
      new SemanticEmbedder();
      expect(mockPipelineFactory).not.toHaveBeenCalled();
    });

    it('loads model on first embed() call', async () => {
      await embedder.embed('hello world');
      expect(mockPipelineFactory).toHaveBeenCalledTimes(1);
    });
  });

  describe('embed()', () => {
    it('returns a vector of correct dimensionality', async () => {
      const vec = await embedder.embed('test text');
      expect(vec).toHaveLength(MOCK_DIM);
      expect(typeof vec[0]).toBe('number');
    });

    it('returns numeric array (not Float32Array)', async () => {
      const vec = await embedder.embed('test');
      expect(Array.isArray(vec)).toBe(true);
    });
  });

  describe('cache behavior', () => {
    it('cache hit: second call with same text does not invoke pipeline again', async () => {
      await embedder.embed('cached text');
      await embedder.embed('cached text');

      // Pipeline instance (the embedding function) should only be called once
      expect(mockPipelineInstance).toHaveBeenCalledTimes(1);
    });

    it('cache miss: different text triggers new embedding', async () => {
      await embedder.embed('text one');
      await embedder.embed('text two');

      expect(mockPipelineInstance).toHaveBeenCalledTimes(2);
    });
  });

  describe('embedBatch()', () => {
    it('processes multiple texts and caches each', async () => {
      const results = await embedder.embedBatch(['alpha', 'beta', 'gamma']);
      expect(results).toHaveLength(3);
      for (const vec of results) {
        expect(vec).toHaveLength(MOCK_DIM);
      }

      // Should have called the pipeline 3 times (one per unique uncached text)
      expect(mockPipelineInstance).toHaveBeenCalledTimes(3);
    });

    it('uses cache for previously embedded texts', async () => {
      await embedder.embed('alpha');
      mockPipelineInstance.mockClear();

      await embedder.embedBatch(['alpha', 'beta']);
      // Only 'beta' should trigger a pipeline call
      expect(mockPipelineInstance).toHaveBeenCalledTimes(1);
    });

    it('returns results in correct order', async () => {
      // Make each call return a different vector based on call order
      let callCount = 0;
      mockPipelineInstance.mockImplementation(async () => {
        callCount++;
        const data = new Float32Array(MOCK_DIM).fill(callCount * 0.1);
        return { data };
      });

      const results = await embedder.embedBatch(['a', 'b', 'c']);
      // Each should have a distinct fill value
      expect(results[0][0]).toBeCloseTo(0.1, 5);
      expect(results[1][0]).toBeCloseTo(0.2, 5);
      expect(results[2][0]).toBeCloseTo(0.3, 5);
    });
  });

  describe('isLoaded()', () => {
    it('returns false before first embed', () => {
      expect(embedder.isLoaded()).toBe(false);
    });

    it('returns true after first embed', async () => {
      await embedder.embed('load me');
      expect(embedder.isLoaded()).toBe(true);
    });
  });

  describe('getCacheStats()', () => {
    it('reports correct size after embeddings', async () => {
      expect(embedder.getCacheStats().size).toBe(0);

      await embedder.embed('one');
      await embedder.embed('two');
      expect(embedder.getCacheStats().size).toBe(2);
    });

    it('reports correct max size', () => {
      expect(embedder.getCacheStats().maxSize).toBe(100);
    });

    it('reports hit rate correctly', async () => {
      await embedder.embed('text');    // miss
      await embedder.embed('text');    // hit
      await embedder.embed('other');   // miss

      const stats = embedder.getCacheStats();
      // 1 hit out of 3 total cache lookups
      expect(stats.hitRate).toBeCloseTo(1 / 3, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingAsync
// ---------------------------------------------------------------------------

describe('getEmbeddingAsync', () => {
  beforeEach(() => {
    mockPipelineFactory.mockClear();
    mockPipelineInstance.mockClear();
    mockPipelineInstance.mockResolvedValue({
      data: new Float32Array(MOCK_DIM).fill(0.1),
    });
  });

  it('with "fast" level returns L0+L1 only (no embedding)', async () => {
    const result = await getEmbeddingAsync('hello world', 'fast');
    expect(result.keywords).toBeDefined();
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(typeof result.simhash).toBe('bigint');
    expect(result.embedding).toBeUndefined();
  });

  it('with "full" level includes L2 embedding', async () => {
    const result = await getEmbeddingAsync('hello world', 'full');
    expect(result.keywords).toBeDefined();
    expect(typeof result.simhash).toBe('bigint');
    expect(result.embedding).toBeDefined();
    expect(result.embedding).toHaveLength(MOCK_DIM);
  });

  it('with "auto" level includes L2 embedding when available', async () => {
    const result = await getEmbeddingAsync('hello world', 'auto');
    expect(result.keywords).toBeDefined();
    expect(typeof result.simhash).toBe('bigint');
    // Our mock makes L2 available, so embedding should be present
    expect(result.embedding).toBeDefined();
    expect(result.embedding).toHaveLength(MOCK_DIM);
  });
});

// ---------------------------------------------------------------------------
// getEmbedding (synchronous)
// ---------------------------------------------------------------------------

describe('getEmbedding (sync)', () => {
  it('returns L0 keywords and L1 simhash only', () => {
    const result = getEmbedding('machine learning is great');
    expect(result.keywords).toBeDefined();
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(typeof result.simhash).toBe('bigint');
    // Sync version intentionally never includes L2
    expect(result.embedding).toBeUndefined();
  });

  it('returns L0+L1 even when level is "full"', () => {
    const result = getEmbedding('test text', 'full');
    // Sync version cannot do async L2, so embedding is always absent
    expect(result.embedding).toBeUndefined();
    expect(result.keywords).toBeDefined();
  });

  it('returns L0+L1 with "auto" level', () => {
    const result = getEmbedding('some text', 'auto');
    expect(result.embedding).toBeUndefined();
    expect(result.keywords).toBeDefined();
    expect(typeof result.simhash).toBe('bigint');
  });
});

// ---------------------------------------------------------------------------
// getSemanticEmbedder singleton
// ---------------------------------------------------------------------------

describe('getSemanticEmbedder', () => {
  it('returns the same instance on subsequent calls', () => {
    const a = getSemanticEmbedder();
    const b = getSemanticEmbedder();
    expect(a).toBe(b);
  });

  it('returns a SemanticEmbedder instance', () => {
    const embedder = getSemanticEmbedder();
    expect(embedder).toBeInstanceOf(SemanticEmbedder);
  });
});
