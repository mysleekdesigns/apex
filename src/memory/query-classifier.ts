/**
 * Query Classifier — Phase 19: Adaptive Embedding & Query Understanding
 *
 * Heuristic-based classifier that determines query intent to route retrieval
 * with category-specific weights and tier priorities.
 */

import type { MemoryTier } from '../types.js';
import type { HybridWeights } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryCategory = 'error-lookup' | 'pattern-search' | 'skill-search' | 'planning' | 'exploratory';

export interface QueryClassification {
  category: QueryCategory;
  confidence: number;
  signals: string[];
  suggestedWeights: HybridWeights;
  suggestedTiers: MemoryTier[];
}

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

interface CategoryDef {
  patterns: Array<{ regex: RegExp; weight: number; label: string }>;
  weights: HybridWeights;
  tiers: MemoryTier[];
}

const CATEGORIES: Record<QueryCategory, CategoryDef> = {
  'error-lookup': {
    patterns: [
      { regex: /\b(error|exception|fail(ed|ure|ing)?|bug|crash|broken|throw[ns]?)\b/i, weight: 1.0, label: 'error-keyword' },
      { regex: /\b(TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|EPERM)\b/, weight: 1.5, label: 'error-type' },
      { regex: /\b(stack\s*trace|traceback|segfault|panic)\b/i, weight: 1.2, label: 'stack-trace-keyword' },
      { regex: /\w+\.\w+:\d+/, weight: 1.3, label: 'file-line-pattern' },
      { regex: /at\s+\w+\s+\(/, weight: 1.2, label: 'stack-frame' },
    ],
    weights: { vector: 0.3, bm25: 0.6, recency: 0.1 },
    tiers: ['episodic', 'semantic'],
  },
  'pattern-search': {
    patterns: [
      { regex: /\b(pattern|approach|how\s+to|implement|example|template)\b/i, weight: 1.0, label: 'pattern-keyword' },
      { regex: /\b(best\s+practice|convention|idiom|technique)\b/i, weight: 0.9, label: 'practice-keyword' },
      { regex: /\b(code\s+(for|to|that)|way\s+to)\b/i, weight: 0.8, label: 'code-seeking' },
    ],
    weights: { vector: 0.5, bm25: 0.3, recency: 0.2 },
    tiers: ['semantic', 'procedural'],
  },
  'skill-search': {
    patterns: [
      { regex: /\b(skill|procedure|step[\s-]by[\s-]step|recipe|workflow|setup|runbook)\b/i, weight: 1.0, label: 'skill-keyword' },
      { regex: /\b(checklist|guide|instructions|tutorial)\b/i, weight: 0.8, label: 'guide-keyword' },
      { regex: /\bhow\s+do\s+(I|we|you)\b/i, weight: 0.7, label: 'how-do-i' },
    ],
    weights: { vector: 0.4, bm25: 0.4, recency: 0.2 },
    tiers: ['procedural', 'semantic'],
  },
  'planning': {
    patterns: [
      { regex: /\b(plan|strategy|approach\s+for|next\s+steps?|prioriti[sz]e|roadmap)\b/i, weight: 1.0, label: 'plan-keyword' },
      { regex: /\b(how\s+should|what\s+should|where\s+to\s+start)\b/i, weight: 0.9, label: 'should-keyword' },
      { regex: /\b(before\s+I|task\s+list|order\s+of|sequence)\b/i, weight: 0.8, label: 'sequence-keyword' },
    ],
    weights: { vector: 0.6, bm25: 0.2, recency: 0.2 },
    tiers: ['episodic', 'semantic', 'procedural'],
  },
  'exploratory': {
    patterns: [],
    weights: { vector: 0.6, bm25: 0.3, recency: 0.1 },
    tiers: ['working', 'episodic', 'semantic', 'procedural'],
  },
};

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export class QueryClassifier {
  private outcomes: Array<{ classified: QueryCategory; actual: QueryCategory }> = [];

  /** Classify a query into a category with suggested retrieval parameters. */
  classify(query: string, context?: string): QueryClassification {
    const text = context ? `${query} ${context}` : query;
    const scores: Record<QueryCategory, { score: number; signals: string[] }> = {
      'error-lookup': { score: 0, signals: [] },
      'pattern-search': { score: 0, signals: [] },
      'skill-search': { score: 0, signals: [] },
      'planning': { score: 0, signals: [] },
      'exploratory': { score: 0, signals: [] },
    };

    for (const [cat, def] of Object.entries(CATEGORIES) as Array<[QueryCategory, CategoryDef]>) {
      for (const p of def.patterns) {
        if (p.regex.test(text)) {
          scores[cat].score += p.weight;
          scores[cat].signals.push(p.label);
        }
      }
    }

    // Rank categories by score descending
    const ranked = (Object.keys(scores) as QueryCategory[]).sort(
      (a, b) => scores[b].score - scores[a].score,
    );

    const top = ranked[0];
    const topScore = scores[top].score;
    const runnerUpScore = scores[ranked[1]].score;

    // If no patterns matched at all, fall back to exploratory
    if (topScore === 0) {
      return {
        category: 'exploratory',
        confidence: 0.3,
        signals: ['no-pattern-match'],
        suggestedWeights: CATEGORIES['exploratory'].weights,
        suggestedTiers: CATEGORIES['exploratory'].tiers,
      };
    }

    // Confidence is based on margin between top two scores
    const margin = topScore - runnerUpScore;
    const confidence = Math.min(1, 0.4 + margin * 0.3);

    return {
      category: top,
      confidence,
      signals: scores[top].signals,
      suggestedWeights: CATEGORIES[top].weights,
      suggestedTiers: CATEGORIES[top].tiers,
    };
  }

  /** Record a classification outcome for accuracy tracking. */
  recordOutcome(query: string, classified: QueryCategory, actual: QueryCategory): void {
    this.outcomes.push({ classified, actual });
  }

  /** Get accuracy statistics across recorded outcomes. */
  getAccuracyStats(): { total: number; perCategory: Record<QueryCategory, number> } {
    const cats: QueryCategory[] = ['error-lookup', 'pattern-search', 'skill-search', 'planning', 'exploratory'];
    const perCategory = {} as Record<QueryCategory, number>;

    for (const cat of cats) {
      const relevant = this.outcomes.filter(o => o.actual === cat);
      if (relevant.length === 0) {
        perCategory[cat] = 0;
        continue;
      }
      const correct = relevant.filter(o => o.classified === o.actual).length;
      perCategory[cat] = correct / relevant.length;
    }

    const total = this.outcomes.length === 0
      ? 0
      : this.outcomes.filter(o => o.classified === o.actual).length / this.outcomes.length;

    return { total, perCategory };
  }
}
