/**
 * APEX Plan Context Builder
 *
 * Assembles experience-backed planning context for a given task by:
 * 1. Retrieving past episodes that are similar to the current task
 * 2. Ranking approaches by success rate and recency
 * 3. Extracting known pitfalls and anti-patterns
 * 4. Suggesting applicable skills from procedural memory
 * 5. Surfacing actionable insights from stored reflections
 *
 * All operations are pure data reads — no LLM calls.
 */

import type { Episode, Action, Outcome, Reflection } from '../types.js';
import type { FileStore } from '../utils/file-store.js';
import type { MemoryManager } from '../memory/manager.js';
import { extractKeywords, simHash } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * The structured context returned to Claude for reasoning over a task.
 */
export interface PlanContext {
  /** The task being planned. */
  task: string;

  /** Past episodes that attempted similar tasks, ranked by relevance. */
  pastAttempts: PastAttempt[];

  /** Known failure modes extracted from failed episodes. */
  knownPitfalls: Pitfall[];

  /** Skills from procedural memory that may apply to this task. */
  applicableSkills: ApplicableSkill[];

  /** Actionable insights from stored reflections. */
  relevantInsights: string[];

  /** Verbal reflection lessons injected from past reflections. */
  lessonsLearned: LessonLearned[];

  /**
   * Best past approach description if one exists (from the highest-ranked
   * successful episode), or `null` on cold start.
   */
  suggestedApproach: string | null;

  /**
   * Confidence in the plan context, in `[0, 1]`.
   * - `0` = cold start (no relevant history)
   * - `1` = rich history with many successful past attempts
   */
  confidence: number;
}

/** A past episode that attempted a similar task. */
export interface PastAttempt {
  episodeId: string;
  task: string;
  outcome: Outcome;
  reward: number;
  timestamp: number;
  /** Similarity score between this episode's task and the query task. */
  similarity: number;
  actions: Action[];
}

/** A recurring failure mode extracted from failed episodes. */
export interface Pitfall {
  description: string;
  errorType: string;
  /** How many times this failure mode has been observed. */
  frequency: number;
  /** Timestamp of the most recent occurrence. */
  lastSeen: number;
}

/** A verbal reflection lesson relevant to the current task. */
export interface LessonLearned {
  /** The lesson text (natural language). */
  lesson: string;
  /** How relevant this lesson is to the current task (0-1). */
  relevance: number;
  /** The reflection level it came from (micro/meso/macro). */
  level: string;
  /** When the lesson was learned. */
  timestamp: number;
  /** Source reflection ID. */
  reflectionId: string;
}

/** A skill from procedural memory that may help with the task. */
export interface ApplicableSkill {
  skillId: string;
  name: string;
  description: string;
  successRate: number;
  confidence: number;
  /** How relevant this skill is to the current task, in `[0, 1]`. */
  relevance: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for the PlanContextBuilder. */
export interface PlanContextOptions {
  fileStore: FileStore;
  memoryManager: MemoryManager;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum similarity score for an episode to be considered relevant. */
const SIMILARITY_THRESHOLD = 0.15;

/** Maximum number of past attempts to include in the context. */
const MAX_PAST_ATTEMPTS = 10;

/** Maximum number of skills to include. */
const MAX_SKILLS = 5;

/** Maximum number of reflections to scan. */
const MAX_REFLECTIONS = 50;

/** Maximum number of verbal reflection lessons to inject. */
const MAX_LESSONS = 5;

/** Half-life for recency decay in milliseconds (7 days). */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Number of episodes considered "rich history" for confidence scoring. */
const RICH_HISTORY_THRESHOLD = 20;

// ---------------------------------------------------------------------------
// Plan Context Builder
// ---------------------------------------------------------------------------

/**
 * Builds experience-backed planning context for a task.
 *
 * Given a task description, queries episodic memory, reflections, and skills
 * to assemble a structured context that helps Claude reason about how to
 * approach the task.
 */
export class PlanContextBuilder {
  private readonly fileStore: FileStore;
  private readonly memoryManager: MemoryManager;
  private readonly logger: Logger;

  constructor(opts: PlanContextOptions) {
    this.fileStore = opts.fileStore;
    this.memoryManager = opts.memoryManager;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:plan-context' });
  }

  /**
   * Build planning context for a task.
   *
   * Loads episodes, finds similar ones, extracts pitfalls, queries skills,
   * and surfaces relevant insights from reflections.
   *
   * @param task - The task description to build context for.
   * @returns Structured plan context for Claude to reason over.
   */
  async getContext(task: string): Promise<PlanContext> {
    this.logger.info('Building plan context', { task });

    // Run independent data loads in parallel
    const [episodes, reflections, skillResults] = await Promise.all([
      this.fileStore.readAll<Episode>('episodes'),
      this.loadReflections(),
      this.memoryManager.searchSkills(task, MAX_SKILLS),
    ]);

    // Compute similarity for each episode against the task
    const taskKeywords = extractKeywords(task);
    const taskSimhash = simHash(task);
    const taskInput = { keywords: taskKeywords, simhash: taskSimhash };

    const scored = episodes.map((episode) => {
      const epKeywords = extractKeywords(episode.task);
      const epSimhash = simHash(episode.task);
      const similarity = combinedSimilarity(taskInput, {
        keywords: epKeywords,
        simhash: epSimhash,
      });
      return { episode, similarity };
    });

    // Filter by similarity threshold
    const relevant = scored.filter((s) => s.similarity >= SIMILARITY_THRESHOLD);

    // Rank by combined score: similarity * recency * success boost
    const now = Date.now();
    const ranked = relevant
      .map(({ episode, similarity }) => ({
        episode,
        similarity,
        score: this.computeRankingScore(episode, similarity, now),
      }))
      .sort((a, b) => b.score - a.score);

    // Build past attempts (top N)
    const pastAttempts = ranked.slice(0, MAX_PAST_ATTEMPTS).map(({ episode, similarity }) =>
      this.toPastAttempt(episode, similarity),
    );

    // Extract pitfalls from failed episodes
    const failedEpisodes = relevant
      .filter(({ episode }) => !episode.outcome.success)
      .map(({ episode }) => episode);
    const knownPitfalls = this.extractPitfalls(failedEpisodes);

    // Map skills
    const applicableSkills = skillResults.map(({ skill, score }) => ({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      successRate: skill.successRate,
      confidence: skill.confidence,
      relevance: score,
    }));

    // Surface relevant insights from reflections
    const relevantInsights = this.extractInsights(reflections, taskKeywords);

    // Extract typed lesson objects from verbal reflections
    const lessonsLearned = this.extractLessons(reflections, taskKeywords, taskSimhash);

    // Determine suggested approach from highest-ranked successful episode
    const bestSuccess = ranked.find(({ episode }) => episode.outcome.success);
    const suggestedApproach = bestSuccess
      ? this.summarizeApproach(bestSuccess.episode)
      : null;

    // Compute overall confidence based on amount of relevant data
    const confidence = this.computeConfidence(
      relevant.length,
      applicableSkills.length,
      lessonsLearned.length,
    );

    const context: PlanContext = {
      task,
      pastAttempts,
      knownPitfalls,
      applicableSkills,
      relevantInsights,
      lessonsLearned,
      suggestedApproach,
      confidence,
    };

    this.logger.info('Plan context built', {
      pastAttempts: pastAttempts.length,
      pitfalls: knownPitfalls.length,
      skills: applicableSkills.length,
      insights: relevantInsights.length,
      lessons: lessonsLearned.length,
      confidence,
    });

    return context;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Load reflections from the file store, capped at MAX_REFLECTIONS.
   */
  private async loadReflections(): Promise<Reflection[]> {
    const ids = await this.fileStore.list('reflections');
    const toLoad = ids.slice(-MAX_REFLECTIONS); // most recent IDs (files tend to be ordered)
    const reflections: Reflection[] = [];
    for (const id of toLoad) {
      const r = await this.fileStore.read<Reflection>('reflections', id);
      if (r) reflections.push(r);
    }
    return reflections;
  }

  /**
   * Compute a ranking score that combines similarity, recency, and success.
   *
   * - Similarity is the primary signal.
   * - Recency applies exponential decay (half-life = 7 days).
   * - Successful episodes get a 1.5x boost; failed ones get a 0.8x weight
   *   (still relevant because we learn from failures).
   */
  private computeRankingScore(
    episode: Episode,
    similarity: number,
    now: number,
  ): number {
    const ageMs = now - episode.timestamp;
    const recencyWeight = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    const successWeight = episode.outcome.success ? 1.5 : 0.8;

    return similarity * recencyWeight * successWeight;
  }

  /**
   * Convert an Episode into a PastAttempt.
   */
  private toPastAttempt(episode: Episode, similarity: number): PastAttempt {
    return {
      episodeId: episode.id,
      task: episode.task,
      outcome: episode.outcome,
      reward: episode.reward,
      timestamp: episode.timestamp,
      similarity,
      actions: episode.actions,
    };
  }

  /**
   * Extract pitfall patterns from failed episodes.
   *
   * Groups failures by `errorType`, counts frequency, and tracks the most
   * recent occurrence of each error type.
   */
  private extractPitfalls(failedEpisodes: Episode[]): Pitfall[] {
    const pitfallMap = new Map<
      string,
      { description: string; frequency: number; lastSeen: number }
    >();

    for (const episode of failedEpisodes) {
      const errorType = episode.outcome.errorType ?? 'unknown';
      const existing = pitfallMap.get(errorType);

      if (existing) {
        existing.frequency++;
        existing.lastSeen = Math.max(existing.lastSeen, episode.timestamp);
        // Keep the most descriptive failure description (longest)
        if (episode.outcome.description.length > existing.description.length) {
          existing.description = episode.outcome.description;
        }
      } else {
        pitfallMap.set(errorType, {
          description: episode.outcome.description,
          frequency: 1,
          lastSeen: episode.timestamp,
        });
      }
    }

    return Array.from(pitfallMap.entries())
      .map(([errorType, data]) => ({
        errorType,
        description: data.description,
        frequency: data.frequency,
        lastSeen: data.lastSeen,
      }))
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Extract actionable insights from reflections that are relevant to the
   * current task.
   *
   * Uses keyword overlap to determine relevance, then collects
   * `actionableInsights` from matching reflections.
   */
  private extractInsights(
    reflections: Reflection[],
    taskKeywords: string[],
  ): string[] {
    const taskKeywordSet = new Set(taskKeywords);
    const insights: Array<{ text: string; relevance: number; timestamp: number }> = [];

    for (const reflection of reflections) {
      // Check keyword overlap between the reflection content and the task
      const reflectionKeywords = new Set(extractKeywords(reflection.content));
      let overlap = 0;
      for (const kw of taskKeywordSet) {
        if (reflectionKeywords.has(kw)) overlap++;
      }

      if (taskKeywordSet.size === 0) continue;

      const relevance = overlap / taskKeywordSet.size;

      // Include insights from reflections with any keyword overlap
      if (relevance > 0) {
        for (const insight of reflection.actionableInsights) {
          insights.push({
            text: insight,
            relevance,
            timestamp: reflection.timestamp,
          });
        }
      }
    }

    // Deduplicate insights by text, keeping highest relevance
    const deduped = new Map<string, { relevance: number; timestamp: number }>();
    for (const { text, relevance, timestamp } of insights) {
      const existing = deduped.get(text);
      if (!existing || relevance > existing.relevance) {
        deduped.set(text, { relevance, timestamp });
      }
    }

    // Sort by relevance descending, then by recency
    return Array.from(deduped.entries())
      .sort((a, b) => {
        const relDiff = b[1].relevance - a[1].relevance;
        if (relDiff !== 0) return relDiff;
        return b[1].timestamp - a[1].timestamp;
      })
      .map(([text]) => text);
  }

  /**
   * Extract typed lesson objects from verbal reflections.
   *
   * Uses `combinedSimilarity` to score each reflection against the task,
   * then extracts individual `actionableInsights` as `LessonLearned` entries.
   * Results are sorted by relevance and capped at `MAX_LESSONS`.
   */
  private extractLessons(
    reflections: Reflection[],
    taskKeywords: string[],
    taskSimhash: bigint,
  ): LessonLearned[] {
    const taskInput = { keywords: taskKeywords, simhash: taskSimhash };
    const lessons: LessonLearned[] = [];

    for (const reflection of reflections) {
      const refKeywords = extractKeywords(reflection.content);
      const refSimhash = simHash(reflection.content);
      const relevance = combinedSimilarity(taskInput, {
        keywords: refKeywords,
        simhash: refSimhash,
      });

      if (relevance < SIMILARITY_THRESHOLD) continue;

      for (const insight of reflection.actionableInsights) {
        lessons.push({
          lesson: insight,
          relevance,
          level: reflection.level,
          timestamp: reflection.timestamp,
          reflectionId: reflection.id,
        });
      }
    }

    // Sort by relevance descending, then by recency
    lessons.sort((a, b) => {
      const relDiff = b.relevance - a.relevance;
      if (relDiff !== 0) return relDiff;
      return b.timestamp - a.timestamp;
    });

    return lessons.slice(0, MAX_LESSONS);
  }

  /**
   * Summarize the approach taken in a successful episode.
   *
   * Produces a concise description of the actions taken and the outcome.
   */
  private summarizeApproach(episode: Episode): string {
    const actionSummaries = episode.actions
      .filter((a) => a.success)
      .map((a) => a.description);

    if (actionSummaries.length === 0) {
      return `Task "${episode.task}" succeeded: ${episode.outcome.description}`;
    }

    const steps = actionSummaries.length <= 5
      ? actionSummaries.join(' -> ')
      : [
          ...actionSummaries.slice(0, 3),
          `... (${actionSummaries.length - 4} more steps)`,
          actionSummaries[actionSummaries.length - 1],
        ].join(' -> ');

    return `${steps} | Outcome: ${episode.outcome.description}`;
  }

  /**
   * Compute overall confidence in the plan context.
   *
   * Based on how many relevant episodes and skills we found. Scales from
   * 0 (cold start) to 1 (rich history).
   */
  private computeConfidence(
    relevantEpisodeCount: number,
    applicableSkillCount: number,
    lessonCount: number = 0,
  ): number {
    // Episode contribution: logarithmic scale, saturates around RICH_HISTORY_THRESHOLD
    const episodeScore = Math.min(
      1,
      Math.log(1 + relevantEpisodeCount) / Math.log(1 + RICH_HISTORY_THRESHOLD),
    );

    // Skill contribution: up to 0.2 bonus for having applicable skills
    const skillBonus = Math.min(0.2, applicableSkillCount * 0.05);

    // Lesson contribution: small boost if we have reflected on similar work
    const lessonBonus = lessonCount > 0 ? 0.1 : 0;

    return Math.min(1, episodeScore + skillBonus + lessonBonus);
  }
}
