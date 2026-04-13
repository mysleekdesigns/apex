/**
 * Tests for Relevance Feedback Tracker (Phase 19)
 *
 * Covers: recall recording, usage recording, boost scores (positive & negative),
 * ring buffer eviction, stats calculation, and getRecentRecallId.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelevanceFeedbackTracker,
  type RecallEvent,
  type UsageEvent,
  type RelevanceFeedbackStats,
} from '../../src/memory/relevance-feedback.js';

describe('RelevanceFeedbackTracker', () => {
  let tracker: RelevanceFeedbackTracker;

  beforeEach(() => {
    tracker = new RelevanceFeedbackTracker();
  });

  // -------------------------------------------------------------------------
  // Recording recall events
  // -------------------------------------------------------------------------

  it('should record recall events and return unique IDs', () => {
    const id1 = tracker.recordRecall('bug fix', [
      { id: 'e1', score: 0.9, tier: 'episodic' },
      { id: 'e2', score: 0.7, tier: 'semantic' },
    ]);
    const id2 = tracker.recordRecall('test setup', [
      { id: 'e3', score: 0.8, tier: 'procedural' },
    ]);

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);

    const stats = tracker.getStats();
    expect(stats.totalRecalls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Recording usage events
  // -------------------------------------------------------------------------

  it('should record usage events linked to recalls', () => {
    const recallId = tracker.recordRecall('query', [
      { id: 'e1', score: 0.9, tier: 'working' },
      { id: 'e2', score: 0.6, tier: 'episodic' },
    ]);

    tracker.recordUsage(recallId, ['e1']);

    const stats = tracker.getStats();
    expect(stats.totalUsageEvents).toBe(1);
    expect(stats.avgUsageRate).toBe(0.5); // 1 used out of 2 returned
  });

  // -------------------------------------------------------------------------
  // Boost scores: frequently used entries
  // -------------------------------------------------------------------------

  it('should give positive boost to frequently used entries', () => {
    // Entry e1 is returned twice and used twice -> usageRate = 1.0
    // boost = (1.0 - 0.5) * 0.6 = 0.3
    const id1 = tracker.recordRecall('q1', [{ id: 'e1', score: 0.9, tier: 'episodic' }]);
    const id2 = tracker.recordRecall('q2', [{ id: 'e1', score: 0.8, tier: 'episodic' }]);
    tracker.recordUsage(id1, ['e1']);
    tracker.recordUsage(id2, ['e1']);

    const boosts = tracker.getBoostScores();
    expect(boosts.get('e1')).toBeCloseTo(0.3);
  });

  // -------------------------------------------------------------------------
  // Boost scores: never-used entries
  // -------------------------------------------------------------------------

  it('should give negative boost to never-used entries', () => {
    // Entry e1 is returned twice but never used -> usageRate = 0.0
    // boost = (0.0 - 0.5) * 0.6 = -0.3, clamped to -0.1
    tracker.recordRecall('q1', [{ id: 'e1', score: 0.5, tier: 'semantic' }]);
    tracker.recordRecall('q2', [{ id: 'e1', score: 0.4, tier: 'semantic' }]);

    const boosts = tracker.getBoostScores();
    expect(boosts.get('e1')).toBeCloseTo(-0.1);
  });

  // -------------------------------------------------------------------------
  // Ring buffer eviction
  // -------------------------------------------------------------------------

  it('should evict oldest events when maxHistory is exceeded', () => {
    const small = new RelevanceFeedbackTracker(3);

    // Record 4 recalls; the first should be evicted
    small.recordRecall('q1', [{ id: 'e1', score: 0.5, tier: 'working' }]);
    small.recordRecall('q2', [{ id: 'e2', score: 0.5, tier: 'working' }]);
    small.recordRecall('q3', [{ id: 'e3', score: 0.5, tier: 'working' }]);
    small.recordRecall('q4', [{ id: 'e4', score: 0.5, tier: 'working' }]);

    const stats = small.getStats();
    expect(stats.totalRecalls).toBe(3);

    // e1 should no longer appear in boost scores (evicted)
    const boosts = small.getBoostScores();
    expect(boosts.has('e1')).toBe(false);
    expect(boosts.has('e2')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Stats calculation
  // -------------------------------------------------------------------------

  it('should compute correct per-tier usage rates and top entries', () => {
    const id1 = tracker.recordRecall('q1', [
      { id: 'e1', score: 0.9, tier: 'episodic' },
      { id: 'e2', score: 0.7, tier: 'semantic' },
      { id: 'e3', score: 0.6, tier: 'episodic' },
    ]);
    tracker.recordUsage(id1, ['e1', 'e3']);

    const stats = tracker.getStats();
    expect(stats.perTierUsageRate.episodic).toBeCloseTo(1.0); // 2/2
    expect(stats.perTierUsageRate.semantic).toBeCloseTo(0.0);  // 0/1
    expect(stats.perTierUsageRate.working).toBe(0);
    expect(stats.perTierUsageRate.procedural).toBe(0);
    expect(stats.topUsedEntryIds).toContain('e1');
    expect(stats.topUsedEntryIds).toContain('e3');
  });

  // -------------------------------------------------------------------------
  // getRecentRecallId
  // -------------------------------------------------------------------------

  it('should return the most recent recall ID or undefined', () => {
    expect(tracker.getRecentRecallId()).toBeUndefined();

    tracker.recordRecall('q1', [{ id: 'e1', score: 0.5, tier: 'working' }]);
    const id2 = tracker.recordRecall('q2', [{ id: 'e2', score: 0.5, tier: 'working' }]);

    expect(tracker.getRecentRecallId()).toBe(id2);
  });
});
