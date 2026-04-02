/**
 * Micro-level Reflection Data Assembler
 *
 * Handles single-episode reflection by retrieving a failed episode,
 * formatting its trajectory as a step-by-step action log, finding
 * contrastive (successful) episodes for the same/similar task, and
 * gathering prior insights from semantic memory.
 *
 * Returns structured, prompt-ready data — Claude does the actual analysis.
 */

import type { Episode, Reflection } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import { getEmbedding } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Input parameters for a micro-level reflection assembly. */
export interface MicroReflectionInput {
  /** ID of the episode to reflect on. */
  episodeId: string;
}

/** A formatted action step ready for prompt consumption. */
export interface FormattedAction {
  step: number;
  type: string;
  description: string;
  success: boolean;
  result?: string;
}

/** Summary of an episode's outcome, formatted for prompt consumption. */
export interface FormattedOutcome {
  success: boolean;
  description: string;
  errorType?: string;
  duration: number;
}

/** Formatted episode data included in the reflection output. */
export interface FormattedEpisode {
  id: string;
  task: string;
  actions: FormattedAction[];
  outcome: FormattedOutcome;
  reward: number;
}

/**
 * The complete micro-level reflection data package.
 *
 * Contains the failed episode, an optional contrastive success episode,
 * prior insights, and a prompt-ready analysis request for Claude.
 */
export interface MicroReflectionData {
  level: 'micro';
  /** The failed episode being reflected on. */
  failedEpisode: FormattedEpisode;
  /** Contrastive success episode for the same/similar task, if available. */
  contrastiveEpisode?: FormattedEpisode;
  /** Related insights from prior reflections in semantic memory. */
  priorInsights: string[];
  /** Prompt-ready analysis request for Claude. */
  analysisPrompt: string;
}

/** Configuration options for the MicroAssembler. */
export interface MicroAssemblerOptions {
  /** FileStore instance for reading episodes and reflections. */
  fileStore: FileStore;
  /** Logger instance. Falls back to a default logger if omitted. */
  logger?: Logger;
  /**
   * Minimum similarity score (0–1) for a successful episode to qualify
   * as a contrastive example. Defaults to `0.3`.
   */
  similarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assembles prompt-ready micro-level reflection data for a single failed
 * episode.
 *
 * The assembler:
 * 1. Loads the target episode from the `episodes` FileStore collection.
 * 2. Scans all episodes for a successful one with similar task text
 *    (contrastive example) using keyword + SimHash similarity.
 * 3. Searches the `reflections` collection for prior insights related to
 *    the task.
 * 4. Formats everything into a {@link MicroReflectionData} structure with
 *    an `analysisPrompt` that guides Claude through failure diagnosis.
 */
export class MicroAssembler {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly similarityThreshold: number;

  constructor(options: MicroAssemblerOptions) {
    this.fileStore = options.fileStore;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:micro' });
    this.similarityThreshold = options.similarityThreshold ?? 0.3;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Assemble micro-level reflection data for a single episode.
   *
   * @param input - Must contain the `episodeId` of the episode to reflect on.
   * @returns Structured reflection data ready for Claude to analyse.
   * @throws If the episode cannot be found.
   */
  async assemble(input: MicroReflectionInput): Promise<MicroReflectionData> {
    const { episodeId } = input;

    this.logger.debug('Assembling micro reflection', { episodeId });

    // 1. Load the target episode
    const episode = await this.fileStore.read<Episode>('episodes', episodeId);
    if (!episode) {
      throw new Error(`Episode not found: ${episodeId}`);
    }

    // 2. Find a contrastive (successful) episode for the same/similar task
    const contrastive = await this.findContrastiveEpisode(episode);

    // 3. Gather prior insights from reflections
    const priorInsights = await this.gatherPriorInsights(episode.task);

    // 4. Format everything into the output structure
    const failedEpisode = this.formatEpisode(episode);
    const contrastiveEpisode = contrastive
      ? this.formatEpisode(contrastive)
      : undefined;

    const analysisPrompt = this.buildAnalysisPrompt(
      failedEpisode,
      contrastiveEpisode,
      priorInsights,
    );

    this.logger.info('Micro reflection assembled', {
      episodeId,
      hasContrastive: !!contrastiveEpisode,
      priorInsightCount: priorInsights.length,
    });

    return {
      level: 'micro',
      failedEpisode,
      contrastiveEpisode,
      priorInsights,
      analysisPrompt,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Search all episodes for a successful one whose task is similar to the
   * failed episode's task. Returns the best match above the similarity
   * threshold, or `null` if none qualifies.
   */
  private async findContrastiveEpisode(
    failedEpisode: Episode,
  ): Promise<Episode | null> {
    const allEpisodes = await this.fileStore.readAll<Episode>('episodes');

    const queryEmbedding = getEmbedding(failedEpisode.task);

    let bestMatch: Episode | null = null;
    let bestScore = -1;

    for (const candidate of allEpisodes) {
      // Skip the episode itself
      if (candidate.id === failedEpisode.id) continue;

      // Only consider successful episodes
      if (!candidate.outcome.success) continue;

      const candidateEmbedding = getEmbedding(candidate.task);
      const score = combinedSimilarity(queryEmbedding, candidateEmbedding);

      if (score > bestScore && score >= this.similarityThreshold) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      this.logger.debug('Found contrastive episode', {
        contrastiveId: bestMatch.id,
        similarity: Math.round(bestScore * 1000) / 1000,
      });
    }

    return bestMatch;
  }

  /**
   * Search the `reflections` collection for prior insights related to
   * the given task. Returns actionable insight strings extracted from
   * matching reflections.
   */
  private async gatherPriorInsights(task: string): Promise<string[]> {
    const allReflections =
      await this.fileStore.readAll<Reflection>('reflections');

    if (allReflections.length === 0) return [];

    const queryEmbedding = getEmbedding(task);
    const insights: string[] = [];

    for (const reflection of allReflections) {
      const refEmbedding = getEmbedding(reflection.content);
      const score = combinedSimilarity(queryEmbedding, refEmbedding);

      if (score >= this.similarityThreshold) {
        // Collect actionable insights from matching reflections
        for (const insight of reflection.actionableInsights) {
          if (!insights.includes(insight)) {
            insights.push(insight);
          }
        }

        // If the reflection has no structured insights, use its content
        if (reflection.actionableInsights.length === 0) {
          insights.push(reflection.content);
        }
      }
    }

    return insights;
  }

  /**
   * Convert a raw Episode into the formatted shape expected by the
   * reflection output.
   */
  private formatEpisode(episode: Episode): FormattedEpisode {
    return {
      id: episode.id,
      task: episode.task,
      actions: episode.actions.map((action, index) => ({
        step: index + 1,
        type: action.type,
        description: action.description,
        success: action.success,
        result: action.result,
      })),
      outcome: {
        success: episode.outcome.success,
        description: episode.outcome.description,
        errorType: episode.outcome.errorType,
        duration: episode.outcome.duration,
      },
      reward: episode.reward,
    };
  }

  /**
   * Build the prompt-ready analysis request that guides Claude through
   * diagnosing the failure.
   */
  private buildAnalysisPrompt(
    failedEpisode: FormattedEpisode,
    contrastiveEpisode: FormattedEpisode | undefined,
    priorInsights: string[],
  ): string {
    const sections: string[] = [];

    // ── Header ────────────────────────────────────────────────────────
    sections.push(
      '# Micro-Level Failure Analysis',
      '',
      'Analyse the following failed episode and produce a structured reflection.',
      '',
    );

    // ── Failed episode ────────────────────────────────────────────────
    sections.push(
      '## Failed Episode',
      '',
      `**Task:** ${failedEpisode.task}`,
      `**Reward:** ${failedEpisode.reward}`,
      `**Error type:** ${failedEpisode.outcome.errorType ?? 'unspecified'}`,
      `**Outcome:** ${failedEpisode.outcome.description}`,
      `**Duration:** ${failedEpisode.outcome.duration}ms`,
      '',
      '### Action Log',
      '',
    );

    for (const action of failedEpisode.actions) {
      const status = action.success ? 'OK' : 'FAIL';
      let line = `${action.step}. [${status}] (${action.type}) ${action.description}`;
      if (action.result) {
        line += ` — result: ${action.result}`;
      }
      sections.push(line);
    }
    sections.push('');

    // ── Contrastive episode ───────────────────────────────────────────
    if (contrastiveEpisode) {
      sections.push(
        '## Contrastive Success Episode',
        '',
        `**Task:** ${contrastiveEpisode.task}`,
        `**Reward:** ${contrastiveEpisode.reward}`,
        `**Outcome:** ${contrastiveEpisode.outcome.description}`,
        `**Duration:** ${contrastiveEpisode.outcome.duration}ms`,
        '',
        '### Action Log',
        '',
      );

      for (const action of contrastiveEpisode.actions) {
        const status = action.success ? 'OK' : 'FAIL';
        let line = `${action.step}. [${status}] (${action.type}) ${action.description}`;
        if (action.result) {
          line += ` — result: ${action.result}`;
        }
        sections.push(line);
      }
      sections.push('');
    }

    // ── Prior insights ────────────────────────────────────────────────
    if (priorInsights.length > 0) {
      sections.push(
        '## Prior Insights',
        '',
        'Related lessons from previous reflections:',
        '',
      );
      for (const insight of priorInsights) {
        sections.push(`- ${insight}`);
      }
      sections.push('');
    }

    // ── Analysis instructions ─────────────────────────────────────────
    sections.push(
      '## Instructions',
      '',
      'Produce a structured analysis covering:',
      '',
      '1. **Root cause** — What was the primary reason for failure?',
      '2. **Error taxonomy** — Classify the error type(s) (e.g. logic-error, missing-context, wrong-tool, timeout).',
      '3. **Critical step** — Which action step was the point of divergence or first mistake?',
    );

    if (contrastiveEpisode) {
      sections.push(
        '4. **Contrastive diff** — What did the successful attempt do differently? Identify the key divergence points.',
        '5. **Actionable insights** — Concrete, reusable lessons to prevent this failure class in the future.',
        '6. **Confidence** — Rate your confidence in this analysis from 0 to 1.',
      );
    } else {
      sections.push(
        '4. **Actionable insights** — Concrete, reusable lessons to prevent this failure class in the future.',
        '5. **Confidence** — Rate your confidence in this analysis from 0 to 1.',
      );
    }

    return sections.join('\n');
  }
}
