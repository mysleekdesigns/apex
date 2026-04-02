/**
 * Skill Extractor — Phase 5 of APEX Agent Self-Learning System
 *
 * Identifies reusable action patterns from successful episode trajectories,
 * abstracts them into parameterized skills, and detects skill composition
 * chains.
 *
 * The extraction pipeline:
 * 1. Filter successful episodes from the input set.
 * 2. Extract action-type n-grams (subsequences) from each trajectory.
 * 3. Group identical n-grams and count frequency across episodes.
 * 4. Abstract frequent patterns by replacing concrete values with placeholders.
 * 5. Score candidates by frequency * success rate.
 * 6. Detect chains of skills that commonly co-occur in successful episodes.
 */

import type { Episode, Action, Skill } from '../types.js';
import { generateId } from '../types.js';
import { extractKeywords } from '../utils/embeddings.js';
import { jaccardSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A recurring action subsequence discovered across successful episodes.
 */
export interface ActionPattern {
  /** The action sequence with parameterized description templates. */
  actions: Array<{ type: string; descriptionTemplate: string }>;

  /** How many episodes contain this pattern. */
  frequency: number;

  /** Success rate of episodes containing this pattern. */
  successRate: number;

  /** IDs of the episodes this pattern was found in. */
  sourceEpisodeIds: string[];
}

/**
 * A skill candidate extracted from recurring action patterns, pending
 * verification and conversion to a full Skill.
 */
export interface SkillCandidate {
  /** Auto-generated name derived from the action types in the pattern. */
  name: string;

  /** Human-readable description generated from the pattern. */
  description: string;

  /** The underlying action pattern this candidate was derived from. */
  pattern: ActionPattern;

  /** Preconditions inferred from common task context. */
  preconditions: string[];

  /** Confidence score based on frequency and success rate. */
  confidence: number;

  /** Tags inferred from action types and task domains. */
  tags: string[];
}

/**
 * An ordered sequence of skills that commonly occur together in
 * successful episodes.
 */
export interface SkillChain {
  /** Ordered skill IDs/names that form the chain. */
  skills: string[];

  /** How many episodes contain this chain. */
  frequency: number;

  /** Success rate of episodes containing this chain. */
  successRate: number;
}

/**
 * Configuration options for the SkillExtractor.
 */
export interface SkillExtractorOptions {
  /** Minimum number of occurrences for a pattern to be considered. Defaults to `2`. */
  minFrequency?: number;

  /** Minimum success rate for a pattern to qualify. Defaults to `0.6`. */
  minSuccessRate?: number;

  /** Maximum number of actions in a pattern. Defaults to `5`. */
  maxPatternLength?: number;

  /** Minimum number of actions in a pattern. Defaults to `2`. */
  minPatternLength?: number;

  /** Similarity threshold for matching similar action descriptions. Defaults to `0.7`. */
  similarityThreshold?: number;

  /** Project name for generated skills. Defaults to `"unknown"`. */
  projectName?: string;

  /** Logger instance. Falls back to a default logger if omitted. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Regex patterns for values that should be replaced with `<param>` placeholders
 * when abstracting action descriptions.
 */
const PARAM_PATTERNS: Array<{ regex: RegExp; placeholder: string }> = [
  // File paths (Unix and Windows)
  { regex: /(?:\/[\w.-]+){2,}(?:\.\w+)?/g, placeholder: '<path>' },
  // Quoted strings
  { regex: /"[^"]+"/g, placeholder: '<string>' },
  { regex: /'[^']+'/g, placeholder: '<string>' },
  // Numbers (standalone)
  { regex: /\b\d{2,}\b/g, placeholder: '<number>' },
  // camelCase or PascalCase identifiers that look like variable/function names
  { regex: /\b[a-z][a-zA-Z0-9]{8,}\b/g, placeholder: '<identifier>' },
];

/**
 * Replace concrete values in an action description with generic placeholders.
 */
function parameterizeDescription(description: string): string {
  let result = description;
  for (const { regex, placeholder } of PARAM_PATTERNS) {
    result = result.replace(regex, placeholder);
  }
  return result;
}

/**
 * Build a human-readable name from an array of action types.
 *
 * E.g. `["code_edit", "command", "code_edit"]` becomes `"code-edit-then-command-then-code-edit"`.
 */
function buildPatternName(actionTypes: string[]): string {
  return actionTypes
    .map((t) => t.replace(/[_\s]+/g, '-').toLowerCase())
    .join('-then-');
}

/**
 * Create a serialisable key from an action-type sequence for grouping.
 */
function ngramKey(types: string[]): string {
  return types.join('|');
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Extracts reusable skill patterns from successful episode trajectories.
 *
 * Usage:
 * ```ts
 * const extractor = new SkillExtractor({ projectName: 'my-project' });
 * const candidates = extractor.extract(episodes);
 * const skills = candidates.map(c => extractor.toSkill(c));
 * ```
 */
export class SkillExtractor {
  private readonly minFrequency: number;
  private readonly minSuccessRate: number;
  private readonly maxPatternLength: number;
  private readonly minPatternLength: number;
  private readonly similarityThreshold: number;
  private readonly projectName: string;
  private readonly logger: Logger;

  constructor(options: SkillExtractorOptions = {}) {
    this.minFrequency = options.minFrequency ?? 2;
    this.minSuccessRate = options.minSuccessRate ?? 0.6;
    this.maxPatternLength = options.maxPatternLength ?? 5;
    this.minPatternLength = options.minPatternLength ?? 2;
    this.similarityThreshold = options.similarityThreshold ?? 0.7;
    this.projectName = options.projectName ?? 'unknown';
    this.logger = options.logger ?? new Logger({ prefix: 'apex:skill-extractor' });
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Main entry point: find patterns across episodes, abstract them into
   * parameterized skill candidates, and return those that meet the
   * frequency and success-rate thresholds.
   *
   * @param episodes - The full set of episodes to mine for patterns.
   * @returns Skill candidates sorted by confidence (descending).
   */
  extract(episodes: Episode[]): SkillCandidate[] {
    this.logger.info('Starting skill extraction', { episodeCount: episodes.length });

    const patterns = this.findPatterns(episodes);
    this.logger.debug('Patterns found', { patternCount: patterns.length });

    const candidates: SkillCandidate[] = [];
    for (const pattern of patterns) {
      const candidate = this.abstractPattern(pattern, episodes);
      const confidence = this.verifyCandidate(candidate, episodes);
      candidate.confidence = confidence;

      if (confidence > 0) {
        candidates.push(candidate);
      }
    }

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    this.logger.info('Skill extraction complete', { candidateCount: candidates.length });
    return candidates;
  }

  /**
   * Find recurring action subsequences across successful episodes.
   *
   * Algorithm:
   * 1. Extract action type sequences from each successful episode.
   * 2. Generate n-grams of lengths `minPatternLength..maxPatternLength`.
   * 3. Group identical n-grams and count frequency.
   * 4. Filter by `minFrequency` and `minSuccessRate`.
   * 5. Collect full action details for each qualifying n-gram.
   *
   * @param episodes - Episodes to search for patterns.
   * @returns Action patterns that meet the frequency and success-rate thresholds.
   */
  findPatterns(episodes: Episode[]): ActionPattern[] {
    const successfulEpisodes = episodes.filter((e) => e.outcome.success);

    if (successfulEpisodes.length === 0) {
      this.logger.debug('No successful episodes to extract patterns from');
      return [];
    }

    // Map from n-gram key to { episode IDs, action details per occurrence }
    const ngramMap = new Map<
      string,
      {
        episodeIds: Set<string>;
        occurrences: Array<{ actions: Action[]; episodeId: string }>;
      }
    >();

    for (const episode of successfulEpisodes) {
      const types = episode.actions.map((a) => a.type);

      for (let len = this.minPatternLength; len <= this.maxPatternLength; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const gram = types.slice(start, start + len);
          const key = ngramKey(gram);

          let entry = ngramMap.get(key);
          if (!entry) {
            entry = { episodeIds: new Set(), occurrences: [] };
            ngramMap.set(key, entry);
          }

          // Only count once per episode per n-gram
          if (!entry.episodeIds.has(episode.id)) {
            entry.episodeIds.add(episode.id);
            entry.occurrences.push({
              actions: episode.actions.slice(start, start + len),
              episodeId: episode.id,
            });
          }
        }
      }
    }

    // Also check frequency in failed episodes to compute success rate
    const failedEpisodes = episodes.filter((e) => !e.outcome.success);
    const failedNgramCounts = new Map<string, number>();

    for (const episode of failedEpisodes) {
      const types = episode.actions.map((a) => a.type);

      for (let len = this.minPatternLength; len <= this.maxPatternLength; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const gram = types.slice(start, start + len);
          const key = ngramKey(gram);

          if (ngramMap.has(key)) {
            failedNgramCounts.set(key, (failedNgramCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }

    // Build ActionPattern objects for qualifying n-grams
    const patterns: ActionPattern[] = [];

    for (const [key, entry] of ngramMap) {
      const frequency = entry.episodeIds.size;
      if (frequency < this.minFrequency) continue;

      const failedCount = failedNgramCounts.get(key) ?? 0;
      const totalCount = frequency + failedCount;
      const successRate = frequency / totalCount;

      if (successRate < this.minSuccessRate) continue;

      // Build the action template from the first occurrence
      const firstOccurrence = entry.occurrences[0];
      const actions = firstOccurrence.actions.map((a) => ({
        type: a.type,
        descriptionTemplate: parameterizeDescription(a.description),
      }));

      patterns.push({
        actions,
        frequency,
        successRate,
        sourceEpisodeIds: [...entry.episodeIds],
      });
    }

    this.logger.debug('Pattern filtering complete', {
      total: ngramMap.size,
      qualifying: patterns.length,
    });

    return patterns;
  }

  /**
   * Abstract a raw action pattern into a skill candidate.
   *
   * Replaces concrete values in descriptions with `<param>` placeholders,
   * generates a human-readable name and description, and infers
   * preconditions from common task context across source episodes.
   *
   * @param pattern - The action pattern to abstract.
   * @param episodes - Full episode set (used for precondition inference).
   * @returns A SkillCandidate ready for verification.
   */
  abstractPattern(pattern: ActionPattern, episodes: Episode[]): SkillCandidate {
    const actionTypes = pattern.actions.map((a) => a.type);
    const name = buildPatternName(actionTypes);

    // Build description from the action templates
    const stepDescriptions = pattern.actions
      .map((a, i) => `${i + 1}. [${a.type}] ${a.descriptionTemplate}`)
      .join('\n');
    const description = `Pattern: ${actionTypes.join(' -> ')}\n\nSteps:\n${stepDescriptions}`;

    // Infer preconditions from common keywords across source episodes
    const preconditions = this.inferPreconditions(pattern.sourceEpisodeIds, episodes);

    // Infer tags from action types and task keywords
    const tags = this.inferTags(pattern, episodes);

    const confidence = pattern.frequency * pattern.successRate;

    return {
      name,
      description,
      pattern,
      preconditions,
      confidence,
      tags,
    };
  }

  /**
   * Verify that a skill candidate actually correlates with success.
   *
   * Computes a confidence score in `[0, 1]` based on:
   * - Pattern frequency (more occurrences = more confident)
   * - Success rate (higher = more confident)
   * - Consistency of the pattern across episodes (action description similarity)
   *
   * @param candidate - The skill candidate to verify.
   * @param episodes - Full episode set for cross-checking.
   * @returns Confidence score between 0 and 1.
   */
  verifyCandidate(candidate: SkillCandidate, episodes: Episode[]): number {
    const { pattern } = candidate;

    // Base confidence from frequency and success rate
    // Frequency contribution: log scale, capped at 1
    const frequencyScore = Math.min(1, Math.log2(pattern.frequency + 1) / 4);

    // Success rate contribution (already 0-1)
    const successScore = pattern.successRate;

    // Consistency: check how similar the action descriptions are across episodes
    const consistencyScore = this.measureConsistency(pattern, episodes);

    // Weighted combination
    const confidence = 0.3 * frequencyScore + 0.4 * successScore + 0.3 * consistencyScore;

    this.logger.debug('Candidate verification', {
      name: candidate.name,
      frequencyScore: Math.round(frequencyScore * 1000) / 1000,
      successScore: Math.round(successScore * 1000) / 1000,
      consistencyScore: Math.round(consistencyScore * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
    });

    return Math.min(1, Math.max(0, confidence));
  }

  /**
   * Detect sequences of skills that commonly occur together in successful
   * episodes.
   *
   * For each successful episode, maps its action sequence to known skills
   * (by matching action types), then finds skill-level n-grams that recur
   * across multiple episodes.
   *
   * @param skills - The set of known skills to look for.
   * @param episodes - Episodes to scan for skill chains.
   * @returns Skill chains sorted by frequency (descending).
   */
  detectChains(skills: Skill[], episodes: Episode[]): SkillChain[] {
    if (skills.length === 0 || episodes.length === 0) {
      return [];
    }

    const successfulEpisodes = episodes.filter((e) => e.outcome.success);
    if (successfulEpisodes.length === 0) return [];

    // Map each skill to its action type pattern for matching
    const skillPatterns = skills.map((skill) => ({
      skill,
      types: this.extractTypesFromSkillPattern(skill.pattern),
    }));

    // For each episode, find which skills appear and in what order
    const episodeSkillSequences: Array<{ skillNames: string[]; success: boolean }> = [];

    for (const episode of episodes) {
      const actionTypes = episode.actions.map((a) => a.type);
      const matchedSkills: Array<{ name: string; startIndex: number }> = [];

      for (const { skill, types } of skillPatterns) {
        if (types.length === 0) continue;

        // Find the skill pattern in the episode's action sequence
        for (let i = 0; i <= actionTypes.length - types.length; i++) {
          const slice = actionTypes.slice(i, i + types.length);
          if (slice.every((t, j) => t === types[j])) {
            matchedSkills.push({ name: skill.name, startIndex: i });
            break; // One match per skill per episode
          }
        }
      }

      // Sort by order of appearance
      matchedSkills.sort((a, b) => a.startIndex - b.startIndex);
      const skillNames = matchedSkills.map((m) => m.name);

      if (skillNames.length >= 2) {
        episodeSkillSequences.push({
          skillNames,
          success: episode.outcome.success,
        });
      }
    }

    // Find recurring skill-level n-grams (pairs and triples)
    const chainMap = new Map<
      string,
      { skills: string[]; successCount: number; totalCount: number }
    >();

    for (const { skillNames, success } of episodeSkillSequences) {
      for (let len = 2; len <= Math.min(3, skillNames.length); len++) {
        for (let start = 0; start <= skillNames.length - len; start++) {
          const chain = skillNames.slice(start, start + len);
          const key = chain.join('|');

          let entry = chainMap.get(key);
          if (!entry) {
            entry = { skills: chain, successCount: 0, totalCount: 0 };
            chainMap.set(key, entry);
          }

          entry.totalCount++;
          if (success) {
            entry.successCount++;
          }
        }
      }
    }

    // Filter and build SkillChain results
    const chains: SkillChain[] = [];

    for (const entry of chainMap.values()) {
      if (entry.totalCount < this.minFrequency) continue;

      const successRate = entry.successCount / entry.totalCount;
      if (successRate < this.minSuccessRate) continue;

      chains.push({
        skills: entry.skills,
        frequency: entry.totalCount,
        successRate,
      });
    }

    chains.sort((a, b) => b.frequency - a.frequency);

    this.logger.info('Chain detection complete', { chainCount: chains.length });
    return chains;
  }

  /**
   * Convert a verified skill candidate into a standard {@link Skill} object
   * suitable for storage in the skill library.
   *
   * @param candidate - The skill candidate to convert.
   * @returns A fully populated Skill record.
   */
  toSkill(candidate: SkillCandidate): Skill {
    const now = Date.now();
    return {
      id: generateId(),
      name: candidate.name,
      description: candidate.description,
      preconditions: candidate.preconditions,
      pattern: JSON.stringify(candidate.pattern.actions),
      successRate: candidate.pattern.successRate,
      usageCount: candidate.pattern.frequency,
      confidence: candidate.confidence,
      sourceProject: this.projectName,
      sourceFiles: [],
      createdAt: now,
      updatedAt: now,
      tags: candidate.tags,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Infer preconditions by finding common keywords across the tasks of
   * source episodes.
   */
  private inferPreconditions(
    episodeIds: string[],
    episodes: Episode[],
  ): string[] {
    const sourceEpisodes = episodes.filter((e) => episodeIds.includes(e.id));
    if (sourceEpisodes.length === 0) return [];

    // Extract keywords from each episode's task
    const keywordSets = sourceEpisodes.map((e) =>
      new Set(extractKeywords(e.task)),
    );

    // Find keywords common to all source episodes
    if (keywordSets.length === 0) return [];

    const commonKeywords = [...keywordSets[0]].filter((kw) =>
      keywordSets.every((set) => set.has(kw)),
    );

    // Convert common keywords into precondition strings
    return commonKeywords
      .slice(0, 5)
      .map((kw) => `Task involves: ${kw}`);
  }

  /**
   * Infer tags from action types and task domain keywords.
   */
  private inferTags(pattern: ActionPattern, episodes: Episode[]): string[] {
    const tags = new Set<string>();

    // Add action types as tags
    for (const action of pattern.actions) {
      tags.add(action.type.replace(/[_\s]+/g, '-').toLowerCase());
    }

    // Add top keywords from source episode tasks
    const sourceEpisodes = episodes.filter((e) =>
      pattern.sourceEpisodeIds.includes(e.id),
    );
    for (const episode of sourceEpisodes) {
      const keywords = extractKeywords(episode.task);
      for (const kw of keywords.slice(0, 3)) {
        tags.add(kw.toLowerCase());
      }
    }

    return [...tags];
  }

  /**
   * Measure how consistent a pattern's action descriptions are across
   * its source episodes. Uses Jaccard similarity on description keywords.
   *
   * @returns A score from 0 (inconsistent) to 1 (very consistent).
   */
  private measureConsistency(
    pattern: ActionPattern,
    episodes: Episode[],
  ): number {
    const sourceEpisodes = episodes.filter((e) =>
      pattern.sourceEpisodeIds.includes(e.id),
    );

    if (sourceEpisodes.length < 2) return 1; // Only one source, trivially consistent

    const actionTypes = pattern.actions.map((a) => a.type);
    const patternLength = actionTypes.length;

    // Collect the description sequences from each matching episode
    const descriptionSets: Array<Set<string>> = [];

    for (const episode of sourceEpisodes) {
      const types = episode.actions.map((a) => a.type);

      // Find where this pattern starts in the episode's actions
      for (let i = 0; i <= types.length - patternLength; i++) {
        const slice = types.slice(i, i + patternLength);
        if (slice.every((t, j) => t === actionTypes[j])) {
          // Collect parameterized description keywords
          const descriptions = episode.actions
            .slice(i, i + patternLength)
            .map((a) => parameterizeDescription(a.description));
          const keywords = new Set(
            descriptions.flatMap((d) => extractKeywords(d)),
          );
          descriptionSets.push(keywords);
          break;
        }
      }
    }

    if (descriptionSets.length < 2) return 1;

    // Compute average pairwise Jaccard similarity
    let totalSimilarity = 0;
    let pairs = 0;

    for (let i = 0; i < descriptionSets.length; i++) {
      for (let j = i + 1; j < descriptionSets.length; j++) {
        totalSimilarity += jaccardSimilarity(descriptionSets[i], descriptionSets[j]);
        pairs++;
      }
    }

    return pairs > 0 ? totalSimilarity / pairs : 1;
  }

  /**
   * Extract action types from a skill's pattern string.
   *
   * The pattern is stored as a JSON array of `{ type, descriptionTemplate }`
   * objects. Falls back to parsing the pattern string as a type sequence
   * separated by ` -> `.
   */
  private extractTypesFromSkillPattern(pattern: string): string[] {
    try {
      const parsed = JSON.parse(pattern) as Array<{ type: string }>;
      if (Array.isArray(parsed)) {
        return parsed.map((p) => p.type);
      }
    } catch {
      // Fall back: try splitting on " -> "
      const parts = pattern.split(/\s*->\s*/);
      if (parts.length >= 2) {
        return parts;
      }
    }
    return [];
  }
}
