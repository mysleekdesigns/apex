/**
 * Multi-Hop Retrieval — iterative query refinement for complex recall.
 *
 * When a single-pass recall returns low-confidence results, a second hop
 * refines the query using keywords extracted from the first hop's results,
 * then merges the two result sets for improved coverage.
 */

import type { SearchResult } from '../types.js';
import { extractKeywords } from '../utils/embeddings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiHopResult {
  results: SearchResult[];
  hops: number;
  refinedQuery?: string;
  improvement: number;
  hopDetails: Array<{
    query: string;
    resultCount: number;
    topScore: number;
  }>;
}

export interface MultiHopOptions {
  maxHops?: number;
  refinementThreshold?: number;
}

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export class MultiHopRetriever {
  private recallFn: (query: string, topK: number) => Promise<SearchResult[]>;
  private totalQueries = 0;
  private multiHopCount = 0;
  private totalImprovement = 0;

  constructor(recallFn: (query: string, topK: number) => Promise<SearchResult[]>) {
    this.recallFn = recallFn;
  }

  async retrieve(
    query: string,
    topK: number,
    options?: MultiHopOptions,
  ): Promise<MultiHopResult> {
    const threshold = options?.refinementThreshold ?? 0.5;
    const maxHops = Math.min(options?.maxHops ?? 2, 3);
    this.totalQueries++;

    // Hop 1
    const hop1 = await this.recallFn(query, topK);
    const hop1Top = hop1[0]?.score ?? 0;
    const hopDetails: MultiHopResult['hopDetails'] = [
      { query, resultCount: hop1.length, topScore: hop1Top },
    ];

    const needsRefinement =
      maxHops >= 2 && (hop1Top < threshold || hop1.length < topK / 2);

    if (!needsRefinement) {
      return { results: hop1, hops: 1, improvement: 0, hopDetails };
    }

    // Build refined query from hop 1 top results
    const topContent = hop1.slice(0, 3).map((r) => r.entry.content).join(' ');
    const keywords = extractKeywords(topContent);
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const newKeywords = keywords.filter((k) => !queryWords.has(k)).slice(0, 5);
    const refinedQuery = `${query} ${newKeywords.join(' ')}`.trim();

    // Hop 2
    const hop2 = await this.recallFn(refinedQuery, topK);
    hopDetails.push({
      query: refinedQuery,
      resultCount: hop2.length,
      topScore: hop2[0]?.score ?? 0,
    });

    // Merge & deduplicate — keep highest score per entry id
    const seen = new Map<string, SearchResult>();
    for (const r of [...hop1, ...hop2]) {
      const existing = seen.get(r.entry.id);
      if (!existing || r.score > existing.score) {
        seen.set(r.entry.id, r);
      }
    }
    const merged = [...seen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const mergedTop = merged[0]?.score ?? 0;
    const improvement = Math.max(0, mergedTop - hop1Top);

    this.multiHopCount++;
    this.totalImprovement += improvement;

    return { results: merged, hops: 2, refinedQuery, improvement, hopDetails };
  }

  getStats(): { totalQueries: number; multiHopRate: number; avgImprovement: number } {
    return {
      totalQueries: this.totalQueries,
      multiHopRate: this.totalQueries > 0 ? this.multiHopCount / this.totalQueries : 0,
      avgImprovement: this.multiHopCount > 0 ? this.totalImprovement / this.multiHopCount : 0,
    };
  }
}
