/**
 * Knowledge Distillation — Phase 6 of APEX Agent Self-Learning System
 *
 * Compresses episodic memory into durable semantic knowledge through
 * four complementary mechanisms:
 *
 * 1. **Periodic consolidation** — groups similar episodes by keyword
 *    overlap and merges them into compact semantic entries.
 * 2. **Rule extraction** — identifies consistent success/failure patterns
 *    across episodes within the same domain.
 * 3. **Skill crystallization** — promotes frequently-successful action
 *    sequences into skill candidates ready for the skill library.
 * 4. **Forgetting curve** — applies Ebbinghaus-inspired exponential (or
 *    linear) decay to memory heat scores, evicting entries that fall
 *    below a configurable threshold.
 *
 * All methods are pure data operations — pattern detection is done via
 * statistical analysis of episode fields, not LLM reasoning.
 */

import type { Episode, MemoryEntry, Skill } from '../types.js';
import { extractKeywords } from '../utils/embeddings.js';
import { jaccardSimilarity } from '../utils/similarity.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A compressed semantic memory derived from a cluster of similar episodes. */
export interface SemanticEntry {
  /** Human-readable summary content for this semantic memory. */
  content: string;

  /** IDs of the episodes that were merged to produce this entry. */
  sourceEpisodeIds: string[];

  /** Confidence in the entry, based on outcome consistency within the cluster. */
  confidence: number;

  /** Keywords extracted from the consolidated episodes. */
  keywords: string[];
}

/**
 * A pattern (rule) consistently observed across multiple episodes in a
 * single domain.
 */
export interface ExtractedRule {
  /** Human-readable description of the rule. */
  pattern: string;

  /** Number of episodes that support this rule. */
  supportCount: number;

  /** Ratio of supporting episodes to total relevant episodes (0-1). */
  confidence: number;

  /** IDs of the episodes that support the rule. */
  sourceEpisodeIds: string[];

  /** The task domain this rule applies to. */
  domain: string;
}

/**
 * An action sequence that has been observed frequently enough and with a
 * high-enough success rate to be promoted to a full skill.
 */
export interface SkillCandidate {
  /** Auto-generated name derived from action types. */
  name: string;

  /** Human-readable description of what the skill does. */
  description: string;

  /** Serialised action-type sequence (e.g. `"code_edit -> command -> code_edit"`). */
  pattern: string;

  /** Success rate across episodes containing this action sequence. */
  successRate: number;

  /** Number of episodes where this sequence was observed. */
  occurrenceCount: number;

  /** IDs of the episodes this candidate was derived from. */
  sourceEpisodeIds: string[];

  /** Tags inferred from action types and episode task keywords. */
  tags: string[];
}

/** Statistics produced by a single distillation pass. */
export interface DistillationStats {
  /** Total episodes fed into the distillation pipeline. */
  episodesAnalyzed: number;

  /** Number of new semantic entries created. */
  semanticEntriesCreated: number;

  /** Number of rules extracted. */
  rulesExtracted: number;

  /** Number of skill candidates crystallized. */
  skillsCrystallized: number;

  /** Number of memory entries whose heat was reduced. */
  entriesDecayed: number;

  /** Number of memory entries evicted (below minimum heat). */
  entriesEvicted: number;
}

/** Result of a full distillation pass. */
export interface DistillationResult {
  /** Semantic memories created by compressing episode clusters. */
  semanticEntries: SemanticEntry[];

  /** Rules extracted from consistent cross-episode patterns. */
  extractedRules: ExtractedRule[];

  /** Skill candidates ready for promotion to the skill library. */
  crystallizedSkills: SkillCandidate[];

  /** IDs of memory entries whose heat scores were reduced. */
  decayedEntries: string[];

  /** IDs of memory entries evicted due to low heat. */
  evictedEntries: string[];

  /** Aggregate statistics for the distillation pass. */
  stats: DistillationStats;
}

/** Parameters controlling the Ebbinghaus-inspired forgetting curve. */
export interface DecayOptions {
  /**
   * Time in milliseconds for a memory's heat score to decay by 50%.
   * Default: 7 days.
   */
  halfLifeMs: number;

  /**
   * Heat score below which a memory becomes a candidate for eviction.
   * Default: 0.05.
   */
  minimumHeat: number;

  /**
   * Shape of the decay function.
   * - `"exponential"` — heat = initial * 0.5^(elapsed / halfLife)
   * - `"linear"` — heat decreases linearly to 0 over 2 * halfLife
   *
   * Default: `"exponential"`.
   */
  decayFunction: 'exponential' | 'linear';
}

/** Configuration for the {@link KnowledgeDistiller}. */
export interface DistillationOptions {
  /** Minimum episodes needed in a cluster to extract a rule. Default: 3. */
  minEpisodesForRule?: number;

  /** Minimum success rate required to crystallize a skill. Default: 0.7. */
  minSuccessRateForSkill?: number;

  /** Jaccard similarity threshold for grouping episodes. Default: 0.3. */
  similarityThreshold?: number;

  /** Forgetting-curve parameters (partial — missing fields use defaults). */
  decay?: Partial<DecayOptions>;

  /** Logger instance. Falls back to a default logger if omitted. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default half-life: 7 days in milliseconds. */
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default minimum heat before eviction. */
const DEFAULT_MINIMUM_HEAT = 0.05;

/** Default decay function shape. */
const DEFAULT_DECAY_FUNCTION: DecayOptions['decayFunction'] = 'exponential';

/** Minimum episodes in a cluster to produce a semantic entry. */
const MIN_CLUSTER_SIZE = 2;

/** Minimum action-sequence length to consider for skill crystallization. */
const MIN_ACTION_SEQUENCE_LENGTH = 2;

/** Maximum action-sequence length to consider for skill crystallization. */
const MAX_ACTION_SEQUENCE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Build a serialisable key from an action-type sequence.
 */
function sequenceKey(types: string[]): string {
  return types.join('|');
}

/**
 * Build a human-readable skill name from action types.
 *
 * E.g. `["code_edit", "command"]` becomes `"code-edit-then-command"`.
 */
function buildSkillName(actionTypes: string[]): string {
  return actionTypes
    .map((t) => t.replace(/[_\s]+/g, '-').toLowerCase())
    .join('-then-');
}

/**
 * Infer a domain label from an episode's task text by selecting the
 * most prominent keyword.  Falls back to `"general"`.
 */
function inferDomain(task: string): string {
  const keywords = extractKeywords(task);
  return keywords.length > 0 ? keywords[0].toLowerCase() : 'general';
}

// ---------------------------------------------------------------------------
// KnowledgeDistiller
// ---------------------------------------------------------------------------

/**
 * Distils episodic memory into durable semantic knowledge.
 *
 * Usage:
 * ```ts
 * const distiller = new KnowledgeDistiller();
 * const result = distiller.distill(episodes, memories, skills);
 * ```
 */
export class KnowledgeDistiller {
  private readonly minEpisodesForRule: number;
  private readonly minSuccessRateForSkill: number;
  private readonly similarityThreshold: number;
  private readonly decay: DecayOptions;
  private readonly logger: Logger;

  constructor(options: DistillationOptions = {}) {
    this.minEpisodesForRule = options.minEpisodesForRule ?? 3;
    this.minSuccessRateForSkill = options.minSuccessRateForSkill ?? 0.7;
    this.similarityThreshold = options.similarityThreshold ?? 0.3;
    this.decay = {
      halfLifeMs: options.decay?.halfLifeMs ?? DEFAULT_HALF_LIFE_MS,
      minimumHeat: options.decay?.minimumHeat ?? DEFAULT_MINIMUM_HEAT,
      decayFunction: options.decay?.decayFunction ?? DEFAULT_DECAY_FUNCTION,
    };
    this.logger = options.logger ?? new Logger({ prefix: 'apex:distillation' });
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Run a full distillation pass over the provided data.
   *
   * Performs all four distillation stages:
   * 1. Compress episodes into semantic entries.
   * 2. Extract rules from consistent patterns.
   * 3. Crystallize frequently-successful action sequences into skill candidates.
   * 4. Apply forgetting-curve decay to existing memory entries.
   *
   * @param episodes         - Episodes to distil.
   * @param existingMemories - Current memory entries (for decay).
   * @param existingSkills   - Already-known skills (to avoid duplicates).
   * @returns A {@link DistillationResult} summarising all changes.
   */
  distill(
    episodes: Episode[],
    existingMemories: MemoryEntry[],
    existingSkills: Skill[],
  ): DistillationResult {
    this.logger.info('Starting distillation pass', {
      episodeCount: episodes.length,
      memoryCount: existingMemories.length,
      skillCount: existingSkills.length,
    });

    const semanticEntries = this.compressEpisodes(episodes);
    const extractedRules = this.extractRules(episodes);
    const crystallizedSkills = this.crystallizeSkills(episodes, existingSkills);
    const { decayed, evicted } = this.applyDecay(existingMemories);

    const decayedEntries = decayed.map((m) => m.id);
    const evictedEntries = evicted;

    const stats: DistillationStats = {
      episodesAnalyzed: episodes.length,
      semanticEntriesCreated: semanticEntries.length,
      rulesExtracted: extractedRules.length,
      skillsCrystallized: crystallizedSkills.length,
      entriesDecayed: decayedEntries.length,
      entriesEvicted: evictedEntries.length,
    };

    this.logger.info('Distillation pass complete', { stats });

    return {
      semanticEntries,
      extractedRules,
      crystallizedSkills,
      decayedEntries,
      evictedEntries,
      stats,
    };
  }

  /**
   * Group similar episodes by keyword overlap and merge each cluster into
   * a single semantic entry.
   *
   * Algorithm:
   * 1. Extract keywords from every episode's task.
   * 2. Greedily cluster episodes whose pairwise Jaccard similarity exceeds
   *    the configured threshold.
   * 3. For each cluster of size >= {@link MIN_CLUSTER_SIZE}, produce a
   *    {@link SemanticEntry} whose content summarises the common theme and
   *    whose confidence reflects outcome consistency.
   *
   * @param episodes - Episodes to compress.
   * @returns Semantic entries derived from episode clusters.
   */
  compressEpisodes(episodes: Episode[]): SemanticEntry[] {
    if (episodes.length < MIN_CLUSTER_SIZE) {
      this.logger.debug('Too few episodes to compress', { count: episodes.length });
      return [];
    }

    // Pre-compute keyword sets
    const keywordSets = episodes.map((ep) => ({
      episode: ep,
      keywords: new Set(extractKeywords(ep.task)),
    }));

    // Greedy single-link clustering
    const assigned = new Set<number>();
    const clusters: Array<Array<{ episode: Episode; keywords: Set<string> }>> = [];

    for (let i = 0; i < keywordSets.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = [keywordSets[i]];
      assigned.add(i);

      for (let j = i + 1; j < keywordSets.length; j++) {
        if (assigned.has(j)) continue;

        // Check similarity against any member of the current cluster
        const similar = cluster.some(
          (member) =>
            jaccardSimilarity(member.keywords, keywordSets[j].keywords) >=
            this.similarityThreshold,
        );

        if (similar) {
          cluster.push(keywordSets[j]);
          assigned.add(j);
        }
      }

      clusters.push(cluster);
    }

    // Convert qualifying clusters into semantic entries
    const entries: SemanticEntry[] = [];

    for (const cluster of clusters) {
      if (cluster.length < MIN_CLUSTER_SIZE) continue;

      const episodeIds = cluster.map((c) => c.episode.id);

      // Union of all keywords in the cluster
      const allKeywords = new Set<string>();
      for (const member of cluster) {
        for (const kw of member.keywords) {
          allKeywords.add(kw);
        }
      }

      // Common keywords (present in every episode of the cluster)
      const commonKeywords = [...cluster[0].keywords].filter((kw) =>
        cluster.every((member) => member.keywords.has(kw)),
      );

      // Outcome consistency → confidence
      const successCount = cluster.filter((c) => c.episode.outcome.success).length;
      const successRate = successCount / cluster.length;
      const confidence = clamp01(
        0.5 * (cluster.length / episodes.length) + 0.5 * Math.abs(successRate - 0.5) * 2,
      );

      // Build a summary string
      const theme = commonKeywords.length > 0
        ? commonKeywords.join(', ')
        : [...allKeywords].slice(0, 5).join(', ');

      const outcomeLabel = successRate >= 0.7
        ? 'mostly successful'
        : successRate <= 0.3
          ? 'mostly failed'
          : 'mixed outcomes';

      const content =
        `Consolidated from ${cluster.length} episodes about [${theme}]. ` +
        `Outcomes: ${outcomeLabel} (${Math.round(successRate * 100)}% success rate). ` +
        `Average reward: ${(cluster.reduce((s, c) => s + c.episode.reward, 0) / cluster.length).toFixed(2)}.`;

      entries.push({
        content,
        sourceEpisodeIds: episodeIds,
        confidence,
        keywords: commonKeywords.length > 0 ? commonKeywords : [...allKeywords].slice(0, 10),
      });
    }

    this.logger.debug('Episode compression complete', {
      clusters: clusters.length,
      semanticEntries: entries.length,
    });

    return entries;
  }

  /**
   * Extract consistent success/failure rules from episodes grouped by domain.
   *
   * For each domain:
   * - Identifies action types that appear disproportionately in successful
   *   vs. failed episodes.
   * - Identifies common error types in failed episodes.
   * - Produces rules only when the supporting episode count meets the
   *   configured minimum.
   *
   * @param episodes - Episodes to analyse.
   * @returns Extracted rules sorted by confidence (descending).
   */
  extractRules(episodes: Episode[]): ExtractedRule[] {
    const domainGroups = this.groupByDomain(episodes);
    const rules: ExtractedRule[] = [];

    for (const [domain, domainEpisodes] of domainGroups) {
      if (domainEpisodes.length < this.minEpisodesForRule) continue;

      const successful = domainEpisodes.filter((e) => e.outcome.success);
      const failed = domainEpisodes.filter((e) => !e.outcome.success);

      // --- Success-correlated action types ---
      if (successful.length >= this.minEpisodesForRule) {
        const commonActions = this.findCommonActions(successful);

        for (const actionType of commonActions) {
          // How many successful episodes contain this action type?
          const supportEpisodes = successful.filter((e) =>
            e.actions.some((a) => a.type === actionType),
          );
          const supportCount = supportEpisodes.length;

          // How many total domain episodes contain this action type?
          const totalWithAction = domainEpisodes.filter((e) =>
            e.actions.some((a) => a.type === actionType),
          ).length;

          const confidence = totalWithAction > 0
            ? clamp01(supportCount / totalWithAction)
            : 0;

          if (supportCount >= this.minEpisodesForRule && confidence >= 0.6) {
            rules.push({
              pattern: `In "${domain}" tasks, using "${actionType}" correlates with success (${Math.round(confidence * 100)}% of episodes with this action succeeded).`,
              supportCount,
              confidence,
              sourceEpisodeIds: supportEpisodes.map((e) => e.id),
              domain,
            });
          }
        }
      }

      // --- Common error types in failures ---
      if (failed.length >= this.minEpisodesForRule) {
        const errorCounts = new Map<string, string[]>();
        for (const ep of failed) {
          const errorType = ep.outcome.errorType;
          if (errorType) {
            const ids = errorCounts.get(errorType) ?? [];
            ids.push(ep.id);
            errorCounts.set(errorType, ids);
          }
        }

        for (const [errorType, episodeIds] of errorCounts) {
          if (episodeIds.length >= this.minEpisodesForRule) {
            const confidence = clamp01(episodeIds.length / failed.length);
            rules.push({
              pattern: `In "${domain}" tasks, "${errorType}" is a recurring failure mode (${episodeIds.length}/${failed.length} failures).`,
              supportCount: episodeIds.length,
              confidence,
              sourceEpisodeIds: episodeIds,
              domain,
            });
          }
        }
      }

      // --- Action types that correlate with failure ---
      if (failed.length >= this.minEpisodesForRule && successful.length > 0) {
        const failActions = this.findCommonActions(failed);
        const successActionSet = new Set(this.findCommonActions(successful));

        for (const actionType of failActions) {
          // Only flag actions that are common in failures but NOT in successes
          if (successActionSet.has(actionType)) continue;

          const failEpisodesWithAction = failed.filter((e) =>
            e.actions.some((a) => a.type === actionType),
          );

          if (failEpisodesWithAction.length >= this.minEpisodesForRule) {
            const confidence = clamp01(failEpisodesWithAction.length / failed.length);
            rules.push({
              pattern: `In "${domain}" tasks, "${actionType}" appears frequently in failures but not in successes — consider avoiding or revising this approach.`,
              supportCount: failEpisodesWithAction.length,
              confidence,
              sourceEpisodeIds: failEpisodesWithAction.map((e) => e.id),
              domain,
            });
          }
        }
      }
    }

    // Sort by confidence descending
    rules.sort((a, b) => b.confidence - a.confidence);

    this.logger.debug('Rule extraction complete', { ruleCount: rules.length });
    return rules;
  }

  /**
   * Identify action sequences that occur frequently in successful episodes
   * and are not already represented by existing skills.
   *
   * Algorithm:
   * 1. Extract action-type n-grams (length 2..6) from successful episodes.
   * 2. Count frequency and compute success rate for each n-gram.
   * 3. Filter by minimum success rate and minimum frequency.
   * 4. Deduplicate against existing skills by name similarity.
   * 5. Return qualifying candidates sorted by occurrence count.
   *
   * @param episodes      - Episodes to mine for action sequences.
   * @param existingSkills - Skills already in the library (used for dedup).
   * @returns Skill candidates sorted by occurrence count (descending).
   */
  crystallizeSkills(
    episodes: Episode[],
    existingSkills: Skill[],
  ): SkillCandidate[] {
    const successful = episodes.filter((e) => e.outcome.success);
    const failed = episodes.filter((e) => !e.outcome.success);

    if (successful.length === 0) {
      this.logger.debug('No successful episodes for skill crystallization');
      return [];
    }

    // Count n-gram frequencies in successful episodes
    const ngramSuccessMap = new Map<
      string,
      { types: string[]; episodeIds: Set<string> }
    >();

    for (const ep of successful) {
      const types = ep.actions.map((a) => a.type);

      for (let len = MIN_ACTION_SEQUENCE_LENGTH; len <= MAX_ACTION_SEQUENCE_LENGTH; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const gram = types.slice(start, start + len);
          const key = sequenceKey(gram);

          let entry = ngramSuccessMap.get(key);
          if (!entry) {
            entry = { types: gram, episodeIds: new Set() };
            ngramSuccessMap.set(key, entry);
          }
          entry.episodeIds.add(ep.id);
        }
      }
    }

    // Count how many failed episodes contain each n-gram
    const ngramFailCounts = new Map<string, number>();
    for (const ep of failed) {
      const types = ep.actions.map((a) => a.type);
      for (let len = MIN_ACTION_SEQUENCE_LENGTH; len <= MAX_ACTION_SEQUENCE_LENGTH; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const key = sequenceKey(types.slice(start, start + len));
          if (ngramSuccessMap.has(key)) {
            ngramFailCounts.set(key, (ngramFailCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }

    // Build existing-skill name set for deduplication
    const existingSkillNames = new Set(
      existingSkills.map((s) => s.name.toLowerCase()),
    );

    // Filter and build candidates
    const candidates: SkillCandidate[] = [];

    for (const [key, entry] of ngramSuccessMap) {
      const successCount = entry.episodeIds.size;
      if (successCount < this.minEpisodesForRule) continue;

      const failCount = ngramFailCounts.get(key) ?? 0;
      const totalCount = successCount + failCount;
      const successRate = successCount / totalCount;

      if (successRate < this.minSuccessRateForSkill) continue;

      const name = buildSkillName(entry.types);

      // Skip if a skill with this name already exists
      if (existingSkillNames.has(name.toLowerCase())) continue;

      const patternStr = entry.types.join(' -> ');
      const sourceEpisodeIds = [...entry.episodeIds];

      // Infer tags from action types and source episode keywords
      const tags = new Set<string>();
      for (const t of entry.types) {
        tags.add(t.replace(/[_\s]+/g, '-').toLowerCase());
      }
      const sourceEpisodes = episodes.filter((e) => entry.episodeIds.has(e.id));
      for (const ep of sourceEpisodes) {
        const kws = extractKeywords(ep.task);
        for (const kw of kws.slice(0, 3)) {
          tags.add(kw.toLowerCase());
        }
      }

      candidates.push({
        name,
        description: `Action sequence [${patternStr}] observed in ${successCount} successful episodes with ${Math.round(successRate * 100)}% success rate.`,
        pattern: patternStr,
        successRate,
        occurrenceCount: successCount,
        sourceEpisodeIds,
        tags: [...tags],
      });
    }

    // Sort by occurrence count descending, then by success rate
    candidates.sort((a, b) =>
      b.occurrenceCount - a.occurrenceCount || b.successRate - a.successRate,
    );

    this.logger.debug('Skill crystallization complete', {
      candidateCount: candidates.length,
    });

    return candidates;
  }

  /**
   * Apply Ebbinghaus-inspired decay to memory entry heat scores.
   *
   * For each entry, the heat score is reduced based on the time elapsed
   * since the entry was last accessed. Entries whose heat drops below the
   * configured minimum are flagged for eviction.
   *
   * @param entries - Memory entries to decay.
   * @param now     - Current timestamp in ms (defaults to `Date.now()`).
   * @returns An object containing decayed entries (with updated heat) and
   *          IDs of entries below the eviction threshold.
   */
  applyDecay(
    entries: MemoryEntry[],
    now?: number,
  ): { decayed: MemoryEntry[]; evicted: string[] } {
    const currentTime = now ?? Date.now();
    const decayed: MemoryEntry[] = [];
    const evicted: string[] = [];

    for (const entry of entries) {
      const elapsed = currentTime - entry.accessedAt;
      if (elapsed <= 0) continue; // Accessed in the future or just now — no decay

      const newHeat = this.computeDecayedHeat(entry.heatScore, elapsed);

      if (newHeat < this.decay.minimumHeat) {
        evicted.push(entry.id);
      } else if (newHeat < entry.heatScore) {
        decayed.push({ ...entry, heatScore: newHeat });
      }
    }

    this.logger.debug('Decay applied', {
      total: entries.length,
      decayed: decayed.length,
      evicted: evicted.length,
    });

    return { decayed, evicted };
  }

  /**
   * Group episodes by task domain.
   *
   * The domain is inferred from the most prominent keyword in each
   * episode's task description. Episodes whose task produces no keywords
   * are grouped under `"general"`.
   *
   * @param episodes - Episodes to group.
   * @returns A map from domain label to episodes in that domain.
   */
  groupByDomain(episodes: Episode[]): Map<string, Episode[]> {
    const groups = new Map<string, Episode[]>();

    for (const ep of episodes) {
      const domain = inferDomain(ep.task);
      const list = groups.get(domain) ?? [];
      list.push(ep);
      groups.set(domain, list);
    }

    this.logger.debug('Domain grouping complete', {
      domainCount: groups.size,
      domains: [...groups.keys()],
    });

    return groups;
  }

  /**
   * Find action types that appear frequently across the provided episodes.
   *
   * An action type is considered "common" if it appears in at least 50%
   * of the given episodes.
   *
   * @param episodes - Episodes to scan (typically a filtered subset).
   * @returns Action type strings that meet the frequency threshold.
   */
  findCommonActions(episodes: Episode[]): string[] {
    if (episodes.length === 0) return [];

    const actionTypeCounts = new Map<string, number>();

    for (const ep of episodes) {
      // Count each action type at most once per episode
      const typesInEpisode = new Set(ep.actions.map((a) => a.type));
      for (const t of typesInEpisode) {
        actionTypeCounts.set(t, (actionTypeCounts.get(t) ?? 0) + 1);
      }
    }

    const threshold = episodes.length * 0.5;
    const common: string[] = [];

    for (const [actionType, count] of actionTypeCounts) {
      if (count >= threshold) {
        common.push(actionType);
      }
    }

    return common;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Compute the decayed heat score for a memory entry.
   *
   * @param initialHeat - The entry's current heat score.
   * @param elapsedMs   - Time in ms since the entry was last accessed.
   * @returns The new heat score after decay.
   */
  private computeDecayedHeat(initialHeat: number, elapsedMs: number): number {
    if (this.decay.decayFunction === 'linear') {
      // Linear decay: reaches 0 at 2 * halfLife
      const totalLifespan = this.decay.halfLifeMs * 2;
      const remaining = clamp01(1 - elapsedMs / totalLifespan);
      return clamp01(initialHeat * remaining);
    }

    // Exponential decay: heat = initial * 0.5^(elapsed / halfLife)
    const exponent = elapsedMs / this.decay.halfLifeMs;
    return clamp01(initialHeat * Math.pow(0.5, exponent));
  }
}
