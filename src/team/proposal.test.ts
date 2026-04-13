import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeTier } from './knowledge-tier.js';
import { ProposalManager } from './proposal.js';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

describe('ProposalManager', () => {
  let tmpDir: string;
  let tier: KnowledgeTier;
  let manager: ProposalManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-proposal-'));
    tier = new KnowledgeTier({
      projectPath: tmpDir,
      author: 'test-author',
      logger: mockLogger,
    });
    await tier.init();
    manager = new ProposalManager({
      knowledgeTier: tier,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // propose
  // -------------------------------------------------------------------------

  it('propose creates pending proposal', async () => {
    const proposal = await manager.propose({
      title: 'Add caching pattern',
      description: 'A reusable caching pattern for API calls',
      category: 'skill',
      content: 'Use LRU cache with TTL for external API calls',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['caching', 'api'],
      confidence: 0.85,
    });

    expect(proposal.status).toBe('pending');
  });

  it('propose includes all fields', async () => {
    const proposal = await manager.propose({
      title: 'Error handling guide',
      description: 'Standard error handling for async operations',
      category: 'knowledge',
      content: 'Always wrap async calls in try-catch blocks',
      author: 'bob',
      sourceProject: '/project/b',
      tags: ['error-handling', 'async'],
      confidence: 0.9,
    });

    expect(proposal.id).toBeDefined();
    expect(proposal.title).toBe('Error handling guide');
    expect(proposal.description).toBe('Standard error handling for async operations');
    expect(proposal.category).toBe('knowledge');
    expect(proposal.content).toBe('Always wrap async calls in try-catch blocks');
    expect(proposal.author).toBe('bob');
    expect(proposal.sourceProject).toBe('/project/b');
    expect(proposal.tags).toEqual(['error-handling', 'async']);
    expect(proposal.confidence).toBe(0.9);
    expect(proposal.createdAt).toBeGreaterThan(0);
    expect(proposal.updatedAt).toBeGreaterThan(0);
  });

  it('propose with default confidence', async () => {
    const proposal = await manager.propose({
      title: 'Default confidence test',
      description: 'Testing default confidence value',
      category: 'skill',
      content: 'Some skill content',
      author: 'alice',
      sourceProject: '/project/a',
    });

    expect(proposal.confidence).toBe(0.5);
  });

  // -------------------------------------------------------------------------
  // review
  // -------------------------------------------------------------------------

  it('review accepts proposal', async () => {
    const proposal = await manager.propose({
      title: 'Accept me',
      description: 'Should be accepted',
      category: 'skill',
      content: 'Accepted skill content',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['test'],
      confidence: 0.8,
    });

    const reviewed = await manager.review(proposal.id, 'accept', 'reviewer-bob', 'Looks great');
    expect(reviewed.status).toBe('accepted');
  });

  it('review rejects proposal', async () => {
    const proposal = await manager.propose({
      title: 'Reject me',
      description: 'Should be rejected',
      category: 'knowledge',
      content: 'Rejected content',
      author: 'alice',
      sourceProject: '/project/a',
      tags: [],
      confidence: 0.5,
    });

    const reviewed = await manager.review(proposal.id, 'reject', 'reviewer-carol', 'Not useful');
    expect(reviewed.status).toBe('rejected');
  });

  it('accepted proposal promotes to knowledge tier', async () => {
    const proposal = await manager.propose({
      title: 'Promote me',
      description: 'Should be promoted to knowledge tier on accept',
      category: 'skill',
      content: 'Promoted skill content for team use',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['promoted'],
      confidence: 0.9,
    });

    await manager.review(proposal.id, 'accept', 'reviewer-bob');

    // The accepted proposal should create an entry in the knowledge tier
    const skills = await tier.listEntries('skill');
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const promoted = skills.find((e) => e.content === 'Promoted skill content for team use');
    expect(promoted).toBeDefined();
    expect(promoted!.author).toBe('alice');
    expect(promoted!.confidence).toBe(0.9);
  });

  it('review sets reviewer and comment', async () => {
    const proposal = await manager.propose({
      title: 'Review metadata test',
      description: 'Testing reviewer fields',
      category: 'knowledge',
      content: 'Content',
      author: 'alice',
      sourceProject: '/project/a',
    });

    const reviewed = await manager.review(
      proposal.id,
      'accept',
      'reviewer-dave',
      'Excellent contribution',
    );

    expect(reviewed.reviewedBy).toBe('reviewer-dave');
    expect(reviewed.reviewComment).toBe('Excellent contribution');
  });

  it('review non-existent proposal throws', async () => {
    await expect(
      manager.review('nonexistent-id', 'accept', 'reviewer'),
    ).rejects.toThrow('Proposal not found');
  });

  // -------------------------------------------------------------------------
  // listProposals
  // -------------------------------------------------------------------------

  it('listProposals returns all', async () => {
    await manager.propose({
      title: 'P1',
      description: 'D1',
      category: 'skill',
      content: 'C1',
      author: 'alice',
      sourceProject: '/p',
    });
    await manager.propose({
      title: 'P2',
      description: 'D2',
      category: 'knowledge',
      content: 'C2',
      author: 'bob',
      sourceProject: '/p',
    });

    const all = await manager.listProposals();
    expect(all).toHaveLength(2);
  });

  it('listProposals filters by status', async () => {
    const p1 = await manager.propose({
      title: 'P1',
      description: 'D1',
      category: 'skill',
      content: 'C1',
      author: 'alice',
      sourceProject: '/p',
    });
    await manager.propose({
      title: 'P2',
      description: 'D2',
      category: 'knowledge',
      content: 'C2',
      author: 'bob',
      sourceProject: '/p',
    });

    await manager.review(p1.id, 'accept', 'reviewer');

    const pending = await manager.listProposals('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe('P2');

    const accepted = await manager.listProposals('accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].title).toBe('P1');
  });

  // -------------------------------------------------------------------------
  // getProposal
  // -------------------------------------------------------------------------

  it('getProposal returns by id', async () => {
    const created = await manager.propose({
      title: 'Find me',
      description: 'By ID',
      category: 'skill',
      content: 'Findable content',
      author: 'alice',
      sourceProject: '/p',
    });

    const fetched = await manager.getProposal(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe('Find me');
  });

  it('getProposal returns null for missing', async () => {
    const result = await manager.getProposal('does-not-exist');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getTeamStatus
  // -------------------------------------------------------------------------

  it('getTeamStatus counts correctly', async () => {
    const p1 = await manager.propose({
      title: 'P1',
      description: 'D',
      category: 'skill',
      content: 'C1',
      author: 'alice',
      sourceProject: '/p',
    });
    const p2 = await manager.propose({
      title: 'P2',
      description: 'D',
      category: 'knowledge',
      content: 'C2',
      author: 'bob',
      sourceProject: '/p',
    });
    await manager.propose({
      title: 'P3',
      description: 'D',
      category: 'error-taxonomy',
      content: 'C3',
      author: 'carol',
      sourceProject: '/p',
    });

    await manager.review(p1.id, 'accept', 'reviewer');
    await manager.review(p2.id, 'reject', 'reviewer');

    const status = await manager.getTeamStatus();
    expect(status.pendingProposals).toBe(1);
    expect(status.acceptedProposals).toBe(1);
    expect(status.rejectedProposals).toBe(1);
    expect(status.totalProposals).toBe(3);
  });

  it('getTeamStatus shows top contributors', async () => {
    // Alice gets 2 accepted, Bob gets 1 accepted
    const a1 = await manager.propose({
      title: 'A1',
      description: 'D',
      category: 'skill',
      content: 'C',
      author: 'alice',
      sourceProject: '/p',
    });
    const a2 = await manager.propose({
      title: 'A2',
      description: 'D',
      category: 'knowledge',
      content: 'C',
      author: 'alice',
      sourceProject: '/p',
    });
    const b1 = await manager.propose({
      title: 'B1',
      description: 'D',
      category: 'skill',
      content: 'C',
      author: 'bob',
      sourceProject: '/p',
    });

    await manager.review(a1.id, 'accept', 'reviewer');
    await manager.review(a2.id, 'accept', 'reviewer');
    await manager.review(b1.id, 'accept', 'reviewer');

    const status = await manager.getTeamStatus();
    expect(status.topContributors.length).toBeGreaterThanOrEqual(2);
    expect(status.topContributors[0].author).toBe('alice');
    expect(status.topContributors[0].contributions).toBe(2);
    expect(status.topContributors[1].author).toBe('bob');
    expect(status.topContributors[1].contributions).toBe(1);
  });

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  it('sync returns category counts', async () => {
    // Add entries directly to tier so sync can find them
    await tier.addEntry({
      content: 'S1',
      category: 'skill',
      author: 'a',
      sourceProject: '/p',
      tags: [],
      confidence: 0.8,
    });
    await tier.addEntry({
      content: 'K1',
      category: 'knowledge',
      author: 'b',
      sourceProject: '/p',
      tags: [],
      confidence: 0.7,
    });
    await tier.addEntry({
      content: 'K2',
      category: 'knowledge',
      author: 'c',
      sourceProject: '/p',
      tags: [],
      confidence: 0.6,
    });

    const result = await manager.sync();
    expect(result.newEntries).toBe(3);
    expect(result.categories['skills']).toBe(1);
    expect(result.categories['knowledge']).toBe(2);
    expect(result.categories['error-taxonomy']).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getLog
  // -------------------------------------------------------------------------

  it('getLog returns recent activity', async () => {
    await manager.propose({
      title: 'P1',
      description: 'D',
      category: 'skill',
      content: 'C',
      author: 'alice',
      sourceProject: '/p',
    });
    await manager.propose({
      title: 'P2',
      description: 'D',
      category: 'knowledge',
      content: 'C',
      author: 'bob',
      sourceProject: '/p',
    });

    const log = await manager.getLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    // Should have 'propose' actions from the logActivity calls
    const actions = log.map((l) => l.action);
    expect(actions.filter((a) => a === 'propose').length).toBeGreaterThanOrEqual(2);
  });

  it('getLog respects limit', async () => {
    // Create several proposals to generate log entries
    for (let i = 0; i < 5; i++) {
      await manager.propose({
        title: `P${i}`,
        description: 'D',
        category: 'skill',
        content: 'C',
        author: 'alice',
        sourceProject: '/p',
      });
    }

    const log = await manager.getLog(2);
    expect(log.length).toBeLessThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Multiple proposals workflow
  // -------------------------------------------------------------------------

  it('multiple proposals workflow — propose, accept, propose, reject', async () => {
    const p1 = await manager.propose({
      title: 'First proposal',
      description: 'Will be accepted',
      category: 'skill',
      content: 'First skill content',
      author: 'alice',
      sourceProject: '/project/a',
      tags: ['first'],
      confidence: 0.9,
    });

    const accepted = await manager.review(p1.id, 'accept', 'reviewer-bob', 'Good work');
    expect(accepted.status).toBe('accepted');

    const p2 = await manager.propose({
      title: 'Second proposal',
      description: 'Will be rejected',
      category: 'knowledge',
      content: 'Second knowledge content',
      author: 'carol',
      sourceProject: '/project/c',
      tags: ['second'],
      confidence: 0.6,
    });

    const rejected = await manager.review(p2.id, 'reject', 'reviewer-dave', 'Needs more detail');
    expect(rejected.status).toBe('rejected');

    // Verify final state
    const allProposals = await manager.listProposals();
    expect(allProposals).toHaveLength(2);

    const skills = await tier.listEntries('skill');
    expect(skills.some((e) => e.content === 'First skill content')).toBe(true);

    // Rejected proposal content should NOT be in the knowledge tier
    const knowledge = await tier.listEntries('knowledge');
    expect(knowledge.some((e) => e.content === 'Second knowledge content')).toBe(false);
  });
});
