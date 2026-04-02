/**
 * Cross-Project Learning — Skill Promotion Pipeline
 *
 * Manages the lifecycle of promoting skills from individual project stores
 * to the global `~/.apex/` store, enabling cross-project knowledge transfer.
 *
 * The pipeline evaluates skills against configurable promotion rules,
 * handles conflict resolution when a global skill with the same name
 * already exists, and records promotion history for auditability.
 */

import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import type { StoredSkill } from '../memory/procedural.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Rules that govern automatic skill promotion eligibility.
 *
 * A skill must meet ALL criteria to be auto-promoted.
 */
export interface PromotionRule {
  /** Minimum number of projects where the skill succeeded. */
  minProjectCount: number;
  /** Minimum success rate across all uses. */
  minSuccessRate: number;
  /** Minimum confidence score. */
  minConfidence: number;
  /** Minimum total usage count. */
  minUsageCount: number;
}

/**
 * A skill that has been evaluated for promotion eligibility.
 */
export interface PromotionCandidate {
  skill: StoredSkill;
  projectPath: string;
  projectName: string;
  reason: 'auto' | 'manual';
  meetsRules: boolean;
  ruleResults: Record<string, boolean>;
}

/**
 * The outcome of a single promotion attempt.
 */
export interface PromotionResult {
  skillId: string;
  skillName: string;
  promoted: boolean;
  reason: string;
  /** If promoted, the global skill ID (may differ if merged with existing). */
  globalSkillId?: string;
}

/**
 * Constructor options for {@link SkillPromotionPipeline}.
 */
export interface PromotionPipelineOptions {
  projectStore: FileStore;
  globalStore: FileStore;
  rules?: Partial<PromotionRule>;
  logger?: Logger;
}

/**
 * Internal record stored in the global `'promotions'` collection
 * to track promotion history.
 */
interface PromotionRecord {
  id: string;
  skillId: string;
  skillName: string;
  globalSkillId: string;
  projectPath: string;
  projectName: string;
  reason: 'auto' | 'manual';
  merged: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILLS_COLLECTION = 'skills';
const PROMOTIONS_COLLECTION = 'promotions';

const DEFAULT_RULES: PromotionRule = {
  minProjectCount: 1,
  minSuccessRate: 0.7,
  minConfidence: 0.5,
  minUsageCount: 3,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages the promotion of skills from a project-level store to the
 * global `~/.apex/` store.
 *
 * Supports both automatic promotion (skills that meet configurable rules)
 * and manual promotion (by explicit skill ID). Handles conflict resolution
 * when a global skill with the same name already exists by merging
 * provenance and keeping the higher-quality version.
 */
export class SkillPromotionPipeline {
  private readonly projectStore: FileStore;
  private readonly globalStore: FileStore;
  private readonly rules: PromotionRule;
  private readonly logger: Logger;

  constructor(opts: PromotionPipelineOptions) {
    this.projectStore = opts.projectStore;
    this.globalStore = opts.globalStore;
    this.rules = { ...DEFAULT_RULES, ...opts.rules };
    this.logger = opts.logger ?? new Logger({ prefix: 'promotion' });
  }

  // -----------------------------------------------------------------------
  // Candidate discovery
  // -----------------------------------------------------------------------

  /**
   * Check which project skills are eligible for auto-promotion.
   *
   * Reads all skills from the project store, evaluates each against the
   * promotion rules, and returns candidates that meet all criteria.
   *
   * @returns Array of promotion candidates with their rule evaluation results.
   */
  async findCandidates(): Promise<PromotionCandidate[]> {
    const skills = await this.projectStore.readAll<StoredSkill>(SKILLS_COLLECTION);
    const candidates: PromotionCandidate[] = [];

    for (const skill of skills) {
      if (skill.archived) continue;

      const { meetsRules, ruleResults } = this.evaluate(skill);

      if (meetsRules) {
        candidates.push({
          skill,
          projectPath: skill.sourceProject,
          projectName: this.extractProjectName(skill.sourceProject),
          reason: 'auto',
          meetsRules,
          ruleResults,
        });
      }
    }

    this.logger.info(`Found ${candidates.length} promotion candidates out of ${skills.length} skills`);
    return candidates;
  }

  // -----------------------------------------------------------------------
  // Evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate a single skill against promotion rules.
   *
   * @param skill - The skill to evaluate.
   * @returns Whether the skill meets all rules and the per-rule results.
   */
  evaluate(skill: StoredSkill): { meetsRules: boolean; ruleResults: Record<string, boolean> } {
    const ruleResults: Record<string, boolean> = {
      minSuccessRate: skill.successRate >= this.rules.minSuccessRate,
      minConfidence: skill.confidence >= this.rules.minConfidence,
      minUsageCount: skill.usageCount >= this.rules.minUsageCount,
      minProjectCount: true, // Single-project check for now
    };

    const meetsRules = Object.values(ruleResults).every(Boolean);

    return { meetsRules, ruleResults };
  }

  // -----------------------------------------------------------------------
  // Promotion
  // -----------------------------------------------------------------------

  /**
   * Promote a skill to the global store. Handles conflict resolution
   * when a global skill with the same name already exists.
   *
   * @param candidate - The promotion candidate to promote.
   * @returns The result of the promotion attempt.
   */
  async promote(candidate: PromotionCandidate): Promise<PromotionResult> {
    const { skill } = candidate;

    // Check for conflicts
    const conflict = await this.checkConflict(skill.name);

    if (conflict.hasConflict && conflict.existingSkillId) {
      this.logger.info(`Conflict detected for "${skill.name}", resolving...`);
      return this.resolveConflict(skill, conflict.existingSkillId);
    }

    // No conflict — write a new global skill
    const globalSkillId = generateId();
    const globalSkill = this.toSerializable({
      ...skill,
      id: globalSkillId,
      updatedAt: Date.now(),
    });

    await this.globalStore.write(SKILLS_COLLECTION, globalSkillId, globalSkill);
    await this.recordPromotion({
      skillId: skill.id,
      skillName: skill.name,
      globalSkillId,
      projectPath: candidate.projectPath,
      projectName: candidate.projectName,
      reason: candidate.reason,
      merged: false,
    });

    this.logger.info(`Promoted "${skill.name}" to global store as ${globalSkillId}`);

    return {
      skillId: skill.id,
      skillName: skill.name,
      promoted: true,
      reason: `Skill promoted to global store (${candidate.reason})`,
      globalSkillId,
    };
  }

  /**
   * Manual promotion: promote by skill ID regardless of rules.
   *
   * @param skillId - The project skill ID to promote.
   * @param projectPath - The project path for provenance.
   * @param projectName - The project name for provenance.
   * @returns The result of the promotion attempt.
   */
  async manualPromote(skillId: string, projectPath: string, projectName: string): Promise<PromotionResult> {
    const skill = await this.projectStore.read<StoredSkill>(SKILLS_COLLECTION, skillId);

    if (!skill) {
      return {
        skillId,
        skillName: 'unknown',
        promoted: false,
        reason: `Skill ${skillId} not found in project store`,
      };
    }

    const { meetsRules, ruleResults } = this.evaluate(skill);

    const candidate: PromotionCandidate = {
      skill,
      projectPath,
      projectName,
      reason: 'manual',
      meetsRules,
      ruleResults,
    };

    return this.promote(candidate);
  }

  // -----------------------------------------------------------------------
  // Conflict resolution
  // -----------------------------------------------------------------------

  /**
   * Check for conflicts: does a global skill with the same name exist?
   *
   * @param skillName - The skill name to check.
   * @returns Whether a conflict exists and the ID of the existing global skill.
   */
  async checkConflict(skillName: string): Promise<{ hasConflict: boolean; existingSkillId?: string }> {
    const globalSkills = await this.globalStore.readAll<StoredSkill>(SKILLS_COLLECTION);
    const existing = globalSkills.find(
      (s) => s.name.toLowerCase() === skillName.toLowerCase(),
    );

    if (existing) {
      return { hasConflict: true, existingSkillId: existing.id };
    }

    return { hasConflict: false };
  }

  /**
   * Resolve conflict: merge provenance, keep higher confidence version.
   *
   * Strategy:
   * 1. If the local skill has higher confidence, update the global skill's
   *    pattern and description.
   * 2. Always merge provenance arrays (add new project to the list).
   * 3. Keep the higher success rate.
   * 4. Return the merged result.
   *
   * @param localSkill - The project-level skill being promoted.
   * @param globalSkillId - The ID of the conflicting global skill.
   * @returns The result of the merge operation.
   */
  async resolveConflict(localSkill: StoredSkill, globalSkillId: string): Promise<PromotionResult> {
    const globalSkill = await this.globalStore.read<StoredSkill>(SKILLS_COLLECTION, globalSkillId);

    if (!globalSkill) {
      return {
        skillId: localSkill.id,
        skillName: localSkill.name,
        promoted: false,
        reason: `Global skill ${globalSkillId} not found during conflict resolution`,
      };
    }

    // Merge provenance: combine source files from both skills
    const mergedSourceFiles = [
      ...new Set([...globalSkill.sourceFiles, ...localSkill.sourceFiles]),
    ];

    // Merge tags
    const mergedTags = [...new Set([...globalSkill.tags, ...localSkill.tags])];

    // Keep higher success rate
    const mergedSuccessRate = Math.max(globalSkill.successRate, localSkill.successRate);

    // Sum usage counts
    const mergedUsageCount = globalSkill.usageCount + localSkill.usageCount;

    // Build the merged skill
    const merged: StoredSkill = {
      ...globalSkill,
      // If local has higher confidence, use its pattern and description
      pattern: localSkill.confidence > globalSkill.confidence
        ? localSkill.pattern
        : globalSkill.pattern,
      description: localSkill.confidence > globalSkill.confidence
        ? localSkill.description
        : globalSkill.description,
      successRate: mergedSuccessRate,
      usageCount: mergedUsageCount,
      confidence: Math.max(globalSkill.confidence, localSkill.confidence),
      sourceFiles: mergedSourceFiles,
      tags: mergedTags,
      updatedAt: Date.now(),
    };

    await this.globalStore.write(SKILLS_COLLECTION, globalSkillId, this.toSerializable(merged));
    await this.recordPromotion({
      skillId: localSkill.id,
      skillName: localSkill.name,
      globalSkillId,
      projectPath: localSkill.sourceProject,
      projectName: this.extractProjectName(localSkill.sourceProject),
      reason: 'auto',
      merged: true,
    });

    this.logger.info(
      `Merged "${localSkill.name}" into existing global skill ${globalSkillId}`,
    );

    return {
      skillId: localSkill.id,
      skillName: localSkill.name,
      promoted: true,
      reason: 'Merged with existing global skill (conflict resolved)',
      globalSkillId,
    };
  }

  // -----------------------------------------------------------------------
  // Auto-promotion
  // -----------------------------------------------------------------------

  /**
   * Run auto-promotion for all eligible skills.
   *
   * Discovers candidates, evaluates them, and promotes each one that
   * meets the configured rules.
   *
   * @returns Results for each promotion attempt.
   */
  async runAutoPromotion(): Promise<PromotionResult[]> {
    const candidates = await this.findCandidates();
    const results: PromotionResult[] = [];

    for (const candidate of candidates) {
      const result = await this.promote(candidate);
      results.push(result);
    }

    const promoted = results.filter((r) => r.promoted).length;
    this.logger.info(
      `Auto-promotion complete: ${promoted}/${results.length} skills promoted`,
    );

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Record a promotion event in the global store for audit purposes.
   */
  private async recordPromotion(
    data: Omit<PromotionRecord, 'id' | 'timestamp'>,
  ): Promise<void> {
    const record: PromotionRecord = {
      id: generateId(),
      ...data,
      timestamp: Date.now(),
    };

    await this.globalStore.write(PROMOTIONS_COLLECTION, record.id, record);
  }

  /**
   * Convert a StoredSkill to a JSON-serializable form.
   *
   * BigInt `simhash` values are not natively JSON-serializable, so they
   * must be converted to strings for persistence.
   */
  private toSerializable(skill: StoredSkill): Record<string, unknown> {
    return {
      ...skill,
      embedding: skill.embedding
        ? { keywords: skill.embedding.keywords, simhash: String(skill.embedding.simhash) }
        : undefined,
    };
  }

  /**
   * Extract a human-readable project name from a file path.
   *
   * @param projectPath - Absolute path to the project root.
   * @returns The last path segment as the project name.
   */
  private extractProjectName(projectPath: string): string {
    if (!projectPath) return 'unknown';
    const segments = projectPath.replace(/\/+$/, '').split('/');
    return segments[segments.length - 1] || 'unknown';
  }
}
