import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReplayBuffer,
  quantizeEmbedding,
  dequantizeEmbedding,
} from './replay-buffer.js';
import type { Episode } from '../types.js';

function makeEpisode(id: string, reward: number, success = true): Episode {
  return {
    id,
    task: `task-${id}`,
    actions: [{ type: 'test', description: 'did something', timestamp: Date.now(), success }],
    outcome: { success, description: success ? 'ok' : 'fail', duration: 1000 },
    reward,
    timestamp: Date.now(),
  };
}

describe('ReplayBuffer', () => {
  let buffer: ReplayBuffer;

  beforeEach(() => {
    buffer = new ReplayBuffer({ capacity: 5 });
  });

  describe('add', () => {
    it('adds episode and increases length', () => {
      buffer.add(makeEpisode('e1', 0.8));
      expect(buffer.length).toBe(1);
    });

    it('returns undefined when not full', () => {
      const evicted = buffer.add(makeEpisode('e1', 0.8));
      expect(evicted).toBeUndefined();
    });

    it('evicts oldest when full', () => {
      for (let i = 0; i < 5; i++) {
        buffer.add(makeEpisode(`e${i}`, 0.5));
      }
      expect(buffer.length).toBe(5);

      const evicted = buffer.add(makeEpisode('e5', 0.9));
      expect(evicted).toBeDefined();
      expect(evicted!.id).toBe('e0');
      expect(buffer.length).toBe(5);
    });

    it('uses tdError for priority when provided', () => {
      buffer.add(makeEpisode('e1', 0.5), 2.5);
      const stats = buffer.getStats();
      expect(stats.maxPriority).toBeGreaterThan(2.0);
    });
  });

  describe('sample', () => {
    it('returns empty array from empty buffer', () => {
      expect(buffer.sample(5)).toEqual([]);
    });

    it('returns at most batchSize samples', () => {
      for (let i = 0; i < 5; i++) {
        buffer.add(makeEpisode(`e${i}`, 0.5));
      }
      const samples = buffer.sample(3);
      expect(samples.length).toBeLessThanOrEqual(3);
    });

    it('samples include importance-sampling weights', () => {
      for (let i = 0; i < 5; i++) {
        buffer.add(makeEpisode(`e${i}`, 0.5));
      }
      const samples = buffer.sample(3);
      for (const s of samples) {
        expect(s.weight).toBeGreaterThan(0);
        expect(s.weight).toBeLessThanOrEqual(1.0); // normalized
      }
    });

    it('anneals beta toward 1.0', () => {
      for (let i = 0; i < 5; i++) {
        buffer.add(makeEpisode(`e${i}`, 0.5));
      }
      const betaBefore = buffer.getStats().beta;
      buffer.sample(2);
      const betaAfter = buffer.getStats().beta;
      expect(betaAfter).toBeGreaterThan(betaBefore);
    });

    it('caps sample size to buffer length', () => {
      buffer.add(makeEpisode('e1', 0.5));
      buffer.add(makeEpisode('e2', 0.5));
      const samples = buffer.sample(10);
      expect(samples.length).toBeLessThanOrEqual(2);
    });
  });

  describe('updatePriorities', () => {
    it('updates priorities of matching episodes', () => {
      buffer.add(makeEpisode('e1', 0.5), 1.0);
      buffer.add(makeEpisode('e2', 0.5), 1.0);

      buffer.updatePriorities([{ id: 'e1', priority: 5.0 }]);

      const stats = buffer.getStats();
      expect(stats.maxPriority).toBeGreaterThan(4.0);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      const stats = buffer.getStats();
      expect(stats.length).toBe(0);
      expect(stats.capacity).toBe(5);
      expect(stats.isFull).toBe(false);
      expect(stats.totalAdded).toBe(0);
      expect(stats.totalSampled).toBe(0);
    });

    it('tracks totalAdded and totalSampled', () => {
      buffer.add(makeEpisode('e1', 0.5));
      buffer.add(makeEpisode('e2', 0.5));
      buffer.sample(1);

      const stats = buffer.getStats();
      expect(stats.totalAdded).toBe(2);
      expect(stats.totalSampled).toBe(1);
    });
  });

  describe('clear', () => {
    it('resets buffer to empty', () => {
      buffer.add(makeEpisode('e1', 0.5));
      buffer.clear();
      expect(buffer.length).toBe(0);
      expect(buffer.getStats().totalAdded).toBe(0);
    });
  });
});

describe('quantizeEmbedding / dequantizeEmbedding', () => {
  it('handles empty embedding', () => {
    const { quantized, min, scale } = quantizeEmbedding([]);
    expect(quantized).toEqual([]);
    expect(dequantizeEmbedding(quantized, min, scale)).toEqual([]);
  });

  it('roundtrips with acceptable error', () => {
    const original = [0.1, 0.5, -0.3, 0.9, -0.8, 0.0];
    const { quantized, min, scale } = quantizeEmbedding(original);
    const reconstructed = dequantizeEmbedding(quantized, min, scale);

    expect(reconstructed.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      // Int8 quantization: error should be within ~1% of the range
      expect(reconstructed[i]).toBeCloseTo(original[i], 1);
    }
  });

  it('handles uniform values', () => {
    const { quantized } = quantizeEmbedding([0.5, 0.5, 0.5]);
    // All same value, quantization should still work
    expect(quantized).toHaveLength(3);
  });
});
