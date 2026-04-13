/**
 * Query Expander for APEX recall system (Phase 19).
 *
 * Automatically expands vague queries with related terms so that
 * searches like "auth bug" also match "authentication", "login", etc.
 */

import { extractKeywords } from '../utils/embeddings.js';

export interface QueryExpansion {
  originalQuery: string;
  expandedTerms: string[];
  expandedQuery: string;
  expansionSource: string;
  confidence: number;
}

const DEFAULT_SYNONYMS: Record<string, string[]> = {
  auth: ['authentication', 'login', 'session', 'credentials'],
  error: ['exception', 'failure', 'bug', 'crash'],
  test: ['spec', 'assertion', 'expect', 'coverage'],
  deploy: ['release', 'ship', 'publish', 'ci/cd'],
  db: ['database', 'query', 'sql', 'schema', 'migration'],
  api: ['endpoint', 'route', 'request', 'response', 'rest'],
  config: ['configuration', 'settings', 'options', 'env'],
  perf: ['performance', 'latency', 'throughput', 'optimization'],
  cache: ['caching', 'memoize', 'invalidation', 'ttl'],
  log: ['logging', 'trace', 'debug', 'monitor'],
};

const MAX_EXPANDED_TERMS = 5;
const BASE_CONFIDENCE = 0.3;

export class QueryExpander {
  private synonymMap: Map<string, string[]>;
  private stats = { totalExpansions: 0, totalTermsAdded: 0 };

  constructor(customSynonyms?: Record<string, string[]>) {
    this.synonymMap = new Map<string, string[]>();
    for (const [term, syns] of Object.entries(DEFAULT_SYNONYMS)) {
      this.synonymMap.set(term, [...syns]);
    }
    if (customSynonyms) {
      for (const [term, syns] of Object.entries(customSynonyms)) {
        this.synonymMap.set(term, [...syns]);
      }
    }
  }

  expand(query: string, context?: string): QueryExpansion {
    const keywords = extractKeywords(query);
    const expanded: string[] = [];
    let matched = 0;

    for (const kw of keywords) {
      const syns = this.synonymMap.get(kw);
      if (syns) {
        matched++;
        for (const s of syns) {
          if (!expanded.includes(s) && !keywords.includes(s)) {
            expanded.push(s);
          }
          if (expanded.length >= MAX_EXPANDED_TERMS) break;
        }
      }
      if (expanded.length >= MAX_EXPANDED_TERMS) break;
    }

    // Context-based expansion: treat context as extra keywords to look up
    if (context) {
      const ctxKeywords = extractKeywords(context);
      for (const kw of ctxKeywords) {
        const syns = this.synonymMap.get(kw);
        if (syns) {
          for (const s of syns) {
            if (!expanded.includes(s) && !keywords.includes(s)) {
              expanded.push(s);
            }
            if (expanded.length >= MAX_EXPANDED_TERMS) break;
          }
        }
        if (expanded.length >= MAX_EXPANDED_TERMS) break;
      }
    }

    const confidence =
      keywords.length === 0
        ? BASE_CONFIDENCE
        : BASE_CONFIDENCE + (1 - BASE_CONFIDENCE) * (matched / keywords.length);

    const expandedQuery =
      expanded.length > 0 ? query + ' ' + expanded.join(' ') : query;

    this.stats.totalExpansions++;
    this.stats.totalTermsAdded += expanded.length;

    return {
      originalQuery: query,
      expandedTerms: expanded,
      expandedQuery,
      expansionSource: expanded.length > 0 ? 'synonym-map' : 'none',
      confidence,
    };
  }

  addSynonyms(term: string, synonyms: string[]): void {
    const existing = this.synonymMap.get(term) ?? [];
    const merged = [...existing];
    for (const s of synonyms) {
      if (!merged.includes(s)) merged.push(s);
    }
    this.synonymMap.set(term, merged);
  }

  getExpansionStats(): {
    totalExpansions: number;
    avgTermsAdded: number;
    synonymMapSize: number;
  } {
    return {
      totalExpansions: this.stats.totalExpansions,
      avgTermsAdded:
        this.stats.totalExpansions === 0
          ? 0
          : this.stats.totalTermsAdded / this.stats.totalExpansions,
      synonymMapSize: this.synonymMap.size,
    };
  }
}
