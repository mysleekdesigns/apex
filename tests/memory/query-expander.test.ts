/**
 * Tests for QueryExpander (Phase 19)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/utils/embeddings.js', () => ({
  extractKeywords: vi.fn((text: string) =>
    text.toLowerCase().split(/\s+/).filter(Boolean),
  ),
}));

import { QueryExpander, type QueryExpansion } from '../../src/memory/query-expander.js';

describe('QueryExpander', () => {
  let expander: QueryExpander;

  beforeEach(() => {
    expander = new QueryExpander();
  });

  it('expands "auth bug" to include authentication and login terms', () => {
    const result = expander.expand('auth bug');
    expect(result.originalQuery).toBe('auth bug');
    expect(result.expandedTerms).toContain('authentication');
    expect(result.expandedTerms).toContain('login');
    expect(result.expandedQuery).toContain('auth bug');
    expect(result.expandedQuery).toContain('authentication');
    expect(result.expansionSource).toBe('synonym-map');
  });

  it('limits expansion to at most 5 terms', () => {
    // "error" and "auth" combined have 8 synonyms; should be capped
    const result = expander.expand('auth error');
    expect(result.expandedTerms.length).toBeLessThanOrEqual(5);
    expect(result.expandedTerms.length).toBeGreaterThan(0);
  });

  it('does not expand unknown terms', () => {
    const result = expander.expand('xylophone');
    expect(result.expandedTerms).toHaveLength(0);
    expect(result.expandedQuery).toBe('xylophone');
    expect(result.expansionSource).toBe('none');
    expect(result.confidence).toBeCloseTo(0.3);
  });

  it('allows adding custom synonyms via addSynonyms', () => {
    expander.addSynonyms('k8s', ['kubernetes', 'cluster', 'pod']);
    const result = expander.expand('k8s');
    expect(result.expandedTerms).toContain('kubernetes');
    expect(result.expandedTerms).toContain('cluster');
  });

  it('tracks expansion statistics correctly', () => {
    expander.expand('auth bug');
    expander.expand('unknown term');
    const stats = expander.getExpansionStats();
    expect(stats.totalExpansions).toBe(2);
    expect(stats.avgTermsAdded).toBeGreaterThan(0);
    expect(stats.synonymMapSize).toBeGreaterThanOrEqual(10);
  });

  it('uses context parameter to add domain-specific expansions', () => {
    // Query alone has no synonyms, but context triggers expansion
    const result = expander.expand('problem', 'auth');
    expect(result.expandedTerms).toContain('authentication');
    expect(result.expandedQuery).toContain('authentication');
  });
});
