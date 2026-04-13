/**
 * APEX Team Knowledge Sharing — barrel exports.
 */

export {
  KnowledgeTier,
  type SharedKnowledge,
  type TeamKnowledgeStats,
  type KnowledgeTierOptions,
} from './knowledge-tier.js';

export {
  ProposalManager,
  type Proposal,
  type TeamStatus,
  type ProposalManagerOptions,
} from './proposal.js';

export {
  FederationEngine,
  type MemberMetrics,
  type FederatedMetrics,
  type KnowledgeConflict,
  type FederationOptions,
} from './federation.js';
