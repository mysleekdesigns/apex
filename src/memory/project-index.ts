/**
 * Project Similarity Index — Phase 7: Cross-Project Learning
 *
 * Fingerprints projects based on tech stack, directory patterns, and
 * dependency overlap, then ranks them by similarity for cross-project
 * recall prioritization. Persists the index in the global ~/.apex/ store.
 */

import { generateId } from '../types.js';
import type { ProjectProfile } from '../types.js';
import { type FileStore } from '../utils/file-store.js';
import { type Logger } from '../utils/logger.js';
import { jaccardSimilarity } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Collection name for fingerprints in the global store. */
const COLLECTION = 'project-fingerprints';

/** Maximum number of dependencies to consider for similarity. */
const MAX_DEPENDENCIES = 50;

/** Weight for tech stack similarity in the overall score. */
const WEIGHT_TECH_STACK = 0.35;

/** Weight for dependency similarity in the overall score. */
const WEIGHT_DEPENDENCY = 0.30;

/** Weight for structural similarity in the overall score. */
const WEIGHT_STRUCTURAL = 0.20;

/** Weight for project type similarity in the overall score. */
const WEIGHT_TYPE = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A compact fingerprint of a project's characteristics. */
export interface ProjectFingerprint {
  /** Unique ID for this fingerprint. */
  id: string;
  /** Project name. */
  projectName: string;
  /** Absolute path to the project. */
  projectPath: string;
  /** High-level project type (e.g. 'node', 'python', 'rust'). */
  projectType: string;
  /** Detected tech stack (e.g. ['TypeScript', 'React', 'Express']). */
  techStack: string[];
  /** Top N dependency names (normalized, lowercase). */
  dependencies: string[];
  /** Structural patterns: directory names at depth 0-1 (e.g. ['src/', 'tests/', 'docs/']). */
  structuralPatterns: string[];
  /** When this fingerprint was created. */
  createdAt: number;
  /** When this fingerprint was last updated. */
  updatedAt: number;
}

/** Detailed similarity comparison between two projects. */
export interface SimilarityScore {
  /** The compared project's fingerprint. */
  fingerprint: ProjectFingerprint;
  /** Overall similarity score [0, 1]. */
  overallScore: number;
  /** Breakdown of similarity components. */
  breakdown: {
    techStackSimilarity: number;
    dependencySimilarity: number;
    structuralSimilarity: number;
    typeSimilarity: number;
  };
}

/** Constructor options for {@link ProjectSimilarityIndex}. */
export interface ProjectIndexOptions {
  /** FileStore for ~/.apex/ global directory. */
  globalStore: FileStore;
  /** Logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic ID from a project path so upserts are stable.
 *
 * Uses a simple hash (DJB2-style) of the absolute path string and encodes
 * the result in base-36.
 */
function pathToId(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `proj-${Math.abs(hash).toString(36)}`;
}

/**
 * Extract top-level directory names from a {@link ProjectProfile.structure}
 * array.
 *
 * The structure field contains indented strings like `"src/"`,
 * `"  components/"`. Only entries with no leading whitespace and ending in
 * `/` are considered top-level directories.
 */
function extractStructuralPatterns(structure: string[]): string[] {
  const patterns: string[] = [];
  for (const entry of structure) {
    // Top-level entries have no leading whitespace
    if (entry.length > 0 && entry[0] !== ' ' && entry[0] !== '\t' && entry.endsWith('/')) {
      patterns.push(entry.toLowerCase());
    }
  }
  return patterns;
}

/**
 * Normalize a list of strings to lowercase and deduplicate.
 */
function normalize(items: string[]): string[] {
  return [...new Set(items.map((s) => s.toLowerCase()))];
}

// ---------------------------------------------------------------------------
// ProjectSimilarityIndex
// ---------------------------------------------------------------------------

/**
 * Indexes registered projects and ranks them by similarity to a given
 * project profile.
 *
 * Similarity is computed as a weighted combination of tech-stack overlap,
 * dependency overlap, structural (directory) overlap, and project-type
 * match.
 */
export class ProjectSimilarityIndex {
  private readonly store: FileStore;
  private readonly logger?: Logger;

  constructor(opts: ProjectIndexOptions) {
    this.store = opts.globalStore;
    this.logger = opts.logger;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Create or update a fingerprint for a project.
   * Called during apex_setup or when project structure changes.
   */
  async upsertFingerprint(profile: ProjectProfile): Promise<ProjectFingerprint> {
    const id = pathToId(profile.path);
    const now = Date.now();

    const existing = await this.store.read<ProjectFingerprint>(COLLECTION, id);

    const fingerprint: ProjectFingerprint = {
      id,
      projectName: profile.name,
      projectPath: profile.path,
      projectType: profile.type.toLowerCase(),
      techStack: normalize(profile.techStack),
      dependencies: normalize(profile.dependencies).slice(0, MAX_DEPENDENCIES),
      structuralPatterns: extractStructuralPatterns(profile.structure),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.store.write(COLLECTION, id, fingerprint);
    this.logger?.info(`Upserted fingerprint for "${profile.name}" (${id})`);

    return fingerprint;
  }

  /**
   * Get the fingerprint for a project by its absolute path.
   */
  async getFingerprint(projectPath: string): Promise<ProjectFingerprint | null> {
    const id = pathToId(projectPath);
    return this.store.read<ProjectFingerprint>(COLLECTION, id);
  }

  /**
   * Get all registered project fingerprints.
   */
  async getAllFingerprints(): Promise<ProjectFingerprint[]> {
    const ids = await this.store.list(COLLECTION);
    const fingerprints: ProjectFingerprint[] = [];

    for (const id of ids) {
      const fp = await this.store.read<ProjectFingerprint>(COLLECTION, id);
      if (fp) {
        fingerprints.push(fp);
      }
    }

    return fingerprints;
  }

  /**
   * Remove a project fingerprint by its absolute path.
   */
  async removeFingerprint(projectPath: string): Promise<void> {
    const id = pathToId(projectPath);
    await this.store.delete(COLLECTION, id);
    this.logger?.info(`Removed fingerprint for path "${projectPath}" (${id})`);
  }

  // -----------------------------------------------------------------------
  // Similarity
  // -----------------------------------------------------------------------

  /**
   * Compute similarity between two project profiles or fingerprints.
   *
   * Accepts either a {@link ProjectProfile} or a {@link ProjectFingerprint}
   * and normalizes both inputs before comparison.
   */
  computeSimilarity(
    a: ProjectProfile | ProjectFingerprint,
    b: ProjectProfile | ProjectFingerprint,
  ): SimilarityScore {
    const aNorm = this.toNormalized(a);
    const bNorm = this.toNormalized(b);

    const techStackSimilarity = jaccardSimilarity(
      new Set(aNorm.techStack),
      new Set(bNorm.techStack),
    );

    const dependencySimilarity = jaccardSimilarity(
      new Set(aNorm.dependencies),
      new Set(bNorm.dependencies),
    );

    const structuralSimilarity = jaccardSimilarity(
      new Set(aNorm.structuralPatterns),
      new Set(bNorm.structuralPatterns),
    );

    const typeSimilarity = aNorm.projectType === bNorm.projectType ? 1.0 : 0.0;

    const overallScore =
      WEIGHT_TECH_STACK * techStackSimilarity +
      WEIGHT_DEPENDENCY * dependencySimilarity +
      WEIGHT_STRUCTURAL * structuralSimilarity +
      WEIGHT_TYPE * typeSimilarity;

    // Build a fingerprint-shaped object for `b` in the result
    const bFingerprint: ProjectFingerprint = this.isFingerprint(b)
      ? b
      : {
          id: pathToId((b as ProjectProfile).path),
          projectName: (b as ProjectProfile).name,
          projectPath: (b as ProjectProfile).path,
          projectType: bNorm.projectType,
          techStack: bNorm.techStack,
          dependencies: bNorm.dependencies,
          structuralPatterns: bNorm.structuralPatterns,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

    return {
      fingerprint: bFingerprint,
      overallScore,
      breakdown: {
        techStackSimilarity,
        dependencySimilarity,
        structuralSimilarity,
        typeSimilarity,
      },
    };
  }

  /**
   * Rank all registered projects by similarity to the given project.
   * Returns results sorted by descending overall score.
   */
  async rankBySimilarity(currentProject: ProjectProfile): Promise<SimilarityScore[]> {
    const fingerprints = await this.getAllFingerprints();
    const currentId = pathToId(currentProject.path);

    const scores: SimilarityScore[] = [];

    for (const fp of fingerprints) {
      // Skip comparing a project against itself
      if (fp.id === currentId) continue;

      scores.push(this.computeSimilarity(currentProject, fp));
    }

    scores.sort((x, y) => y.overallScore - x.overallScore);
    return scores;
  }

  /**
   * Find the top N most similar projects to the given one.
   *
   * @param currentProject - The project to compare against.
   * @param topN - Maximum number of results (default 5).
   */
  async findSimilar(
    currentProject: ProjectProfile,
    topN: number = 5,
  ): Promise<SimilarityScore[]> {
    const ranked = await this.rankBySimilarity(currentProject);
    return ranked.slice(0, topN);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Normalize a {@link ProjectProfile} or {@link ProjectFingerprint} into a
   * common shape for comparison.
   */
  private toNormalized(input: ProjectProfile | ProjectFingerprint): {
    projectType: string;
    techStack: string[];
    dependencies: string[];
    structuralPatterns: string[];
  } {
    if (this.isFingerprint(input)) {
      return {
        projectType: input.projectType,
        techStack: input.techStack,
        dependencies: input.dependencies,
        structuralPatterns: input.structuralPatterns,
      };
    }

    // ProjectProfile path
    return {
      projectType: input.type.toLowerCase(),
      techStack: normalize(input.techStack),
      dependencies: normalize(input.dependencies).slice(0, MAX_DEPENDENCIES),
      structuralPatterns: extractStructuralPatterns(input.structure),
    };
  }

  /**
   * Type guard: distinguish a {@link ProjectFingerprint} from a
   * {@link ProjectProfile}.
   */
  private isFingerprint(
    input: ProjectProfile | ProjectFingerprint,
  ): input is ProjectFingerprint {
    return 'projectType' in input && 'structuralPatterns' in input;
  }
}
