/**
 * Cross-Project Learning — Phase 7
 *
 * Orchestrates recall across project-local memory, the global `~/.apex/`
 * store, and optionally other registered projects. Enhances `apex_recall`
 * to search across project boundaries while maintaining privacy boundaries
 * (only skills and semantic knowledge are shared — never raw episodes).
 */

import type { MemoryEntry, MemoryTier, SearchResult, ProjectProfile } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import { ProceduralMemory, type StoredSkill } from './procedural.js';
import { SemanticMemory } from './semantic.js';
import { getEmbedding } from '../utils/embeddings.js';
import { combinedSimilarity } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies where a search result originated. */
export type ResultSource = 'project' | 'global' | `project:${string}`;

/**
 * A search result with cross-project source tagging.
 *
 * Extends the base {@link SearchResult} with a more specific `source` field
 * and an optional project name for results from other projects.
 */
export interface CrossProjectSearchResult extends Omit<SearchResult, 'source'> {
  /** More specific source tagging: 'project', 'global', or 'project:other-name' */
  source: ResultSource;
  /** Name of the source project if from another project */
  sourceProjectName?: string;
}

/** Configuration for the {@link CrossProjectQuery} constructor. */
export interface CrossProjectQueryOptions {
  /** FileStore for the current project's .apex-data/ */
  projectStore: FileStore;
  /** FileStore for ~/.apex/ global store */
  globalStore: FileStore;
  /** Current project's profile (for tech stack comparison) */
  currentProject?: ProjectProfile;
  /** Logger instance */
  logger?: Logger;
}

/** Tuning knobs for tech-stack relevance boosting. */
export interface TechStackBoostConfig {
  /** Boost multiplier for same-tech-stack results. Default 1.2 */
  sameStackBoost: number;
  /** Boost multiplier for same-language results. Default 1.1 */
  sameLanguageBoost: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discount applied to global results relative to project results. */
const GLOBAL_SCORE_DISCOUNT = 0.9;

/** Default tech-stack boost configuration. */
const DEFAULT_BOOST_CONFIG: TechStackBoostConfig = {
  sameStackBoost: 1.2,
  sameLanguageBoost: 1.1,
};

/**
 * Languages are identified by the first element of a project's tech stack
 * that matches one of these known primary-language identifiers.
 */
const PRIMARY_LANGUAGES = new Set([
  'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'kotlin',
  'swift', 'ruby', 'c', 'cpp', 'c++', 'csharp', 'c#', 'php', 'scala',
  'elixir', 'haskell', 'dart', 'zig', 'ocaml',
]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Cross-Project Query orchestrates recall across project-local memory,
 * the global `~/.apex/` store, and optionally other registered projects.
 *
 * **Privacy boundary**: only searches skills (procedural memory) and semantic
 * knowledge from other sources — never raw episodic memories.
 *
 * @example
 * ```ts
 * const cpq = new CrossProjectQuery({
 *   projectStore,
 *   globalStore,
 *   currentProject: projectProfile,
 * });
 * const results = await cpq.search('error handling patterns', 10);
 * ```
 */
export class CrossProjectQuery {
  private readonly projectStore: FileStore;
  private readonly globalStore: FileStore;
  private readonly logger: Logger;
  private readonly boostConfig: TechStackBoostConfig;
  private currentProject: ProjectProfile | undefined;

  constructor(opts: CrossProjectQueryOptions) {
    this.projectStore = opts.projectStore;
    this.globalStore = opts.globalStore;
    this.currentProject = opts.currentProject;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:cross-project' });
    this.boostConfig = { ...DEFAULT_BOOST_CONFIG };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Search across project + global stores.
   *
   * 1. Search current project skills and knowledge (source: `'project'`)
   * 2. Search global skills and knowledge (source: `'global'`)
   * 3. Apply tech-stack relevance boost for same-stack results
   * 4. Merge, deduplicate, sort by score, take topK
   *
   * **Privacy boundary**: only searches skills and semantic knowledge —
   * never raw episodes from other projects.
   *
   * @param query - Free-text search query.
   * @param topK  - Maximum number of results to return. Default 10.
   * @returns Ranked array of {@link CrossProjectSearchResult}.
   */
  async search(query: string, topK = 10): Promise<CrossProjectSearchResult[]> {
    // Search project and global in parallel
    const [projectResults, globalResults] = await Promise.all([
      this.searchProject(query, topK),
      this.searchGlobal(query, topK),
    ]);

    // Merge all results
    let merged: CrossProjectSearchResult[] = [...projectResults, ...globalResults];

    // Deduplicate by entry ID — prefer project version (listed first)
    const seen = new Set<string>();
    merged = merged.filter((r) => {
      if (seen.has(r.entry.id)) return false;
      seen.add(r.entry.id);
      return true;
    });

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);

    // Take top-k
    return merged.slice(0, topK);
  }

  /**
   * Search only the global store.
   *
   * Searches global skills and semantic knowledge, applies tech-stack
   * boosting, and returns the top-k results tagged with `source: 'global'`.
   *
   * @param query - Free-text search query.
   * @param topK  - Maximum number of results to return. Default 10.
   * @returns Ranked array of {@link CrossProjectSearchResult}.
   */
  async searchGlobal(query: string, topK = 10): Promise<CrossProjectSearchResult[]> {
    const [skillResults, knowledgeResults] = await Promise.all([
      this.searchGlobalSkills(query, topK),
      this.searchGlobalKnowledge(query, topK),
    ]);

    let merged: CrossProjectSearchResult[] = [...skillResults, ...knowledgeResults];

    // Deduplicate by entry ID
    const seen = new Set<string>();
    merged = merged.filter((r) => {
      if (seen.has(r.entry.id)) return false;
      seen.add(r.entry.id);
      return true;
    });

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);

    return merged.slice(0, topK);
  }

  /**
   * Compute a tech-stack relevance boost for a result based on its source
   * project's tech stack.
   *
   * If the source project shares tech stack with the current project, the
   * boost is multiplicative:
   * - Same primary language: {@link TechStackBoostConfig.sameLanguageBoost} (default 1.1)
   * - Overlapping frameworks: {@link TechStackBoostConfig.sameStackBoost} (default 1.2)
   *
   * @param sourceProjectTechStack - Tech stack of the source project.
   * @returns Multiplicative boost factor (>= 1.0).
   */
  computeTechStackBoost(sourceProjectTechStack: string[]): number {
    if (!this.currentProject || sourceProjectTechStack.length === 0) {
      return 1.0;
    }

    const currentStack = this.currentProject.techStack.map((t) => t.toLowerCase());
    const sourceStack = sourceProjectTechStack.map((t) => t.toLowerCase());

    if (currentStack.length === 0) return 1.0;

    let boost = 1.0;

    // Check for same primary language
    const currentLang = currentStack.find((t) => PRIMARY_LANGUAGES.has(t));
    const sourceLang = sourceStack.find((t) => PRIMARY_LANGUAGES.has(t));

    if (currentLang && sourceLang && currentLang === sourceLang) {
      boost *= this.boostConfig.sameLanguageBoost;
    }

    // Check for overlapping frameworks (non-language tech stack items)
    const currentFrameworks = new Set(currentStack.filter((t) => !PRIMARY_LANGUAGES.has(t)));
    const hasOverlap = sourceStack.some(
      (t) => !PRIMARY_LANGUAGES.has(t) && currentFrameworks.has(t),
    );

    if (hasOverlap) {
      boost *= this.boostConfig.sameStackBoost;
    }

    return boost;
  }

  /**
   * Register the current project's tech stack for boost calculations.
   *
   * @param profile - The current project's profile.
   */
  setCurrentProject(profile: ProjectProfile): void {
    this.currentProject = profile;
    this.logger.info(`Current project set to "${profile.name}"`);
  }

  // -----------------------------------------------------------------------
  // Private — project search
  // -----------------------------------------------------------------------

  /**
   * Search the current project's skills and semantic knowledge.
   *
   * Project results receive no score discount (they are the most relevant).
   */
  private async searchProject(
    query: string,
    topK: number,
  ): Promise<CrossProjectSearchResult[]> {
    const [skillResults, knowledgeResults] = await Promise.all([
      this.searchProjectSkills(query, topK),
      this.searchProjectKnowledge(query, topK),
    ]);

    return [...skillResults, ...knowledgeResults];
  }

  /** Search project-local skills via ProceduralMemory. */
  private async searchProjectSkills(
    query: string,
    topK: number,
  ): Promise<CrossProjectSearchResult[]> {
    const procedural = new ProceduralMemory({ fileStore: this.projectStore });
    await procedural.load();

    const results = await procedural.findByQuery(query, topK);

    return results.map((r) => ({
      entry: this.skillToMemoryEntry(r.skill, 'project'),
      score: r.score,
      sourceTier: 'procedural' as MemoryTier,
      source: 'project' as ResultSource,
    }));
  }

  /** Search project-local semantic knowledge. */
  private async searchProjectKnowledge(
    query: string,
    topK: number,
  ): Promise<CrossProjectSearchResult[]> {
    const semantic = new SemanticMemory({ fileStore: this.projectStore });
    await semantic.load();

    const results = await semantic.search(query, topK);

    return results.map((r) => ({
      entry: r.entry,
      score: r.score,
      sourceTier: 'semantic' as MemoryTier,
      source: 'project' as ResultSource,
    }));
  }

  // -----------------------------------------------------------------------
  // Private — global search
  // -----------------------------------------------------------------------

  /**
   * Search global skills via ProceduralMemory backed by the global FileStore.
   *
   * Global skill scores are discounted by {@link GLOBAL_SCORE_DISCOUNT} and
   * then boosted by tech-stack relevance if the source project shares tech
   * with the current project.
   */
  private async searchGlobalSkills(
    query: string,
    topK: number,
  ): Promise<CrossProjectSearchResult[]> {
    const globalProcedural = new ProceduralMemory({ fileStore: this.globalStore });
    await globalProcedural.load();

    const results = await globalProcedural.findByQuery(query, topK);

    return results.map((r) => {
      // Apply global discount
      let score = r.score * GLOBAL_SCORE_DISCOUNT;

      // Apply tech-stack boost if source project info is available
      if (r.skill.sourceProject && this.currentProject) {
        const sourceTechStack = this.inferTechStack(r.skill);
        score *= this.computeTechStackBoost(sourceTechStack);
      }

      return {
        entry: this.skillToMemoryEntry(r.skill, 'global'),
        score,
        sourceTier: 'procedural' as MemoryTier,
        source: 'global' as ResultSource,
        sourceProjectName: r.skill.sourceProject || undefined,
      };
    });
  }

  /**
   * Search global semantic knowledge.
   *
   * Reads all entries from the `'knowledge'` collection in the global store
   * and scores them using the embedding/similarity system. Results are
   * discounted by {@link GLOBAL_SCORE_DISCOUNT}.
   */
  private async searchGlobalKnowledge(
    query: string,
    topK: number,
  ): Promise<CrossProjectSearchResult[]> {
    const ids = await this.globalStore.list('knowledge');
    if (ids.length === 0) return [];

    const queryEmbed = getEmbedding(query);
    const scored: CrossProjectSearchResult[] = [];

    for (const id of ids) {
      const entry = await this.globalStore.read<MemoryEntry>('knowledge', id);
      if (!entry) continue;

      const entryEmbed = getEmbedding(entry.content);
      const rawScore = combinedSimilarity(queryEmbed, entryEmbed);
      const score = rawScore * GLOBAL_SCORE_DISCOUNT;

      scored.push({
        entry,
        score,
        sourceTier: 'semantic' as MemoryTier,
        source: 'global' as ResultSource,
      });
    }

    // Sort and take top-k
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // -----------------------------------------------------------------------
  // Private — helpers
  // -----------------------------------------------------------------------

  /**
   * Convert a {@link StoredSkill} to a {@link MemoryEntry} for uniform
   * result representation.
   */
  private skillToMemoryEntry(
    skill: StoredSkill,
    source: 'project' | 'global',
  ): MemoryEntry {
    const prefix = source === 'global' ? 'Global Skill' : 'Skill';
    return {
      id: skill.id,
      content: `[${prefix}: ${skill.name}] ${skill.description}\nPattern: ${skill.pattern}`,
      heatScore: skill.confidence,
      confidence: skill.confidence,
      createdAt: skill.createdAt,
      accessedAt: skill.updatedAt,
      sourceFiles: skill.sourceFiles,
      tier: 'procedural' as MemoryTier,
    };
  }

  /**
   * Infer a tech stack from a skill's tags and metadata.
   *
   * Skills don't store a full tech stack, but their tags often contain
   * language and framework names that can be used for boost calculations.
   */
  private inferTechStack(skill: StoredSkill): string[] {
    // Use tags as a proxy for tech stack
    return skill.tags;
  }
}
