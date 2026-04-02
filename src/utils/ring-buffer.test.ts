import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  describe('constructor', () => {
    it('throws if capacity < 1', () => {
      expect(() => new RingBuffer(0)).toThrow('capacity must be at least 1');
      expect(() => new RingBuffer(-5)).toThrow('capacity must be at least 1');
    });

    it('creates an empty buffer', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.length).toBe(0);
      expect(buf.isFull).toBe(false);
    });
  });

  describe('push', () => {
    it('adds items and increments length', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.length).toBe(2);
    });

    it('returns undefined when not full', () => {
      const buf = new RingBuffer<number>(3);
      expect(buf.push(1)).toBeUndefined();
      expect(buf.push(2)).toBeUndefined();
      expect(buf.push(3)).toBeUndefined();
    });

    it('returns evicted item when full (FIFO)', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.isFull).toBe(true);

      // Pushing a 4th item evicts the oldest (10)
      const evicted = buf.push(40);
      expect(evicted).toBe(10);
      expect(buf.length).toBe(3);
    });

    it('evicts in FIFO order on repeated pushes beyond capacity', () => {
      const buf = new RingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      expect(buf.push(3)).toBe(1);
      expect(buf.push(4)).toBe(2);
      expect(buf.push(5)).toBe(3);
    });
  });

  describe('get', () => {
    it('retrieves items by logical index (0=oldest)', () => {
      const buf = new RingBuffer<string>(5);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      expect(buf.get(0)).toBe('a');
      expect(buf.get(1)).toBe('b');
      expect(buf.get(2)).toBe('c');
    });

    it('retrieves correctly after wraparound', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1
      expect(buf.get(0)).toBe(2);
      expect(buf.get(1)).toBe(3);
      expect(buf.get(2)).toBe(4);
    });

    it('throws RangeError for out-of-bounds index', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      expect(() => buf.get(-1)).toThrow(RangeError);
      expect(() => buf.get(1)).toThrow(RangeError);
      expect(() => buf.get(100)).toThrow(RangeError);
    });

    it('throws on empty buffer', () => {
      const buf = new RingBuffer<number>(3);
      expect(() => buf.get(0)).toThrow(RangeError);
    });
  });

  describe('toArray', () => {
    it('returns empty array for empty buffer', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.toArray()).toEqual([]);
    });

    it('returns items oldest-first', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    it('returns correct order after wraparound', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect(buf.toArray()).toEqual([3, 4, 5]);
    });
  });

  describe('isFull', () => {
    it('is false when under capacity', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.isFull).toBe(false);
    });

    it('is true at capacity', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.isFull).toBe(true);
    });
  });

  describe('clear', () => {
    it('resets buffer to empty', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.clear();
      expect(buf.length).toBe(0);
      expect(buf.isFull).toBe(false);
      expect(buf.toArray()).toEqual([]);
    });
  });

  describe('capacity = 1', () => {
    it('works with single-item capacity', () => {
      const buf = new RingBuffer<string>(1);
      expect(buf.push('a')).toBeUndefined();
      expect(buf.isFull).toBe(true);
      expect(buf.get(0)).toBe('a');

      expect(buf.push('b')).toBe('a');
      expect(buf.get(0)).toBe('b');
      expect(buf.length).toBe(1);
    });
  });
});
