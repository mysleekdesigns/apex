/**
 * Automated Prompt Mutation Engine
 *
 * Generates, applies, and tracks rule-based mutations to prompt text,
 * inspired by DSPy-style prompt optimization. All computation is pure
 * statistical/algorithmic — zero LLM calls.
 *
 * Mutation strategies:
 * - rephrase: synonym swapping
 * - add-example: append example placeholders
 * - remove-example: strip existing examples
 * - adjust-emphasis: add importance markers
 * - simplify: remove parentheticals and filler adverbs
 * - elaborate: expand short text with paraphrase
 */

import type { PromptSuggestion } from '../types.js';
import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MutationType =
  | 'rephrase'
  | 'add-example'
  | 'remove-example'
  | 'adjust-emphasis'
  | 'simplify'
  | 'elaborate';

export interface MutationRecord {
  id: string;
  originalText: string;
  mutatedText: string;
  mutationType: MutationType;
  moduleName: string;
  expectedImpact: number;
  actualImpact: number | null;
  applied: boolean;
  timestamp: string;
}

export interface PromptOptimizerOptions {
  fileStore: FileStore;
  logger?: Logger;
  /** Mutation rate 0-1, default 0.3 */
  mutationRate?: number;
  /** Max mutations per round, default 3 */
  maxMutationsPerRound?: number;
}

export interface OptimizationRound {
  id: string;
  mutations: MutationRecord[];
  baselineScore: number;
  postScore: number | null;
  improvement: number | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'prompt-mutations';

const SYNONYM_PAIRS: Array<[string, string]> = [
  ['use', 'utilize'],
  ['check', 'verify'],
  ['create', 'generate'],
  ['important', 'critical'],
  ['should', 'must'],
];

const FILLER_ADVERBS = ['really', 'very', 'extremely', 'actually'];

const ALL_MUTATION_TYPES: MutationType[] = [
  'rephrase',
  'add-example',
  'remove-example',
  'adjust-emphasis',
  'simplify',
  'elaborate',
];

// ---------------------------------------------------------------------------
// PromptOptimizer
// ---------------------------------------------------------------------------

export class PromptOptimizer {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly mutationRate: number;
  private readonly maxMutationsPerRound: number;
  private mutations: MutationRecord[] = [];
  private rounds: OptimizationRound[] = [];

  constructor(opts: PromptOptimizerOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'PromptOptimizer' });
    this.mutationRate = opts.mutationRate ?? 0.3;
    this.maxMutationsPerRound = opts.maxMutationsPerRound ?? 3;
  }

  async init(): Promise<void> {
    const stored = await this.fileStore.read<{
      mutations: MutationRecord[];
      rounds: OptimizationRound[];
    }>(COLLECTION, 'state');
    if (stored) {
      this.mutations = stored.mutations ?? [];
      this.rounds = stored.rounds ?? [];
    }
    this.logger.debug('Initialized prompt optimizer', {
      mutations: this.mutations.length,
      rounds: this.rounds.length,
    });
  }

  async persist(): Promise<void> {
    await this.fileStore.write(COLLECTION, 'state', {
      mutations: this.mutations,
      rounds: this.rounds,
    });
  }

  // -----------------------------------------------------------------------
  // Mutation proposal
  // -----------------------------------------------------------------------

  proposeMutations(input: {
    moduleName: string;
    currentText: string;
    currentMetrics: { successRate: number; avgReward: number; exposures: number };
  }): MutationRecord[] {
    const { moduleName, currentText, currentMetrics } = input;
    const candidates: MutationRecord[] = [];

    for (const mutType of ALL_MUTATION_TYPES) {
      if (Math.random() > this.mutationRate) continue;

      const mutatedText = this.applyMutation(currentText, mutType);
      if (mutatedText === currentText) continue;

      const expectedImpact = this.estimateImpact(mutType, currentMetrics);

      candidates.push({
        id: generateId(),
        originalText: currentText,
        mutatedText,
        mutationType: mutType,
        moduleName,
        expectedImpact,
        actualImpact: null,
        applied: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Sort by expected impact descending, take top N
    candidates.sort((a, b) => b.expectedImpact - a.expectedImpact);
    const selected = candidates.slice(0, this.maxMutationsPerRound);

    this.mutations.push(...selected);
    this.logger.info('Proposed mutations', {
      moduleName,
      count: selected.length,
    });
    return selected;
  }

  // -----------------------------------------------------------------------
  // Mutation application (pure text transforms)
  // -----------------------------------------------------------------------

  applyMutation(text: string, type: MutationType): string {
    switch (type) {
      case 'rephrase':
        return this.applyRephrase(text);
      case 'add-example':
        return this.applyAddExample(text);
      case 'remove-example':
        return this.applyRemoveExample(text);
      case 'adjust-emphasis':
        return this.applyAdjustEmphasis(text);
      case 'simplify':
        return this.applySimplify(text);
      case 'elaborate':
        return this.applyElaborate(text);
    }
  }

  private applyRephrase(text: string): string {
    let result = text;
    for (const [a, b] of SYNONYM_PAIRS) {
      // Match whole words only (case-insensitive first occurrence)
      const regex = new RegExp(`\\b${a}\\b`, 'i');
      if (regex.test(result)) {
        result = result.replace(regex, (match) => {
          // Preserve casing of first character
          if (match[0] === match[0].toUpperCase()) {
            return b.charAt(0).toUpperCase() + b.slice(1);
          }
          return b;
        });
        break; // one swap per call
      }
      const regexReverse = new RegExp(`\\b${b}\\b`, 'i');
      if (regexReverse.test(result)) {
        result = result.replace(regexReverse, (match) => {
          if (match[0] === match[0].toUpperCase()) {
            return a.charAt(0).toUpperCase() + a.slice(1);
          }
          return a;
        });
        break;
      }
    }
    return result;
  }

  private applyAddExample(text: string): string {
    if (/Example:|e\.g\./i.test(text)) return text;
    return text + '\nExample: [see few-shot examples]';
  }

  private applyRemoveExample(text: string): string {
    const lines = text.split('\n');
    const filtered = lines.filter(
      (line) => !line.trimStart().startsWith('Example:') && !line.includes('e.g.,'),
    );
    return filtered.join('\n');
  }

  private applyAdjustEmphasis(text: string): string {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return text;

    // Add "Important:" prefix to first non-empty line if not already present
    const firstIdx = text.indexOf(lines[0]);
    if (lines[0].startsWith('Important:')) return text;
    return text.slice(0, firstIdx) + 'Important: ' + text.slice(firstIdx);
  }

  private applySimplify(text: string): string {
    let result = text;
    // Remove parenthetical phrases
    result = result.replace(/\s*\([^)]*\)/g, '');
    // Remove filler adverbs (whole words)
    for (const adverb of FILLER_ADVERBS) {
      result = result.replace(new RegExp(`\\b${adverb}\\b\\s*`, 'gi'), '');
    }
    return result;
  }

  private applyElaborate(text: string): string {
    if (text.length >= 100) return text;
    // For short texts, add a paraphrase
    const trimmed = text.trim();
    const lowered = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    return `${trimmed}\nIn other words, ${lowered.charAt(0).toLowerCase()}${lowered.slice(1)}.`;
  }

  // -----------------------------------------------------------------------
  // Impact estimation
  // -----------------------------------------------------------------------

  private estimateImpact(
    type: MutationType,
    metrics: { successRate: number; avgReward: number; exposures: number },
  ): number {
    const baseImpact: Record<MutationType, number> = {
      rephrase: 0.1,
      'add-example': 0.25,
      'remove-example': 0.05,
      'adjust-emphasis': 0.15,
      simplify: 0.2,
      elaborate: 0.15,
    };

    let impact = baseImpact[type];

    // Simplify has higher impact for low-performing modules
    if (type === 'simplify' && metrics.successRate < 0.5) {
      impact += 0.15;
    }
    // Add-example is more impactful for low exposure
    if (type === 'add-example' && metrics.exposures < 5) {
      impact += 0.1;
    }
    // Elaborate is better for low-reward modules
    if (type === 'elaborate' && metrics.avgReward < 0.4) {
      impact += 0.1;
    }

    return Math.min(impact, 1.0);
  }

  // -----------------------------------------------------------------------
  // Outcome tracking
  // -----------------------------------------------------------------------

  async recordMutationOutcome(mutationId: string, actualImpact: number): Promise<void> {
    const mutation = this.mutations.find((m) => m.id === mutationId);
    if (!mutation) {
      this.logger.warn('Mutation not found', { mutationId });
      return;
    }
    mutation.actualImpact = actualImpact;
    mutation.applied = true;
    await this.persist();
    this.logger.info('Recorded mutation outcome', { mutationId, actualImpact });
  }

  // -----------------------------------------------------------------------
  // History & stats
  // -----------------------------------------------------------------------

  getMutationHistory(moduleName?: string): MutationRecord[] {
    if (moduleName) {
      return this.mutations.filter((m) => m.moduleName === moduleName);
    }
    return [...this.mutations];
  }

  getMutationStats(): Record<MutationType, { count: number; avgImpact: number; successRate: number }> {
    const stats: Record<string, { count: number; totalImpact: number; successCount: number }> = {};

    for (const mt of ALL_MUTATION_TYPES) {
      stats[mt] = { count: 0, totalImpact: 0, successCount: 0 };
    }

    for (const m of this.mutations) {
      const s = stats[m.mutationType];
      s.count++;
      if (m.actualImpact !== null) {
        s.totalImpact += m.actualImpact;
        if (m.actualImpact > 0) s.successCount++;
      }
    }

    const result: Record<string, { count: number; avgImpact: number; successRate: number }> = {};
    for (const mt of ALL_MUTATION_TYPES) {
      const s = stats[mt];
      result[mt] = {
        count: s.count,
        avgImpact: s.count > 0 ? s.totalImpact / s.count : 0,
        successRate: s.count > 0 ? s.successCount / s.count : 0,
      };
    }

    return result as Record<MutationType, { count: number; avgImpact: number; successRate: number }>;
  }

  // -----------------------------------------------------------------------
  // Suggestions (PromptSuggestion-compatible)
  // -----------------------------------------------------------------------

  getSuggestions(): PromptSuggestion[] {
    // Convert the top unapplied mutations into PromptSuggestions
    const unapplied = this.mutations
      .filter((m) => !m.applied)
      .sort((a, b) => b.expectedImpact - a.expectedImpact);

    return unapplied.map((m) => ({
      id: m.id,
      section: m.moduleName,
      currentText: m.originalText,
      suggestedText: m.mutatedText,
      reason: `${m.mutationType} mutation for ${m.moduleName}`,
      expectedImpact: `Expected improvement: ${(m.expectedImpact * 100).toFixed(0)}%`,
      confidence: m.expectedImpact,
      timestamp: new Date(m.timestamp).getTime(),
    }));
  }

  // -----------------------------------------------------------------------
  // Optimization round
  // -----------------------------------------------------------------------

  async runOptimizationRound(
    modules: Array<{ name: string; content: string; metrics: { successRate: number; avgReward: number; exposures: number } }>,
  ): Promise<OptimizationRound> {
    const allMutations: MutationRecord[] = [];

    // Compute baseline as average success rate
    const baselineScore =
      modules.length > 0
        ? modules.reduce((sum, m) => sum + m.metrics.successRate, 0) / modules.length
        : 0;

    for (const mod of modules) {
      const mutations = this.proposeMutations({
        moduleName: mod.name,
        currentText: mod.content,
        currentMetrics: mod.metrics,
      });
      allMutations.push(...mutations);
    }

    const round: OptimizationRound = {
      id: generateId(),
      mutations: allMutations,
      baselineScore,
      postScore: null,
      improvement: null,
      timestamp: new Date().toISOString(),
    };

    this.rounds.push(round);
    await this.persist();

    this.logger.info('Completed optimization round', {
      roundId: round.id,
      totalMutations: allMutations.length,
      baselineScore,
    });

    return round;
  }
}
