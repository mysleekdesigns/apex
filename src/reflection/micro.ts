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

/** Reflexion-style structured reflection template. */
export interface ReflexionTemplate {
  /** What went wrong (or what went right for success reflections). */
  what_happened: string;
  /** Root cause analysis. */
  root_cause: string;
  /** Concrete next step to try. */
  what_to_try_next: string;
  /** Confidence in this analysis (0-1). */
  confidence: number;
  /** Whether this reflects on a success or failure. */
  type: 'success' | 'failure';
}

/** Extended micro reflection data that includes Reflexion-style template. */
export interface ReflexionMicroData extends MicroReflectionData {
  /** Structured template fields for Reflexion-style reflection. */
  reflexionTemplate: ReflexionTemplate;
  /** Verbal reward signal derived from the episode. */
  verbalReward: string;
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

  /**
   * Assemble Reflexion-style micro-level reflection data for a single episode.
   *
   * Unlike {@link assemble}, this method handles both successful and failed
   * episodes and produces a structured {@link ReflexionTemplate} alongside
   * the standard reflection data.
   *
   * @param input - Must contain the `episodeId` of the episode to reflect on.
   * @returns Extended reflection data with Reflexion template and verbal reward.
   * @throws If the episode cannot be found.
   */
  async assembleReflexion(
    input: MicroReflectionInput,
  ): Promise<ReflexionMicroData> {
    const { episodeId } = input;

    this.logger.debug('Assembling Reflexion micro reflection', { episodeId });

    // 1. Load the target episode
    const episode = await this.fileStore.read<Episode>('episodes', episodeId);
    if (!episode) {
      throw new Error(`Episode not found: ${episodeId}`);
    }

    const isSuccess = episode.outcome.success;
    const formattedEpisode = this.formatEpisode(episode);

    // 2. Find contrastive episode only for failures
    let contrastiveEpisode: FormattedEpisode | undefined;
    if (!isSuccess) {
      const contrastive = await this.findContrastiveEpisode(episode);
      contrastiveEpisode = contrastive
        ? this.formatEpisode(contrastive)
        : undefined;
    }

    // 3. Gather prior insights
    const priorInsights = await this.gatherPriorInsights(episode.task);

    // 4. Build the Reflexion template
    const reflexionTemplate = this.buildReflexionTemplate(
      formattedEpisode,
      contrastiveEpisode,
      priorInsights,
    );

    // 5. Generate verbal reward signal
    const verbalReward = this.buildVerbalReward(
      formattedEpisode,
      reflexionTemplate,
    );

    // 6. Build the enriched analysis prompt
    const analysisPrompt = this.buildReflexionPrompt(
      formattedEpisode,
      contrastiveEpisode,
      priorInsights,
      reflexionTemplate,
    );

    this.logger.info('Reflexion micro reflection assembled', {
      episodeId,
      type: reflexionTemplate.type,
      hasContrastive: !!contrastiveEpisode,
      priorInsightCount: priorInsights.length,
    });

    return {
      level: 'micro',
      failedEpisode: formattedEpisode,
      contrastiveEpisode,
      priorInsights,
      analysisPrompt,
      reflexionTemplate,
      verbalReward,
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

  /**
   * Build a {@link ReflexionTemplate} by analysing the episode's outcome,
   * actions, and available contrastive/insight data.
   */
  private buildReflexionTemplate(
    episode: FormattedEpisode,
    contrastiveEpisode: FormattedEpisode | undefined,
    priorInsights: string[],
  ): ReflexionTemplate {
    const isSuccess = episode.outcome.success;

    if (isSuccess) {
      return {
        what_happened: episode.outcome.description,
        root_cause: 'N/A',
        what_to_try_next: 'Continue this approach',
        confidence: 0.8,
        type: 'success',
      };
    }

    // Failure path: extract root cause from error type and action log
    const failedActions = episode.actions.filter((a) => !a.success);
    const errorType = episode.outcome.errorType ?? 'unknown';
    const rootCause =
      failedActions.length > 0
        ? `${errorType}: step ${failedActions[0].step} (${failedActions[0].type}) — ${failedActions[0].description}`
        : `${errorType}: ${episode.outcome.description}`;

    // Derive next step from contrastive episode or prior insights
    let whatToTryNext: string;
    if (contrastiveEpisode) {
      const divergenceStep = this.findDivergenceStep(
        episode,
        contrastiveEpisode,
      );
      whatToTryNext = divergenceStep
        ? `At step ${divergenceStep.step}, try: (${divergenceStep.type}) ${divergenceStep.description}`
        : `Follow the approach from the successful episode: ${contrastiveEpisode.outcome.description}`;
    } else if (priorInsights.length > 0) {
      whatToTryNext = priorInsights[0];
    } else {
      whatToTryNext = `Address the ${errorType} error and retry with corrected approach`;
    }

    return {
      what_happened: episode.outcome.description,
      root_cause: rootCause,
      what_to_try_next: whatToTryNext,
      confidence: contrastiveEpisode ? 0.7 : priorInsights.length > 0 ? 0.5 : 0.3,
      type: 'failure',
    };
  }

  /**
   * Find the first action step in the contrastive episode that diverges from
   * the failed episode's action sequence. Returns the contrastive episode's
   * action at the divergence point, or `null` if no clear divergence is found.
   */
  private findDivergenceStep(
    failed: FormattedEpisode,
    contrastive: FormattedEpisode,
  ): FormattedAction | null {
    const minLen = Math.min(failed.actions.length, contrastive.actions.length);

    for (let i = 0; i < minLen; i++) {
      const fa = failed.actions[i];
      const ca = contrastive.actions[i];

      // Divergence: same step position but different type, description, or success
      if (fa.type !== ca.type || fa.success !== ca.success) {
        return ca;
      }
    }

    // If the contrastive episode has more steps, the first extra step is the divergence
    if (contrastive.actions.length > failed.actions.length) {
      return contrastive.actions[failed.actions.length];
    }

    return null;
  }

  /**
   * Generate a natural language verbal reward signal summarising the episode
   * outcome in a single sentence.
   */
  private buildVerbalReward(
    episode: FormattedEpisode,
    template: ReflexionTemplate,
  ): string {
    if (template.type === 'success') {
      const approachSummary = episode.actions
        .map((a) => a.description)
        .join(', ');
      return `When doing ${episode.task}, approach [${approachSummary}] succeeded because ${episode.outcome.description}.`;
    }

    return `When doing ${episode.task}, the approach failed because ${template.root_cause}. Next time try: ${template.what_to_try_next}.`;
  }

  /**
   * Build a structured Reflexion-style analysis prompt that includes the
   * template fields as a JSON block and explicit instructions for filling
   * in each field.
   */
  private buildReflexionPrompt(
    episode: FormattedEpisode,
    contrastiveEpisode: FormattedEpisode | undefined,
    priorInsights: string[],
    template: ReflexionTemplate,
  ): string {
    const sections: string[] = [];

    const isSuccess = template.type === 'success';
    const heading = isSuccess
      ? '# Reflexion: Success Analysis'
      : '# Reflexion: Failure Analysis';

    // ── Header ────────────────────────────────────────────────────────
    sections.push(
      heading,
      '',
      'Analyse the following episode and produce a structured Reflexion.',
      '',
    );

    // ── Episode details ──────────────────────────────────────────────
    sections.push(
      '## Episode',
      '',
      `**Task:** ${episode.task}`,
      `**Reward:** ${episode.reward}`,
      `**Outcome:** ${episode.outcome.description}`,
      `**Duration:** ${episode.outcome.duration}ms`,
    );

    if (!isSuccess) {
      sections.push(
        `**Error type:** ${episode.outcome.errorType ?? 'unspecified'}`,
      );
    }

    sections.push('', '### Action Log', '');

    for (const action of episode.actions) {
      const status = action.success ? 'OK' : 'FAIL';
      let line = `${action.step}. [${status}] (${action.type}) ${action.description}`;
      if (action.result) {
        line += ` — result: ${action.result}`;
      }
      sections.push(line);
    }
    sections.push('');

    // ── Contrastive episode ─────────────────────────────────────────
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

    // ── Prior insights ──────────────────────────────────────────────
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

    // ── Reflexion template ──────────────────────────────────────────
    sections.push(
      '## Reflexion Template',
      '',
      'Current structured analysis (refine as needed):',
      '',
      '```json',
      JSON.stringify(template, null, 2),
      '```',
      '',
    );

    // ── Instructions ────────────────────────────────────────────────
    sections.push(
      '## Instructions',
      '',
      'Fill in the Reflexion template fields:',
      '',
      '1. **what_happened** — Describe what went wrong (or right for successes).',
      '2. **root_cause** — Identify the root cause of the outcome.',
      '3. **what_to_try_next** — Provide a concrete, actionable next step.',
      '4. **confidence** — Rate your confidence in this analysis from 0 to 1.',
      '',
      'Produce a one-sentence verbal reward in the format:',
      `"When doing [task], approach [actions] ${isSuccess ? 'succeeded' : 'failed'} because [root_cause]. Next time [what_to_try_next]."`,
    );

    return sections.join('\n');
  }
}
