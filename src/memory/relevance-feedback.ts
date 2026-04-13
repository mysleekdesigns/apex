/**
 * Relevance Feedback Tracker (Phase 19)
 *
 * Tracks which recalled results actually get *used* by the agent, enabling
 * future retrieval ranking improvements. Companion to the effectiveness
 * tracker — this module captures per-result signal rather than binary hit/miss.
 *
 * Pure data operations — no LLM calls, no external services.
 */

import { generateId, type MemoryTier } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recall event — what the agent retrieved. */
export interface RecallEvent {
  id: string;
  query: string;
  resultIds: string[];
  resultScores: number[];
  resultTiers: MemoryTier[];
  timestamp: number;
}

/** Links a recall event to the results the agent actually used. */
export interface UsageEvent {
  recallEventId: string;
  usedResultIds: string[];
  timestamp: number;
}

/** Aggregate statistics across all tracked recall/usage events. */
export interface RelevanceFeedbackStats {
  totalRecalls: number;
  totalUsageEvents: number;
  avgUsageRate: number;
  perTierUsageRate: Record<MemoryTier, number>;
  topUsedEntryIds: string[];
}

// ---------------------------------------------------------------------------
// RelevanceFeedbackTracker
// ---------------------------------------------------------------------------

export class RelevanceFeedbackTracker {
  private readonly maxHistory: number;
  private readonly recalls: RecallEvent[] = [];
  private readonly usages: UsageEvent[] = [];

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  /** Record a recall event and return its unique ID. */
  recordRecall(
    query: string,
    results: Array<{ id: string; score: number; tier: MemoryTier }>,
  ): string {
    const id = generateId();
    this.recalls.push({
      id,
      query,
      resultIds: results.map((r) => r.id),
      resultScores: results.map((r) => r.score),
      resultTiers: results.map((r) => r.tier),
      timestamp: Date.now(),
    });
    if (this.recalls.length > this.maxHistory) {
      this.recalls.shift();
    }
    return id;
  }

  /** Record which results from a recall event were actually used. */
  recordUsage(recallEventId: string, usedResultIds: string[]): void {
    this.usages.push({ recallEventId, usedResultIds, timestamp: Date.now() });
    if (this.usages.length > this.maxHistory) {
      this.usages.shift();
    }
  }

  /**
   * Compute a boost factor for each entry that has appeared in recall results.
   *
   * Formula: `(usageCount / returnCount - 0.5) * 0.6` clamped to [-0.1, 0.3].
   */
  getBoostScores(): Map<string, number> {
    const returned = new Map<string, number>();
    const used = new Map<string, number>();

    for (const r of this.recalls) {
      for (const id of r.resultIds) {
        returned.set(id, (returned.get(id) ?? 0) + 1);
      }
    }

    for (const u of this.usages) {
      for (const id of u.usedResultIds) {
        used.set(id, (used.get(id) ?? 0) + 1);
      }
    }

    const boosts = new Map<string, number>();
    for (const [id, returnCount] of returned) {
      const usageCount = used.get(id) ?? 0;
      const raw = (usageCount / returnCount - 0.5) * 0.6;
      boosts.set(id, Math.max(-0.1, Math.min(0.3, raw)));
    }
    return boosts;
  }

  /** Aggregate stats across all recorded events. */
  getStats(): RelevanceFeedbackStats {
    const tiers: MemoryTier[] = ['working', 'episodic', 'semantic', 'procedural'];
    const tierReturned: Record<MemoryTier, number> = { working: 0, episodic: 0, semantic: 0, procedural: 0 };
    const tierUsed: Record<MemoryTier, number> = { working: 0, episodic: 0, semantic: 0, procedural: 0 };

    // Build a set of used IDs per recall event for fast lookup
    const usedByRecall = new Map<string, Set<string>>();
    for (const u of this.usages) {
      const existing = usedByRecall.get(u.recallEventId);
      if (existing) {
        for (const id of u.usedResultIds) existing.add(id);
      } else {
        usedByRecall.set(u.recallEventId, new Set(u.usedResultIds));
      }
    }

    let totalReturned = 0;
    let totalUsed = 0;
    const usageCount = new Map<string, number>();

    for (const r of this.recalls) {
      const usedSet = usedByRecall.get(r.id);
      for (let i = 0; i < r.resultIds.length; i++) {
        const id = r.resultIds[i];
        const tier = r.resultTiers[i];
        totalReturned++;
        tierReturned[tier]++;
        if (usedSet?.has(id)) {
          totalUsed++;
          tierUsed[tier]++;
          usageCount.set(id, (usageCount.get(id) ?? 0) + 1);
        }
      }
    }

    const perTierUsageRate = {} as Record<MemoryTier, number>;
    for (const t of tiers) {
      perTierUsageRate[t] = tierReturned[t] > 0 ? tierUsed[t] / tierReturned[t] : 0;
    }

    // Top 10 most-used entries
    const topUsedEntryIds = [...usageCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);

    return {
      totalRecalls: this.recalls.length,
      totalUsageEvents: this.usages.length,
      avgUsageRate: totalReturned > 0 ? totalUsed / totalReturned : 0,
      perTierUsageRate,
      topUsedEntryIds,
    };
  }

  /** Return the most recent recall event ID, if any. */
  getRecentRecallId(): string | undefined {
    return this.recalls.length > 0 ? this.recalls[this.recalls.length - 1].id : undefined;
  }
}
