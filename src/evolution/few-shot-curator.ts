/**
 * Few-Shot Example Curation
 *
 * Extracts, ranks, rotates, and prunes few-shot examples from successful
 * episodes. Examples are injected into tool prompts to improve agent
 * performance over time. All computation is pure algorithmic — zero LLM calls.
 */

import type { Episode } from '../types.js';
import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FewShotExample {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  sourceEpisodeId: string | null;
  quality: number;
  usageCount: number;
  successAfterUse: number;
  createdAt: string;
  lastUsed: string | null;
}

export interface FewShotCuratorOptions {
  fileStore: FileStore;
  logger?: Logger;
  /** Max examples per tool, default 3 */
  maxExamplesPerTool?: number;
  /** Usage count before rotation kicks in, default 10 */
  rotationInterval?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'few-shot-examples';

// ---------------------------------------------------------------------------
// FewShotCurator
// ---------------------------------------------------------------------------

export class FewShotCurator {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly maxExamplesPerTool: number;
  private readonly rotationInterval: number;
  private examples: FewShotExample[] = [];

  constructor(opts: FewShotCuratorOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'FewShotCurator' });
    this.maxExamplesPerTool = opts.maxExamplesPerTool ?? 3;
    this.rotationInterval = opts.rotationInterval ?? 10;
  }

  async init(): Promise<void> {
    const stored = await this.fileStore.read<{ examples: FewShotExample[] }>(
      COLLECTION,
      'state',
    );
    if (stored) {
      this.examples = stored.examples ?? [];
    }
    this.logger.debug('Initialized few-shot curator', {
      examples: this.examples.length,
    });
  }

  async persist(): Promise<void> {
    await this.fileStore.write(COLLECTION, 'state', {
      examples: this.examples,
    });
  }

  // -----------------------------------------------------------------------
  // Extraction from episodes
  // -----------------------------------------------------------------------

  extractExamples(episodes: Episode[]): FewShotExample[] {
    const extracted: FewShotExample[] = [];

    for (const ep of episodes) {
      if (!ep.outcome.success) continue;
      if (ep.actions.length === 0) continue;

      // Group actions by type (proxy for tool name)
      const actionsByType = new Map<string, typeof ep.actions>();
      for (const action of ep.actions) {
        if (!action.success) continue;
        const existing = actionsByType.get(action.type) ?? [];
        existing.push(action);
        actionsByType.set(action.type, existing);
      }

      for (const [toolName, actions] of actionsByType) {
        const bestAction = actions[0]; // first successful action of this type
        const example: FewShotExample = {
          id: generateId(),
          toolName,
          input: { description: bestAction.description },
          description: `${bestAction.description} (from task: ${ep.task})`,
          sourceEpisodeId: ep.id,
          quality: ep.reward,
          usageCount: 0,
          successAfterUse: 0,
          createdAt: new Date().toISOString(),
          lastUsed: null,
        };
        extracted.push(example);
      }
    }

    this.logger.info('Extracted examples from episodes', {
      episodeCount: episodes.length,
      extractedCount: extracted.length,
    });
    return extracted;
  }

  // -----------------------------------------------------------------------
  // Add / retrieve
  // -----------------------------------------------------------------------

  async addExample(example: FewShotExample): Promise<FewShotExample> {
    this.examples.push(example);
    await this.persist();
    this.logger.debug('Added example', { id: example.id, toolName: example.toolName });
    return example;
  }

  getExamplesForTool(toolName: string): FewShotExample[] {
    return this.examples.filter((e) => e.toolName === toolName);
  }

  getBestExamples(toolName: string, limit?: number): FewShotExample[] {
    const maxCount = limit ?? this.maxExamplesPerTool;
    const toolExamples = this.getExamplesForTool(toolName);

    // Rank by quality * rotation factor
    // Rotation factor: penalize over-used examples
    const ranked = toolExamples
      .map((e) => {
        const rotationFactor =
          e.usageCount >= this.rotationInterval
            ? 0.5
            : 1.0 - (e.usageCount / this.rotationInterval) * 0.5;
        return { example: e, score: e.quality * rotationFactor };
      })
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, maxCount).map((r) => r.example);
  }

  // -----------------------------------------------------------------------
  // Usage & outcome tracking
  // -----------------------------------------------------------------------

  async recordUsage(exampleId: string): Promise<void> {
    const example = this.examples.find((e) => e.id === exampleId);
    if (!example) {
      this.logger.warn('Example not found for usage recording', { exampleId });
      return;
    }
    example.usageCount++;
    example.lastUsed = new Date().toISOString();
    await this.persist();
  }

  async recordOutcome(exampleId: string, success: boolean): Promise<void> {
    const example = this.examples.find((e) => e.id === exampleId);
    if (!example) {
      this.logger.warn('Example not found for outcome recording', { exampleId });
      return;
    }
    if (success) {
      example.successAfterUse++;
    }
    // Recalculate quality
    example.quality = example.successAfterUse / Math.max(example.usageCount, 1);
    await this.persist();
  }

  // -----------------------------------------------------------------------
  // Rotation & pruning
  // -----------------------------------------------------------------------

  async rotateExamples(toolName: string): Promise<FewShotExample[]> {
    const toolExamples = this.getExamplesForTool(toolName);

    // Reset usage counts for over-rotated examples to give them fresh chances
    for (const ex of toolExamples) {
      if (ex.usageCount >= this.rotationInterval) {
        ex.usageCount = 0;
      }
    }

    await this.persist();
    return this.getBestExamples(toolName);
  }

  async pruneExamples(qualityThreshold = 0.3, minUsage = 3): Promise<number> {
    const before = this.examples.length;
    this.examples = this.examples.filter((e) => {
      // Keep examples that haven't been used enough to judge
      if (e.usageCount < minUsage) return true;
      // Keep examples above quality threshold
      return e.quality >= qualityThreshold;
    });
    const pruned = before - this.examples.length;
    if (pruned > 0) {
      await this.persist();
      this.logger.info('Pruned examples', { pruned });
    }
    return pruned;
  }

  // -----------------------------------------------------------------------
  // Formatting for injection
  // -----------------------------------------------------------------------

  formatForInjection(toolName: string): string {
    const best = this.getBestExamples(toolName);
    if (best.length === 0) return '';

    const lines = best.map(
      (e, i) => `Example ${i + 1}: ${e.description}`,
    );
    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  getStats(): { totalExamples: number; byTool: Record<string, number>; avgQuality: number } {
    const byTool: Record<string, number> = {};
    let totalQuality = 0;

    for (const e of this.examples) {
      byTool[e.toolName] = (byTool[e.toolName] ?? 0) + 1;
      totalQuality += e.quality;
    }

    return {
      totalExamples: this.examples.length,
      byTool,
      avgQuality: this.examples.length > 0 ? totalQuality / this.examples.length : 0,
    };
  }
}
