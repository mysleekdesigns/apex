/**
 * Proposal-Review Workflow for APEX Team Knowledge Sharing (Phase 18)
 *
 * Implements a propose/review/approve workflow for team knowledge
 * contributions. Proposals go through a review cycle before being
 * promoted to the shared knowledge tier.
 *
 * Pure data operations — zero LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import type { KnowledgeTier, SharedKnowledge } from './knowledge-tier.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid proposal statuses. */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

/** Valid proposal categories (mirrors SharedKnowledge categories). */
export type ProposalCategory = 'skill' | 'knowledge' | 'error-taxonomy';

/** A proposal to add or update team knowledge. */
export interface Proposal {
  /** Unique identifier. */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Longer description of what is being proposed and why. */
  description: string;
  /** Target knowledge category. */
  category: ProposalCategory;
  /** The knowledge content being proposed. */
  content: string;
  /** Who authored the proposal. */
  author: string;
  /** Current status in the review cycle. */
  status: ProposalStatus;
  /** Who reviewed the proposal (set after review). */
  reviewedBy?: string;
  /** Optional comment left by the reviewer. */
  reviewComment?: string;
  /** Project path where this proposal originated. */
  sourceProject: string;
  /** Free-form tags for categorisation. */
  tags: string[];
  /** Confidence score in `[0, 1]`. */
  confidence: number;
  /** Unix-epoch millisecond timestamp of creation. */
  createdAt: number;
  /** Unix-epoch millisecond timestamp of last update. */
  updatedAt: number;
}

/** Input for creating a new proposal. */
export interface ProposeInput {
  title: string;
  description: string;
  category: ProposalCategory;
  content: string;
  author: string;
  sourceProject: string;
  tags?: string[];
  confidence?: number;
}

/** Summary of team learning activity. */
export interface TeamStatus {
  pendingProposals: number;
  acceptedProposals: number;
  rejectedProposals: number;
  totalProposals: number;
  recentActivity: Array<{ action: string; title: string; author: string; timestamp: number }>;
  topContributors: Array<{ author: string; contributions: number }>;
}

/** Options for constructing a {@link ProposalManager}. */
export interface ProposalManagerOptions {
  /** The {@link KnowledgeTier} instance that manages the shared store. */
  knowledgeTier: KnowledgeTier;
  /** Logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages the propose / review / approve workflow for team knowledge.
 *
 * Proposals live in the `proposals` collection of the underlying
 * {@link KnowledgeTier} store. When a proposal is accepted, its content is
 * promoted to the appropriate shared knowledge category.
 */
export class ProposalManager {
  private readonly knowledgeTier: KnowledgeTier;
  private readonly logger: Logger;

  constructor(options: ProposalManagerOptions) {
    this.knowledgeTier = options.knowledgeTier;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:proposal' });
  }

  // -------------------------------------------------------------------------
  // Proposal lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new proposal with status `'pending'`.
   *
   * @param input - The proposal content and metadata.
   * @returns The persisted {@link Proposal}.
   */
  async propose(input: ProposeInput): Promise<Proposal> {
    const now = Date.now();
    const proposal: Proposal = {
      id: generateId(),
      title: input.title,
      description: input.description,
      category: input.category,
      content: input.content,
      author: input.author,
      status: 'pending',
      sourceProject: input.sourceProject,
      tags: input.tags ?? [],
      confidence: input.confidence ?? 0.5,
      createdAt: now,
      updatedAt: now,
    };

    await this.knowledgeTier.store.write('proposals', proposal.id, proposal);
    await this.logActivity('propose', proposal.title, proposal.author);
    this.logger.info('Proposal created', { id: proposal.id, title: proposal.title });
    return proposal;
  }

  /**
   * Review (accept or reject) a pending proposal.
   *
   * When a proposal is **accepted**, its content is automatically promoted
   * to the shared knowledge tier via {@link KnowledgeTier.addEntry}.
   *
   * @param proposalId - ID of the proposal to review.
   * @param decision   - `'accept'` or `'reject'`.
   * @param reviewer   - Name of the reviewer.
   * @param comment    - Optional review comment.
   * @returns The updated {@link Proposal}.
   * @throws If the proposal does not exist.
   */
  async review(
    proposalId: string,
    decision: 'accept' | 'reject',
    reviewer: string,
    comment?: string,
  ): Promise<Proposal> {
    const proposal = await this.knowledgeTier.store.read<Proposal>('proposals', proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const now = Date.now();
    proposal.status = decision === 'accept' ? 'accepted' : 'rejected';
    proposal.reviewedBy = reviewer;
    proposal.reviewComment = comment;
    proposal.updatedAt = now;

    // Persist updated proposal
    await this.knowledgeTier.store.write('proposals', proposal.id, proposal);

    // If accepted, promote the content to the shared knowledge tier
    if (decision === 'accept') {
      await this.knowledgeTier.addEntry({
        content: proposal.content,
        category: proposal.category,
        author: proposal.author,
        sourceProject: proposal.sourceProject,
        tags: proposal.tags,
        confidence: proposal.confidence,
      });
      this.logger.info('Proposal accepted and promoted to knowledge tier', {
        id: proposal.id,
        category: proposal.category,
      });
    } else {
      this.logger.info('Proposal rejected', { id: proposal.id });
    }

    await this.logActivity(
      decision === 'accept' ? 'accept' : 'reject',
      proposal.title,
      reviewer,
    );

    return proposal;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * List proposals, optionally filtered by status.
   *
   * Results are sorted by `createdAt` descending (newest first).
   */
  async listProposals(status?: ProposalStatus): Promise<Proposal[]> {
    const all = await this.knowledgeTier.store.readAll<Proposal>('proposals');
    const filtered = status ? all.filter((p) => p.status === status) : all;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return filtered;
  }

  /**
   * Retrieve a single proposal by ID.
   *
   * @returns The proposal, or `null` if not found.
   */
  async getProposal(id: string): Promise<Proposal | null> {
    return this.knowledgeTier.store.read<Proposal>('proposals', id);
  }

  // -------------------------------------------------------------------------
  // Team status
  // -------------------------------------------------------------------------

  /**
   * Compute an aggregate summary of team learning activity.
   *
   * Includes proposal counts by status, recent activity from the changelog,
   * and a leaderboard of top contributors (by accepted proposals).
   */
  async getTeamStatus(): Promise<TeamStatus> {
    const all = await this.knowledgeTier.store.readAll<Proposal>('proposals');

    const pending = all.filter((p) => p.status === 'pending').length;
    const accepted = all.filter((p) => p.status === 'accepted').length;
    const rejected = all.filter((p) => p.status === 'rejected').length;

    // Recent activity from changelog
    const changelog = await this.knowledgeTier.getChangelog(10);
    const recentActivity = changelog.map((entry) => ({
      action: entry.action,
      title: entry.id, // changelog entries store entryId, used as title fallback
      author: entry.author,
      timestamp: entry.timestamp,
    }));

    // Top contributors: count accepted proposals per author
    const contributorMap = new Map<string, number>();
    for (const proposal of all) {
      if (proposal.status === 'accepted') {
        const count = contributorMap.get(proposal.author) ?? 0;
        contributorMap.set(proposal.author, count + 1);
      }
    }
    const topContributors = Array.from(contributorMap.entries())
      .map(([author, contributions]) => ({ author, contributions }))
      .sort((a, b) => b.contributions - a.contributions);

    return {
      pendingProposals: pending,
      acceptedProposals: accepted,
      rejectedProposals: rejected,
      totalProposals: all.length,
      recentActivity,
      topContributors,
    };
  }

  // -------------------------------------------------------------------------
  // Sync (read-only scan)
  // -------------------------------------------------------------------------

  /**
   * Scan all categories in the knowledge tier and return a summary.
   *
   * This is a read-only operation that reports what is currently available
   * in the shared store.
   */
  async sync(): Promise<{ newEntries: number; categories: Record<string, number> }> {
    const categories: Record<string, number> = {};
    let total = 0;

    for (const cat of ['skills', 'knowledge', 'error-taxonomy'] as const) {
      const ids = await this.knowledgeTier.store.list(cat);
      categories[cat] = ids.length;
      total += ids.length;
    }

    this.logger.info('Sync completed', { total, categories });
    return { newEntries: total, categories };
  }

  // -------------------------------------------------------------------------
  // Activity log
  // -------------------------------------------------------------------------

  /**
   * Return recent activity log entries from the knowledge tier changelog.
   *
   * @param limit - Maximum entries to return (default `20`).
   */
  async getLog(
    limit: number = 20,
  ): Promise<Array<{ action: string; title: string; author: string; timestamp: number }>> {
    const changelog = await this.knowledgeTier.getChangelog(limit);
    return changelog.map((entry) => ({
      action: entry.action,
      title: entry.id,
      author: entry.author,
      timestamp: entry.timestamp,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Record an activity entry in the knowledge tier changelog.
   *
   * Uses the changelog collection indirectly through {@link KnowledgeTier}'s
   * store to keep all activity in one place.
   */
  private async logActivity(action: string, title: string, author: string): Promise<void> {
    const record = {
      id: generateId(),
      action,
      category: 'proposal',
      entryId: title,
      author,
      timestamp: Date.now(),
    };
    await this.knowledgeTier.store.write('changelog', record.id, record);
  }
}
