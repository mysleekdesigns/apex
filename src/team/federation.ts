/**
 * Federated Learning Engine for APEX Team Knowledge Sharing (Phase 18)
 *
 * Privacy-preserving aggregation of learning patterns across team
 * members. Computes team-wide metrics, skill distributions, error
 * pattern frequencies, and member leaderboards without sharing
 * raw episode data.
 *
 * Pure computation — zero LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import type { KnowledgeTier, SharedKnowledge } from './knowledge-tier.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated learning metrics for a single team member. */
export interface MemberMetrics {
  /** The author identifier. */
  author: string;
  /** Number of skill entries contributed. */
  skillsContributed: number;
  /** Number of knowledge entries contributed. */
  knowledgeContributed: number;
  /** Number of error-taxonomy entries contributed. */
  errorPatternsContributed: number;
  /** Mean confidence across all contributions. */
  avgConfidence: number;
  /** Most frequently used tags (up to 10). */
  topTags: string[];
  /** Timestamp of the most recent contribution. */
  lastActive: number;
}

/** Team-wide aggregated learning patterns. */
export interface FederatedMetrics {
  /** Number of distinct contributing members. */
  totalMembers: number;
  /** Total number of shared entries across all categories. */
  totalContributions: number;
  /** Tag frequency map across all skill entries. */
  skillDistribution: Record<string, number>;
  /** Recurring error patterns extracted from error-taxonomy entries. */
  commonErrorPatterns: Array<{ pattern: string; frequency: number }>;
  /** Mean confidence across every team entry. */
  avgTeamConfidence: number;
  /** Top skill tags ordered by frequency (up to 20). */
  topSkillTags: Array<{ tag: string; count: number }>;
  /** Per-member breakdown. */
  memberMetrics: MemberMetrics[];
  /** Ranked list of contributors by weighted score. */
  leaderboard: Array<{ author: string; score: number; rank: number }>;
  /** Timestamp when these metrics were generated. */
  generatedAt: number;
}

/** A conflict detected between team knowledge and a personal entry. */
export interface KnowledgeConflict {
  /** Unique conflict identifier. */
  id: string;
  /** The team-side entry that conflicts. */
  teamEntry: SharedKnowledge;
  /** The personal content that conflicts. */
  personalContent: string;
  /** Nature of the conflict. */
  conflictType: 'content-mismatch' | 'confidence-mismatch' | 'category-mismatch';
  /** Suggested resolution direction. */
  recommendation: 'prefer-team' | 'prefer-personal' | 'merge';
  /** Human-readable explanation for the recommendation. */
  reason: string;
}

/** Configuration options for the FederationEngine. */
export interface FederationOptions {
  /** The KnowledgeTier instance to read team entries from. */
  knowledgeTier: KnowledgeTier;
  /** Optional structured logger. */
  logger?: Logger;
  /** Which side wins by default during conflict resolution. */
  precedence?: 'team' | 'personal';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise a string into lowercase alpha-numeric words for overlap
 * comparison.  Strips punctuation and common stop-words.
 */
function tokenize(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'and', 'or', 'but', 'not', 'it', 'its', 'this', 'that',
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w));
  return new Set(words);
}

/**
 * Compute the Jaccard overlap ratio between two token sets.
 * Returns a value in [0, 1].
 */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Collect the top-N entries from a frequency map, sorted descending.
 */
function topN(freq: Record<string, number>, n: number): Array<{ tag: string; count: number }> {
  return Object.entries(freq)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// FederationEngine
// ---------------------------------------------------------------------------

/**
 * Privacy-preserving federated learning engine.
 *
 * Aggregates shared knowledge entries into team-wide metrics, detects
 * conflicts between personal and team knowledge, and produces ranked
 * contribution leaderboards — all without exposing raw episode data.
 */
export class FederationEngine {
  private readonly knowledgeTier: KnowledgeTier;
  private readonly logger: Logger;
  private readonly precedence: 'team' | 'personal';

  constructor(options: FederationOptions) {
    this.knowledgeTier = options.knowledgeTier;
    this.logger = options.logger ?? new Logger({ prefix: 'federation' });
    this.precedence = options.precedence ?? 'team';
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Compute comprehensive team-wide federated metrics.
   *
   * Loads all shared entries, groups by author, and produces aggregated
   * statistics including per-member breakdowns and a contribution
   * leaderboard.
   */
  async computeMetrics(): Promise<FederatedMetrics> {
    const entries = await this.knowledgeTier.listEntries();
    this.logger.debug('Computing federated metrics', { entryCount: entries.length });

    // Group entries by author
    const byAuthor = new Map<string, SharedKnowledge[]>();
    for (const entry of entries) {
      const list = byAuthor.get(entry.author) ?? [];
      list.push(entry);
      byAuthor.set(entry.author, list);
    }

    // Per-member metrics
    const memberMetrics: MemberMetrics[] = [];
    for (const [author, authorEntries] of byAuthor) {
      memberMetrics.push(this.buildMemberMetrics(author, authorEntries));
    }

    // Skill distribution (tag frequency across all entries)
    const skillDistribution: Record<string, number> = {};
    for (const entry of entries) {
      for (const tag of entry.tags) {
        skillDistribution[tag] = (skillDistribution[tag] ?? 0) + 1;
      }
    }

    // Common error patterns from error-taxonomy entries
    const errorEntries = entries.filter(e => e.category === 'error-taxonomy');
    const errorFreq: Record<string, number> = {};
    for (const entry of errorEntries) {
      const key = entry.content.slice(0, 120).trim();
      errorFreq[key] = (errorFreq[key] ?? 0) + 1;
    }
    const commonErrorPatterns = Object.entries(errorFreq)
      .map(([pattern, frequency]) => ({ pattern, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 20);

    // Average team confidence
    const avgTeamConfidence =
      entries.length > 0
        ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length
        : 0;

    // Top skill tags
    const topSkillTags = topN(skillDistribution, 20);

    // Leaderboard: skills * 3 + knowledge * 2 + errors * 1
    const leaderboard = memberMetrics
      .map(m => ({
        author: m.author,
        score:
          m.skillsContributed * 3 +
          m.knowledgeContributed * 2 +
          m.errorPatternsContributed * 1,
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry, idx) => ({ ...entry, rank: idx + 1 }));

    this.logger.info('Federated metrics computed', {
      members: memberMetrics.length,
      contributions: entries.length,
    });

    return {
      totalMembers: byAuthor.size,
      totalContributions: entries.length,
      skillDistribution,
      commonErrorPatterns,
      avgTeamConfidence,
      topSkillTags,
      memberMetrics,
      leaderboard,
      generatedAt: Date.now(),
    };
  }

  /**
   * Retrieve aggregated metrics for a single team member.
   *
   * @param author - The author identifier to look up.
   * @returns The member's metrics, or `null` if they have no contributions.
   */
  async getMemberMetrics(author: string): Promise<MemberMetrics | null> {
    const entries = await this.knowledgeTier.listEntries();
    const authorEntries = entries.filter(e => e.author === author);
    if (authorEntries.length === 0) return null;
    return this.buildMemberMetrics(author, authorEntries);
  }

  /**
   * Detect conflicts between personal knowledge entries and team
   * knowledge.
   *
   * For each personal entry the engine looks for team entries with
   * significant keyword overlap and flags mismatches in content or
   * confidence.
   *
   * @param personalEntries - The caller's local knowledge entries.
   * @returns An array of detected conflicts with resolution recommendations.
   */
  async detectConflicts(
    personalEntries: Array<{ content: string; tags: string[]; confidence: number }>,
  ): Promise<KnowledgeConflict[]> {
    const teamEntries = await this.knowledgeTier.listEntries();
    const conflicts: KnowledgeConflict[] = [];

    for (const personal of personalEntries) {
      const personalTokens = tokenize(personal.content);

      for (const team of teamEntries) {
        const teamTokens = tokenize(team.content);
        const overlap = tokenOverlap(personalTokens, teamTokens);

        // Only consider entries with meaningful keyword overlap
        if (overlap < 0.5) continue;

        // Content mismatch: overlap is significant but not high enough to
        // be considered identical (50%-80% range).
        if (overlap >= 0.5 && overlap < 0.8) {
          conflicts.push({
            id: generateId(),
            teamEntry: team,
            personalContent: personal.content,
            conflictType: 'content-mismatch',
            recommendation: this.resolveRecommendation('content-mismatch'),
            reason:
              `Team and personal entries share ${Math.round(overlap * 100)}% keyword ` +
              `overlap but differ in detail. ${this.precedenceReason()}.`,
          });
          continue;
        }

        // Confidence mismatch: same topic but significantly different
        // confidence levels.
        const confidenceDelta = Math.abs(team.confidence - personal.confidence);
        if (confidenceDelta > 0.3) {
          conflicts.push({
            id: generateId(),
            teamEntry: team,
            personalContent: personal.content,
            conflictType: 'confidence-mismatch',
            recommendation: this.resolveRecommendation('confidence-mismatch'),
            reason:
              `Confidence differs by ${confidenceDelta.toFixed(2)} ` +
              `(team: ${team.confidence.toFixed(2)}, personal: ${personal.confidence.toFixed(2)}). ` +
              `${this.precedenceReason()}.`,
          });
        }
      }
    }

    this.logger.debug('Conflict detection complete', { conflicts: conflicts.length });
    return conflicts;
  }

  /**
   * Shortcut: return only the contribution leaderboard.
   */
  async getLeaderboard(): Promise<Array<{ author: string; score: number; rank: number }>> {
    const metrics = await this.computeMetrics();
    return metrics.leaderboard;
  }

  /**
   * Shortcut: return only the tag-level skill distribution.
   */
  async getSkillDistribution(): Promise<Record<string, number>> {
    const metrics = await this.computeMetrics();
    return metrics.skillDistribution;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Build MemberMetrics for a single author from their entries. */
  private buildMemberMetrics(author: string, entries: SharedKnowledge[]): MemberMetrics {
    const skillsContributed = entries.filter(e => e.category === 'skill').length;
    const knowledgeContributed = entries.filter(e => e.category === 'knowledge').length;
    const errorPatternsContributed = entries.filter(e => e.category === 'error-taxonomy').length;

    const avgConfidence =
      entries.length > 0
        ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length
        : 0;

    // Tag frequency for this member
    const tagFreq: Record<string, number> = {};
    for (const entry of entries) {
      for (const tag of entry.tags) {
        tagFreq[tag] = (tagFreq[tag] ?? 0) + 1;
      }
    }
    const topTags = topN(tagFreq, 10).map(t => t.tag);

    const lastActive = Math.max(...entries.map(e => e.updatedAt), 0);

    return {
      author,
      skillsContributed,
      knowledgeContributed,
      errorPatternsContributed,
      avgConfidence,
      topTags,
      lastActive,
    };
  }

  /** Determine recommendation based on conflict type and precedence. */
  private resolveRecommendation(
    conflictType: KnowledgeConflict['conflictType'],
  ): KnowledgeConflict['recommendation'] {
    if (conflictType === 'content-mismatch') return 'merge';
    return this.precedence === 'team' ? 'prefer-team' : 'prefer-personal';
  }

  /** Short human-readable explanation of the active precedence rule. */
  private precedenceReason(): string {
    return this.precedence === 'team'
      ? 'Team knowledge takes precedence by default'
      : 'Personal knowledge takes precedence by configuration';
  }
}
