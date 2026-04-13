/**
 * Tests for Query Classifier (Phase 19)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClassifier, type QueryCategory } from '../../src/memory/query-classifier.js';

describe('QueryClassifier', () => {
  let classifier: QueryClassifier;

  beforeEach(() => {
    classifier = new QueryClassifier();
  });

  it('classifies error-lookup queries', () => {
    const result = classifier.classify('TypeError: Cannot read property of undefined');
    expect(result.category).toBe('error-lookup');
    expect(result.signals).toContain('error-type');
    expect(result.suggestedWeights.bm25).toBe(0.6);
    expect(result.suggestedTiers).toEqual(['episodic', 'semantic']);
  });

  it('classifies pattern-search queries', () => {
    const result = classifier.classify('how to implement a retry pattern in TypeScript');
    expect(result.category).toBe('pattern-search');
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.suggestedTiers).toEqual(['semantic', 'procedural']);
  });

  it('classifies skill-search queries', () => {
    const result = classifier.classify('step-by-step procedure for setting up CI workflow');
    expect(result.category).toBe('skill-search');
    expect(result.suggestedWeights.vector).toBe(0.4);
    expect(result.suggestedWeights.bm25).toBe(0.4);
  });

  it('classifies planning queries', () => {
    const result = classifier.classify('what should I prioritize for the next sprint?');
    expect(result.category).toBe('planning');
    expect(result.suggestedWeights.vector).toBe(0.6);
    expect(result.suggestedTiers).toContain('episodic');
  });

  it('falls back to exploratory for vague queries', () => {
    const result = classifier.classify('something about the database');
    expect(result.category).toBe('exploratory');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.signals).toContain('no-pattern-match');
    expect(result.suggestedTiers).toHaveLength(4);
  });

  it('has higher confidence for clear queries than ambiguous ones', () => {
    const clear = classifier.classify('TypeError at src/index.ts:42 stack trace crash');
    const ambiguous = classifier.classify('approach for handling errors');
    expect(clear.confidence).toBeGreaterThan(ambiguous.confidence);
  });

  it('uses context parameter to influence classification', () => {
    // Without context: vague/exploratory
    const without = classifier.classify('the database module');
    expect(without.category).toBe('exploratory');

    // With error context: should shift toward error-lookup
    const withCtx = classifier.classify('the database module', 'error: connection failed crash');
    expect(withCtx.category).toBe('error-lookup');
  });

  describe('accuracy tracking', () => {
    it('tracks outcomes and computes stats', () => {
      classifier.recordOutcome('q1', 'error-lookup', 'error-lookup');
      classifier.recordOutcome('q2', 'error-lookup', 'pattern-search');
      classifier.recordOutcome('q3', 'planning', 'planning');

      const stats = classifier.getAccuracyStats();
      expect(stats.total).toBeCloseTo(2 / 3);
      expect(stats.perCategory['error-lookup']).toBe(1); // 1 actual error-lookup, 1 correct
      expect(stats.perCategory['pattern-search']).toBe(0); // 1 actual pattern-search, 0 correct
      expect(stats.perCategory['planning']).toBe(1); // 1 actual planning, 1 correct
    });

    it('returns zeros when no outcomes recorded', () => {
      const stats = classifier.getAccuracyStats();
      expect(stats.total).toBe(0);
      for (const val of Object.values(stats.perCategory)) {
        expect(val).toBe(0);
      }
    });
  });
});
