/**
 * ACT-R Base-Level Learning activation engine with spreading activation.
 *
 * Implements the ACT-R base-level learning equation:
 *   B_i = ln( sum( t_j^(-d) ) )
 * where t_j is the time since the j-th access (in seconds) and d is the
 * decay parameter (default 0.5).
 *
 * Spreading activation boosts neighbors of recently-recalled entries,
 * modelling associative priming from cognitive architecture research.
 */

import { randomUUID } from 'node:crypto';
import type { FileStore } from '../utils/file-store.js';
import type { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AccessRecord {
  timestamp: number; // ms since epoch
}

export interface ActivationEntry {
  id: string;
  accessHistory: AccessRecord[];
  baseActivation: number;
  spreadBoost: number;
  totalActivation: number;
  lastComputed: number;
}

export interface SpreadingActivationResult {
  boostedEntries: Array<{ id: string; boost: number }>;
  sourceId: string;
  timestamp: number;
}

export interface ActivationEngineOptions {
  fileStore: FileStore;
  logger?: Logger;
  decayParameter?: number;     // d in ACT-R formula, default 0.5
  spreadFactor?: number;       // default 0.3
  maxAccessHistory?: number;   // cap access records per entry, default 100
  spreadBoostDecay?: number;   // per-hour decay rate for spread boost, default 0.1
}

export interface ActivationStats {
  totalEntries: number;
  avgBaseActivation: number;
  avgTotalActivation: number;
  spreadEventsCount: number;
  entriesWithSpreadBoost: number;
}

interface RetrievalComparison {
  actrRanking: string[];
  heatRanking: string[];
  relevantIds: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'activation-entries';
const DEFAULT_DECAY = 0.5;
const DEFAULT_SPREAD_FACTOR = 0.3;
const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_SPREAD_BOOST_DECAY = 0.1;
const MAX_COMPARISONS = 100;
const SPREAD_BOOST_CAP = 1.0;
const SPREAD_BOOST_FLOOR = 0.01;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mean Reciprocal Rank: average of 1/rank for each relevant id found. */
function computeMRR(ranking: string[], relevantIds: string[]): number {
  if (relevantIds.length === 0) return 0;
  let sum = 0;
  for (const id of relevantIds) {
    const idx = ranking.indexOf(id);
    if (idx >= 0) {
      sum += 1 / (idx + 1);
    }
  }
  return sum / relevantIds.length;
}

// ---------------------------------------------------------------------------
// ActivationEngine
// ---------------------------------------------------------------------------

export class ActivationEngine {
  private readonly fileStore: FileStore;
  private readonly logger: Logger | undefined;
  private readonly decayParameter: number;
  private readonly spreadFactor: number;
  private readonly maxAccessHistory: number;
  private readonly spreadBoostDecay: number;

  /** In-memory index keyed by entry id. */
  private entries = new Map<string, ActivationEntry>();

  /** Running count of spread activation events. */
  private spreadEventsCount = 0;

  /** Ring buffer of retrieval comparisons. */
  private comparisons: RetrievalComparison[] = [];

  constructor(opts: ActivationEngineOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger;
    this.decayParameter = opts.decayParameter ?? DEFAULT_DECAY;
    this.spreadFactor = opts.spreadFactor ?? DEFAULT_SPREAD_FACTOR;
    this.maxAccessHistory = opts.maxAccessHistory ?? DEFAULT_MAX_HISTORY;
    this.spreadBoostDecay = opts.spreadBoostDecay ?? DEFAULT_SPREAD_BOOST_DECAY;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    const ids = await this.fileStore.list(COLLECTION);
    for (const id of ids) {
      const entry = await this.fileStore.read<ActivationEntry>(COLLECTION, id);
      if (entry) {
        this.entries.set(entry.id, entry);
      }
    }
    this.logger?.debug('ActivationEngine initialised', { entryCount: this.entries.size });
  }

  async persist(): Promise<void> {
    for (const [id, entry] of this.entries) {
      await this.fileStore.write(COLLECTION, id, entry);
    }
    this.logger?.debug('ActivationEngine persisted', { entryCount: this.entries.size });
  }

  // -----------------------------------------------------------------------
  // Core ACT-R computation
  // -----------------------------------------------------------------------

  /**
   * ACT-R Base-Level Learning equation:
   *   B_i = ln( sum_j( t_j^(-d) ) )
   */
  computeBaseActivation(accessHistory: AccessRecord[], now: number = Date.now()): number {
    if (accessHistory.length === 0) return -Infinity;

    const d = this.decayParameter;
    let sum = 0;
    for (const access of accessHistory) {
      const t_j = Math.max((now - access.timestamp) / 1000, 1); // seconds, min 1
      sum += Math.pow(t_j, -d);
    }
    return Math.log(sum);
  }

  // -----------------------------------------------------------------------
  // Entry management
  // -----------------------------------------------------------------------

  async registerEntry(entryId: string, initialTimestamp?: number): Promise<ActivationEntry> {
    const now = initialTimestamp ?? Date.now();
    const accessHistory: AccessRecord[] = [{ timestamp: now }];
    const baseActivation = this.computeBaseActivation(accessHistory, now);
    const entry: ActivationEntry = {
      id: entryId,
      accessHistory,
      baseActivation,
      spreadBoost: 0,
      totalActivation: baseActivation,
      lastComputed: now,
    };
    this.entries.set(entryId, entry);
    await this.fileStore.write(COLLECTION, entryId, entry);
    return entry;
  }

  async removeEntry(entryId: string): Promise<void> {
    this.entries.delete(entryId);
    await this.fileStore.delete(COLLECTION, entryId);
  }

  async recordAccess(entryId: string, now: number = Date.now()): Promise<ActivationEntry> {
    let entry = this.entries.get(entryId);
    if (!entry) {
      return this.registerEntry(entryId, now);
    }

    entry.accessHistory.push({ timestamp: now });

    // Cap access history
    if (entry.accessHistory.length > this.maxAccessHistory) {
      entry.accessHistory = entry.accessHistory.slice(
        entry.accessHistory.length - this.maxAccessHistory,
      );
    }

    entry.baseActivation = this.computeBaseActivation(entry.accessHistory, now);
    entry.totalActivation = entry.baseActivation + entry.spreadBoost;
    entry.lastComputed = now;
    this.entries.set(entryId, entry);
    await this.fileStore.write(COLLECTION, entryId, entry);
    return entry;
  }

  getActivation(entryId: string, now: number = Date.now()): number {
    const entry = this.entries.get(entryId);
    if (!entry) return -Infinity;
    // Recompute base activation at query time for freshness
    const base = this.computeBaseActivation(entry.accessHistory, now);
    return base + entry.spreadBoost;
  }

  getEntry(entryId: string): ActivationEntry | null {
    return this.entries.get(entryId) ?? null;
  }

  // -----------------------------------------------------------------------
  // Spreading activation
  // -----------------------------------------------------------------------

  async spreadActivation(
    sourceId: string,
    neighborIds: string[],
  ): Promise<SpreadingActivationResult> {
    const now = Date.now();
    const sourceEntry = this.entries.get(sourceId);
    const sourceActivation = sourceEntry
      ? this.activationToHeatScore(sourceEntry.totalActivation)
      : 0;

    const boostedEntries: Array<{ id: string; boost: number }> = [];

    for (const nId of neighborIds) {
      const neighbor = this.entries.get(nId);
      if (!neighbor) continue;

      const boost = this.spreadFactor * sourceActivation;
      neighbor.spreadBoost = Math.min(neighbor.spreadBoost + boost, SPREAD_BOOST_CAP);
      neighbor.totalActivation = neighbor.baseActivation + neighbor.spreadBoost;
      neighbor.lastComputed = now;
      this.entries.set(nId, neighbor);

      boostedEntries.push({ id: nId, boost });
    }

    this.spreadEventsCount++;
    this.logger?.debug('Spreading activation', {
      sourceId,
      neighborsCount: neighborIds.length,
      boostedCount: boostedEntries.length,
    });

    return { boostedEntries, sourceId, timestamp: now };
  }

  decaySpreadBoosts(now: number = Date.now()): void {
    for (const [, entry] of this.entries) {
      if (entry.spreadBoost <= 0) continue;

      const hoursSinceComputed = Math.max(
        (now - entry.lastComputed) / (1000 * 60 * 60),
        0,
      );
      if (hoursSinceComputed <= 0) continue;

      entry.spreadBoost *= Math.pow(1 - this.spreadBoostDecay, hoursSinceComputed);
      if (entry.spreadBoost < SPREAD_BOOST_FLOOR) {
        entry.spreadBoost = 0;
      }
      entry.totalActivation = this.computeBaseActivation(entry.accessHistory, now) + entry.spreadBoost;
      entry.lastComputed = now;
    }
  }

  // -----------------------------------------------------------------------
  // Ranking & compatibility
  // -----------------------------------------------------------------------

  getRankedEntries(): ActivationEntry[] {
    const now = Date.now();
    // Refresh total activation before ranking
    for (const [, entry] of this.entries) {
      entry.baseActivation = this.computeBaseActivation(entry.accessHistory, now);
      entry.totalActivation = entry.baseActivation + entry.spreadBoost;
      entry.lastComputed = now;
    }
    return [...this.entries.values()].sort(
      (a, b) => b.totalActivation - a.totalActivation,
    );
  }

  /**
   * Sigmoid mapping: activation -> [0, 1] heat score for backward compatibility.
   */
  activationToHeatScore(activation: number): number {
    if (activation === -Infinity) return 0;
    return 1 / (1 + Math.exp(-activation));
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  getStats(): ActivationStats {
    const entries = [...this.entries.values()];
    const total = entries.length;
    if (total === 0) {
      return {
        totalEntries: 0,
        avgBaseActivation: 0,
        avgTotalActivation: 0,
        spreadEventsCount: this.spreadEventsCount,
        entriesWithSpreadBoost: 0,
      };
    }

    let sumBase = 0;
    let sumTotal = 0;
    let withBoost = 0;
    for (const e of entries) {
      sumBase += e.baseActivation;
      sumTotal += e.totalActivation;
      if (e.spreadBoost > 0) withBoost++;
    }

    return {
      totalEntries: total,
      avgBaseActivation: sumBase / total,
      avgTotalActivation: sumTotal / total,
      spreadEventsCount: this.spreadEventsCount,
      entriesWithSpreadBoost: withBoost,
    };
  }

  // -----------------------------------------------------------------------
  // Effectiveness tracking
  // -----------------------------------------------------------------------

  recordRetrievalComparison(
    actrRanking: string[],
    heatRanking: string[],
    relevantIds: string[],
  ): void {
    this.comparisons.push({
      actrRanking,
      heatRanking,
      relevantIds,
      timestamp: Date.now(),
    });
    // Ring buffer: keep only latest MAX_COMPARISONS
    if (this.comparisons.length > MAX_COMPARISONS) {
      this.comparisons = this.comparisons.slice(this.comparisons.length - MAX_COMPARISONS);
    }
  }

  getEffectivenessReport(): {
    comparisons: number;
    actrWins: number;
    heatWins: number;
    ties: number;
    actrAvgMRR: number;
    heatAvgMRR: number;
  } {
    let actrWins = 0;
    let heatWins = 0;
    let ties = 0;
    let actrMRRSum = 0;
    let heatMRRSum = 0;

    for (const c of this.comparisons) {
      const actrMRR = computeMRR(c.actrRanking, c.relevantIds);
      const heatMRR = computeMRR(c.heatRanking, c.relevantIds);
      actrMRRSum += actrMRR;
      heatMRRSum += heatMRR;

      if (actrMRR > heatMRR) actrWins++;
      else if (heatMRR > actrMRR) heatWins++;
      else ties++;
    }

    const n = this.comparisons.length;
    return {
      comparisons: n,
      actrWins,
      heatWins,
      ties,
      actrAvgMRR: n > 0 ? actrMRRSum / n : 0,
      heatAvgMRR: n > 0 ? heatMRRSum / n : 0,
    };
  }
}
