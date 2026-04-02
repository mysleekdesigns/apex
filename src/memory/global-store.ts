/**
 * Global Store — Cross-Project Learning (Phase 7)
 *
 * Manages the `~/.apex/` directory: the shared knowledge base that spans all
 * projects. Provides a global skill registry with provenance tracking, a
 * semantic knowledge base, a user learning profile, and a project registry.
 */

import { mkdir, readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';

import { generateId, type Skill } from '../types.js';
import { getEmbedding, type EmbeddingResult } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import { type StoredSkill } from './procedural.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Provenance record tracking which project contributed a global skill. */
interface SkillProvenance {
  /** Absolute path to the project root. */
  projectPath: string;

  /** Human-readable project name. */
  projectName: string;

  /** Unix-epoch millisecond timestamp of when the skill was promoted. */
  promotedAt: number;
}

/**
 * A skill that has been promoted to the global registry.
 *
 * Extends {@link StoredSkill} with cross-project provenance tracking and a
 * global usage counter.
 */
export interface GlobalSkill extends StoredSkill {
  /** Projects that have contributed to or promoted this skill. */
  provenance: SkillProvenance[];

  /** Number of times this skill has been used across all projects. */
  globalUsageCount: number;
}

/**
 * A semantic-level knowledge entry that applies across projects.
 *
 * Knowledge entries capture language patterns, framework idioms, debugging
 * strategies, and other reusable insights distilled from raw episodes.
 */
export interface KnowledgeEntry {
  /** Unique identifier for this entry. */
  id: string;

  /** The knowledge content (free-form text). */
  content: string;

  /** Category such as `"language-pattern"`, `"debugging"`, `"framework"`. */
  category: string;

  /** Free-form tags for retrieval. */
  tags: string[];

  /** Project paths that contributed to this knowledge. */
  sourceProjects: string[];

  /** Confidence that this knowledge is still accurate, in `[0, 1]`. */
  confidence: number;

  /** Unix-epoch millisecond timestamp of when the entry was created. */
  createdAt: number;

  /** Unix-epoch millisecond timestamp of the last update. */
  updatedAt: number;
}

/**
 * Aggregate learning statistics across all projects for a user.
 */
export interface UserLearningProfile {
  /** Total episodes recorded across all projects. */
  totalEpisodes: number;

  /** Total skills learned across all projects. */
  totalSkills: number;

  /** Total number of registered projects. */
  totalProjects: number;

  /** Skill count broken down by category / tag. */
  skillsByCategory: Record<string, number>;

  /** Most active problem domains (e.g. `["typescript", "react"]`). */
  activeDomains: string[];

  /** Skills learned per week (rolling average). */
  learningVelocity: number;

  /** Unix-epoch millisecond timestamp of the user's first recorded activity. */
  firstSeen: number;

  /** Unix-epoch millisecond timestamp of the most recent activity. */
  lastActive: number;
}

/**
 * Configuration options for {@link GlobalStoreManager}.
 */
export interface GlobalStoreManagerOptions {
  /** Absolute path to the global data directory (typically `~/.apex`). */
  globalDataPath: string;

  /** Optional logger instance. */
  logger?: Logger;
}

/** Shape of a registered project entry stored on disk. */
interface RegisteredProject {
  /** Absolute path to the project root. */
  path: string;

  /** Human-readable project name. */
  name: string;

  /** Unix-epoch millisecond timestamp of when the project was registered. */
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILLS_COLLECTION = 'skills';
const KNOWLEDGE_DIR = 'knowledge';
const PROFILES_DIR = 'profiles';
const PROJECTS_DIR = 'projects';
const USER_PROFILE_FILE = 'user-profile.json';
const PROJECTS_REGISTRY_FILE = 'registry.json';
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages the global `~/.apex/` data directory.
 *
 * Provides:
 * - A global skill registry with project-of-origin provenance tracking
 * - A cross-project knowledge base for semantic-level insights
 * - A user learning profile aggregating stats across all projects
 * - A project registry tracking all known APEX-enabled projects
 */
export class GlobalStoreManager {
  private readonly globalDataPath: string;
  private readonly logger: Logger;
  private fileStore!: FileStore;

  /** In-memory cache of global skills, keyed by skill ID. */
  private skills: Map<string, GlobalSkill> = new Map();

  /** Whether the in-memory skill index has been hydrated from disk. */
  private skillsLoaded = false;

  constructor(opts: GlobalStoreManagerOptions) {
    this.globalDataPath = opts.globalDataPath;
    this.logger = opts.logger ?? new Logger({ prefix: 'global-store' });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialise the global data directory and internal stores.
   *
   * Creates the `~/.apex/` directory structure if it does not already exist:
   * `skills/`, `knowledge/`, `profiles/`, `projects/`.
   */
  async init(): Promise<void> {
    // Create subdirectories that FileStore won't create automatically
    const dirs = [KNOWLEDGE_DIR, PROFILES_DIR, PROJECTS_DIR];
    for (const dir of dirs) {
      await mkdir(path.join(this.globalDataPath, dir), { recursive: true });
    }

    // Initialise FileStore (creates its default collections including skills/)
    this.fileStore = new FileStore(this.globalDataPath);
    await this.fileStore.init();

    this.logger.info(`Global store initialised at ${this.globalDataPath}`);
  }

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  /**
   * Promote a project-level skill to the global registry.
   *
   * If a global skill with the same ID already exists, the new project is
   * appended to the provenance list and usage counts are merged. Otherwise
   * a new {@link GlobalSkill} is created.
   *
   * @param skill - The project-level skill to promote.
   * @param projectPath - Absolute path to the originating project.
   * @param projectName - Human-readable name of the originating project.
   * @returns The newly-created or updated GlobalSkill.
   */
  async addGlobalSkill(
    skill: StoredSkill,
    projectPath: string,
    projectName: string,
  ): Promise<GlobalSkill> {
    await this.ensureSkillsLoaded();

    const now = Date.now();
    const provenance: SkillProvenance = { projectPath, projectName, promotedAt: now };

    const existing = this.skills.get(skill.id);

    if (existing) {
      // Append provenance if this project hasn't already been recorded
      const alreadyTracked = existing.provenance.some(
        (p) => p.projectPath === projectPath,
      );
      if (!alreadyTracked) {
        existing.provenance.push(provenance);
      }

      // Merge usage counts
      existing.globalUsageCount += skill.usageCount;
      existing.updatedAt = now;

      // Update success rate as a weighted average
      const totalUsage = existing.usageCount + skill.usageCount;
      if (totalUsage > 0) {
        existing.successRate =
          (existing.successRate * existing.usageCount +
            skill.successRate * skill.usageCount) /
          totalUsage;
      }
      existing.usageCount = totalUsage;

      await this.persistSkill(existing);
      this.logger.info(
        `Updated global skill "${existing.name}" with provenance from "${projectName}"`,
      );
      return existing;
    }

    // Create a new global skill
    const globalSkill: GlobalSkill = {
      ...skill,
      provenance: [provenance],
      globalUsageCount: skill.usageCount,
      embedding: this.buildEmbedding(skill.name, skill.description, skill.tags),
    };

    this.skills.set(globalSkill.id, globalSkill);
    await this.persistSkill(globalSkill);

    this.logger.info(
      `Added global skill "${globalSkill.name}" from "${projectName}"`,
    );
    return globalSkill;
  }

  /**
   * Retrieve a global skill by ID.
   *
   * @param id - The skill ID.
   * @returns The GlobalSkill, or null if not found.
   */
  async getGlobalSkill(id: string): Promise<GlobalSkill | null> {
    await this.ensureSkillsLoaded();
    return this.skills.get(id) ?? null;
  }

  /**
   * List all global skills.
   *
   * @returns Array of all GlobalSkill entries.
   */
  async listGlobalSkills(): Promise<GlobalSkill[]> {
    await this.ensureSkillsLoaded();
    return [...this.skills.values()];
  }

  /**
   * Search global skills by semantic similarity to a query string.
   *
   * Uses keyword Jaccard + SimHash similarity (same approach as
   * {@link ProceduralMemory}).
   *
   * @param query - Natural-language description of the task or skill.
   * @param topK - Maximum number of results. Default 5.
   * @returns Skills ranked by descending similarity score.
   */
  async searchGlobalSkills(
    query: string,
    topK = 5,
  ): Promise<Array<{ skill: GlobalSkill; score: number }>> {
    await this.ensureSkillsLoaded();

    const queryEmbedding = this.buildEmbedding(query, '', []);
    const results: Array<{ skill: GlobalSkill; score: number }> = [];

    for (const skill of this.skills.values()) {
      if (!skill.embedding) continue;
      const score = combinedSimilarity(queryEmbedding, skill.embedding);
      results.push({ skill, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Remove a global skill from the registry.
   *
   * @param id - The skill ID to remove.
   */
  async removeGlobalSkill(id: string): Promise<void> {
    await this.ensureSkillsLoaded();

    const skill = this.skills.get(id);
    if (!skill) return;

    this.skills.delete(id);
    await this.fileStore.delete(SKILLS_COLLECTION, id);

    this.logger.info(`Removed global skill "${skill.name}" (${id})`);
  }

  // -----------------------------------------------------------------------
  // Knowledge
  // -----------------------------------------------------------------------

  /**
   * Add a new entry to the global knowledge base.
   *
   * The `id`, `createdAt`, and `updatedAt` fields are auto-populated.
   *
   * @param entry - Knowledge entry data (without auto-generated fields).
   * @returns The fully-populated KnowledgeEntry.
   */
  async addKnowledge(
    entry: Omit<KnowledgeEntry, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<KnowledgeEntry> {
    const now = Date.now();
    const knowledge: KnowledgeEntry = {
      ...entry,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };

    const filePath = path.join(
      this.globalDataPath,
      KNOWLEDGE_DIR,
      `${knowledge.id}.json`,
    );
    await writeFile(filePath, JSON.stringify(knowledge, null, 2), 'utf-8');

    this.logger.info(
      `Added knowledge entry "${knowledge.id}" (category: ${knowledge.category})`,
    );
    return knowledge;
  }

  /**
   * Search the knowledge base by semantic similarity to a query string.
   *
   * Loads all knowledge entries, computes embeddings on-the-fly, and
   * returns the top-K most relevant entries.
   *
   * @param query - Natural-language search query.
   * @param topK - Maximum number of results. Default 5.
   * @returns Knowledge entries ranked by descending relevance.
   */
  async searchKnowledge(query: string, topK = 5): Promise<KnowledgeEntry[]> {
    const entries = await this.loadAllKnowledge();
    if (entries.length === 0) return [];

    const queryEmbedding = this.buildEmbedding(query, '', []);

    const scored = entries.map((entry) => {
      const entryEmbedding = this.buildEmbedding(
        entry.content,
        entry.category,
        entry.tags,
      );
      const score = combinedSimilarity(queryEmbedding, entryEmbedding);
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.entry);
  }

  // -----------------------------------------------------------------------
  // Profile
  // -----------------------------------------------------------------------

  /**
   * Load the user learning profile from disk.
   *
   * Returns a default empty profile if the file does not yet exist.
   *
   * @returns The current UserLearningProfile.
   */
  async getProfile(): Promise<UserLearningProfile> {
    const filePath = path.join(
      this.globalDataPath,
      PROFILES_DIR,
      USER_PROFILE_FILE,
    );

    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as UserLearningProfile;
    } catch {
      // No profile yet — return defaults
      const now = Date.now();
      return {
        totalEpisodes: 0,
        totalSkills: 0,
        totalProjects: 0,
        skillsByCategory: {},
        activeDomains: [],
        learningVelocity: 0,
        firstSeen: now,
        lastActive: now,
      };
    }
  }

  /**
   * Merge partial updates into the user learning profile and persist it.
   *
   * @param updates - Fields to merge into the existing profile.
   * @returns The updated UserLearningProfile.
   */
  async updateProfile(
    updates: Partial<UserLearningProfile>,
  ): Promise<UserLearningProfile> {
    const current = await this.getProfile();
    const updated: UserLearningProfile = { ...current, ...updates };

    // Recompute learning velocity: skills per week
    if (updated.firstSeen && updated.lastActive && updated.totalSkills > 0) {
      const elapsed = updated.lastActive - updated.firstSeen;
      const weeks = Math.max(1, elapsed / MS_PER_WEEK);
      updated.learningVelocity = updated.totalSkills / weeks;
    }

    const filePath = path.join(
      this.globalDataPath,
      PROFILES_DIR,
      USER_PROFILE_FILE,
    );
    await writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');

    this.logger.debug('Updated user learning profile');
    return updated;
  }

  /**
   * Register a project in the global project registry.
   *
   * If the project is already registered (matched by path), this is a no-op.
   *
   * @param projectPath - Absolute path to the project root.
   * @param projectName - Human-readable project name.
   */
  async registerProject(
    projectPath: string,
    projectName: string,
  ): Promise<void> {
    const projects = await this.loadProjectRegistry();
    const existing = projects.find((p) => p.path === projectPath);

    if (existing) {
      this.logger.debug(`Project "${projectName}" already registered`);
      return;
    }

    projects.push({
      path: projectPath,
      name: projectName,
      registeredAt: Date.now(),
    });

    await this.saveProjectRegistry(projects);

    // Update profile with new project count
    await this.updateProfile({
      totalProjects: projects.length,
      lastActive: Date.now(),
    });

    this.logger.info(`Registered project "${projectName}" at ${projectPath}`);
  }

  // -----------------------------------------------------------------------
  // Project registry
  // -----------------------------------------------------------------------

  /**
   * List all projects that have been registered with the global store.
   *
   * @returns Array of registered project records.
   */
  async listRegisteredProjects(): Promise<
    Array<{ path: string; name: string; registeredAt: number }>
  > {
    return this.loadProjectRegistry();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Ensure the in-memory skill index is hydrated from disk. */
  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoaded) return;

    const items = await this.fileStore.readAll<GlobalSkill>(SKILLS_COLLECTION);
    for (const skill of items) {
      // Reconstruct BigInt from serialised string if needed
      if (
        skill.embedding &&
        typeof skill.embedding.simhash === 'string'
      ) {
        skill.embedding.simhash = BigInt(
          skill.embedding.simhash as unknown as string,
        );
      }
      this.skills.set(skill.id, skill);
    }

    this.skillsLoaded = true;
    this.logger.info(`Loaded ${this.skills.size} global skills`);
  }

  /**
   * Persist a global skill to disk via FileStore.
   *
   * Handles BigInt serialisation for the SimHash embedding field.
   */
  private async persistSkill(skill: GlobalSkill): Promise<void> {
    const serializable = {
      ...skill,
      embedding: skill.embedding
        ? {
            keywords: skill.embedding.keywords,
            simhash: String(skill.embedding.simhash),
          }
        : undefined,
    };

    await this.fileStore.write(SKILLS_COLLECTION, skill.id, serializable);
  }

  /**
   * Build an embedding from text components for similarity search.
   *
   * @param name - Primary text (skill name, knowledge content).
   * @param description - Secondary text.
   * @param tags - Additional tag strings.
   * @returns An EmbeddingResult with keywords and SimHash.
   */
  private buildEmbedding(
    name: string,
    description: string,
    tags: string[],
  ): EmbeddingResult {
    const text = [name, description, ...tags].filter(Boolean).join(' ');
    return getEmbedding(text);
  }

  /** Load all knowledge entries from the knowledge/ directory. */
  private async loadAllKnowledge(): Promise<KnowledgeEntry[]> {
    const dirPath = path.join(this.globalDataPath, KNOWLEDGE_DIR);
    const entries: KnowledgeEntry[] = [];

    try {
      const files = await readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(dirPath, file), 'utf-8');
          entries.push(JSON.parse(raw) as KnowledgeEntry);
        } catch {
          this.logger.warn(`Failed to read knowledge file: ${file}`);
        }
      }
    } catch {
      // Directory may not exist yet — return empty
    }

    return entries;
  }

  /** Load the project registry from disk. */
  private async loadProjectRegistry(): Promise<RegisteredProject[]> {
    const filePath = path.join(
      this.globalDataPath,
      PROJECTS_DIR,
      PROJECTS_REGISTRY_FILE,
    );

    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as RegisteredProject[];
    } catch {
      return [];
    }
  }

  /** Save the project registry to disk. */
  private async saveProjectRegistry(
    projects: RegisteredProject[],
  ): Promise<void> {
    const filePath = path.join(
      this.globalDataPath,
      PROJECTS_DIR,
      PROJECTS_REGISTRY_FILE,
    );
    await writeFile(filePath, JSON.stringify(projects, null, 2), 'utf-8');
  }
}
