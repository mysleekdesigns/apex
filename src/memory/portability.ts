/**
 * Portability Manager — Cross-Project Skill Import/Export
 *
 * Handles exporting project skills as portable JSON bundles and importing
 * them into other projects with configurable merge strategies. Part of
 * Phase 7: Cross-Project Learning.
 */

import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';
import type { StoredSkill } from './procedural.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Skill with embedding stripped for JSON portability (BigInt is not serializable). */
export type ExportableSkill = Omit<StoredSkill, 'embedding'>;

/**
 * A portable bundle of skills that can be shared between projects.
 *
 * Designed to be JSON-serializable — BigInt embeddings are stripped at
 * export time and rebuilt on import by the receiving project's
 * ProceduralMemory.
 */
export interface SkillBundle {
  /** Bundle format version. */
  version: '1.0';

  /** Unix-epoch millisecond timestamp of when the bundle was created. */
  exportedAt: number;

  /** Name of the source project. */
  sourceProject: string;

  /** Absolute path to the source project. */
  sourceProjectPath: string;

  /** Skills included in the bundle (embedding stripped). */
  skills: ExportableSkill[];

  /** Aggregate metadata about the exported skills. */
  metadata: {
    totalSkills: number;
    avgConfidence: number;
    avgSuccessRate: number;
    tags: string[];
  };
}

/**
 * Result of an import operation, detailing what happened to each skill.
 */
export interface ImportResult {
  /** Total skills in the bundle. */
  total: number;

  /** Skills that were imported (new). */
  imported: number;

  /** Skills skipped as duplicates. */
  skipped: number;

  /** Skills that had conflicts (same name, different content). */
  conflicts: ImportConflict[];

  /** Skills that failed to import. */
  errors: string[];
}

/**
 * A conflict found during import when an incoming skill name matches
 * an existing skill in the target store.
 */
export interface ImportConflict {
  /** The skill from the bundle. */
  incomingSkill: ExportableSkill;

  /** The existing skill in the target store. */
  existingSkill: ExportableSkill;

  /** Reason for the conflict. */
  reason: string;
}

/**
 * Strategy for handling duplicate skills during import.
 *
 * - `'skip-duplicates'` — Skip incoming skills whose name matches an existing skill.
 * - `'overwrite'` — Replace existing skills with incoming ones on name match.
 * - `'keep-higher-confidence'` — On name conflict, keep whichever has higher confidence.
 */
export type MergeStrategy = 'skip-duplicates' | 'overwrite' | 'keep-higher-confidence';

/** Options for constructing a {@link PortabilityManager}. */
export interface PortabilityOptions {
  /** FileStore for the current project's `.apex-data/` directory. */
  projectStore: FileStore;

  /** Human-readable project name. */
  projectName?: string;

  /** Absolute path to the project root. */
  projectPath?: string;

  /** Logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'skills';
const BUNDLE_VERSION = '1.0' as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Manages import and export of skills as portable JSON bundles.
 *
 * Export strips BigInt embeddings (not JSON-safe) and produces a self-
 * contained {@link SkillBundle}. Import writes skills into a target
 * {@link FileStore} using the chosen {@link MergeStrategy}.
 */
export class PortabilityManager {
  private readonly projectStore: FileStore;
  private readonly projectName: string;
  private readonly projectPath: string;
  private readonly logger: Logger;

  constructor(opts: PortabilityOptions) {
    this.projectStore = opts.projectStore;
    this.projectName = opts.projectName ?? 'unknown';
    this.projectPath = opts.projectPath ?? '';
    this.logger = opts.logger ?? new Logger({ prefix: 'portability' });
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Export all active (non-archived) skills from the project as a portable
   * JSON bundle.
   *
   * Strips BigInt embeddings since they are not JSON-serializable. Archived
   * skills are excluded by default.
   *
   * @param filter - Optional filter to restrict which skills are exported.
   * @param filter.tags - Only export skills matching ALL of these tags.
   * @param filter.minConfidence - Only export skills at or above this confidence.
   * @returns A self-contained {@link SkillBundle}.
   */
  async exportBundle(filter?: { tags?: string[]; minConfidence?: number }): Promise<SkillBundle> {
    const allSkills = await this.projectStore.readAll<StoredSkill>(COLLECTION);

    // Filter: active only, then apply optional tag/confidence filters
    let skills = allSkills.filter((s) => !s.archived);

    if (filter?.tags && filter.tags.length > 0) {
      const requiredTags = new Set(filter.tags.map((t) => t.toLowerCase()));
      skills = skills.filter((s) =>
        [...requiredTags].every((tag) => s.tags.some((st) => st.toLowerCase() === tag)),
      );
    }

    if (filter?.minConfidence !== undefined) {
      const min = filter.minConfidence;
      skills = skills.filter((s) => s.confidence >= min);
    }

    // Strip embeddings for JSON portability
    const exportable: ExportableSkill[] = skills.map((s) => this.stripEmbedding(s));

    // Compute aggregate metadata
    const allTags = new Set<string>();
    for (const s of exportable) {
      for (const t of s.tags) allTags.add(t);
    }

    const metadata = {
      totalSkills: exportable.length,
      avgConfidence: exportable.length > 0
        ? exportable.reduce((sum, s) => sum + s.confidence, 0) / exportable.length
        : 0,
      avgSuccessRate: exportable.length > 0
        ? exportable.reduce((sum, s) => sum + s.successRate, 0) / exportable.length
        : 0,
      tags: [...allTags].sort(),
    };

    const bundle: SkillBundle = {
      version: BUNDLE_VERSION,
      exportedAt: Date.now(),
      sourceProject: this.projectName,
      sourceProjectPath: this.projectPath,
      skills: exportable,
      metadata,
    };

    this.logger.info(`Exported ${exportable.length} skills from "${this.projectName}"`);
    return bundle;
  }

  /**
   * Export bundle as a JSON string, ready to write to a file.
   *
   * @param filter - Optional filter (same as {@link exportBundle}).
   * @returns Pretty-printed JSON string.
   */
  async exportToJson(filter?: { tags?: string[]; minConfidence?: number }): Promise<string> {
    const bundle = await this.exportBundle(filter);
    return JSON.stringify(bundle, null, 2);
  }

  // -----------------------------------------------------------------------
  // Import
  // -----------------------------------------------------------------------

  /**
   * Import skills from a {@link SkillBundle} into the target store.
   *
   * Each imported skill receives a new ID to avoid collisions. The
   * original `sourceProject` field is preserved for provenance tracking.
   *
   * @param bundle - The skill bundle to import.
   * @param targetStore - FileStore to write imported skills into.
   * @param strategy - How to handle duplicates/conflicts. Default `'skip-duplicates'`.
   * @returns An {@link ImportResult} summarising what happened.
   */
  async importBundle(
    bundle: SkillBundle,
    targetStore: FileStore,
    strategy: MergeStrategy = 'skip-duplicates',
  ): Promise<ImportResult> {
    // Validate bundle
    const validationError = this.validateBundle(bundle);
    if (validationError) {
      return {
        total: 0,
        imported: 0,
        skipped: 0,
        conflicts: [],
        errors: [validationError],
      };
    }

    const result: ImportResult = {
      total: bundle.skills.length,
      imported: 0,
      skipped: 0,
      conflicts: [],
      errors: [],
    };

    // Build a name -> existing skill map from the target store
    const existingSkills = await targetStore.readAll<StoredSkill>(COLLECTION);
    const nameMap = new Map<string, StoredSkill>();
    for (const s of existingSkills) {
      nameMap.set(s.name.toLowerCase(), s);
    }

    for (const incoming of bundle.skills) {
      try {
        const existingSkill = nameMap.get(incoming.name.toLowerCase());

        if (existingSkill) {
          // Duplicate detected — apply merge strategy
          const existingExportable = this.stripEmbedding(existingSkill);

          switch (strategy) {
            case 'skip-duplicates': {
              result.skipped++;
              result.conflicts.push({
                incomingSkill: incoming,
                existingSkill: existingExportable,
                reason: `Skill with name "${incoming.name}" already exists (strategy: skip-duplicates)`,
              });
              break;
            }

            case 'overwrite': {
              const newSkill = this.prepareForImport(incoming);
              await targetStore.write(COLLECTION, existingSkill.id, newSkill);
              // Update the name map with the overwritten skill
              nameMap.set(incoming.name.toLowerCase(), { ...newSkill, id: existingSkill.id } as StoredSkill);
              result.imported++;
              break;
            }

            case 'keep-higher-confidence': {
              if (incoming.confidence > existingSkill.confidence) {
                const newSkill = this.prepareForImport(incoming);
                await targetStore.write(COLLECTION, existingSkill.id, newSkill);
                nameMap.set(incoming.name.toLowerCase(), { ...newSkill, id: existingSkill.id } as StoredSkill);
                result.imported++;
              } else {
                result.skipped++;
                result.conflicts.push({
                  incomingSkill: incoming,
                  existingSkill: existingExportable,
                  reason: `Existing skill "${existingSkill.name}" has equal or higher confidence (${existingSkill.confidence} >= ${incoming.confidence})`,
                });
              }
              break;
            }
          }
        } else {
          // No duplicate — import with a fresh ID
          const newSkill = this.prepareForImport(incoming);
          const newId = generateId();
          await targetStore.write(COLLECTION, newId, { ...newSkill, id: newId });
          // Track the newly imported skill in the name map to catch intra-bundle duplicates
          nameMap.set(incoming.name.toLowerCase(), { ...newSkill, id: newId } as StoredSkill);
          result.imported++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to import skill "${incoming.name}": ${message}`);
      }
    }

    this.logger.info(
      `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.conflicts.length} conflicts, ${result.errors.length} errors`,
    );

    return result;
  }

  /**
   * Import skills from a JSON string.
   *
   * @param json - JSON string containing a serialized {@link SkillBundle}.
   * @param targetStore - FileStore to write imported skills into.
   * @param strategy - How to handle duplicates/conflicts. Default `'skip-duplicates'`.
   * @returns An {@link ImportResult} summarising what happened.
   */
  async importFromJson(
    json: string,
    targetStore: FileStore,
    strategy: MergeStrategy = 'skip-duplicates',
  ): Promise<ImportResult> {
    let bundle: SkillBundle;
    try {
      bundle = JSON.parse(json) as SkillBundle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        total: 0,
        imported: 0,
        skipped: 0,
        conflicts: [],
        errors: [`Invalid JSON: ${message}`],
      };
    }

    return this.importBundle(bundle, targetStore, strategy);
  }

  /**
   * Import skills directly from another project's `.apex-data/` directory.
   *
   * Creates a temporary FileStore pointing at the source project's data
   * directory, reads its skills, wraps them in a bundle, and imports.
   *
   * @param sourceProjectPath - Absolute path to the source project root.
   * @param targetStore - FileStore to write imported skills into.
   * @param strategy - How to handle duplicates/conflicts. Default `'skip-duplicates'`.
   * @returns An {@link ImportResult} summarising what happened.
   */
  async importFromProject(
    sourceProjectPath: string,
    targetStore: FileStore,
    strategy: MergeStrategy = 'skip-duplicates',
  ): Promise<ImportResult> {
    const sourceDataPath = `${sourceProjectPath}/.apex-data`;
    const sourceStore = new FileStore(sourceDataPath);

    let skills: StoredSkill[];
    try {
      skills = await sourceStore.readAll<StoredSkill>(COLLECTION);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        total: 0,
        imported: 0,
        skipped: 0,
        conflicts: [],
        errors: [`Failed to read skills from "${sourceProjectPath}": ${message}`],
      };
    }

    // Build a synthetic bundle from the source project's skills
    const activeSkills = skills.filter((s) => !s.archived);
    const exportable = activeSkills.map((s) => this.stripEmbedding(s));

    const allTags = new Set<string>();
    for (const s of exportable) {
      for (const t of s.tags) allTags.add(t);
    }

    const bundle: SkillBundle = {
      version: BUNDLE_VERSION,
      exportedAt: Date.now(),
      sourceProject: sourceProjectPath.split('/').pop() ?? 'unknown',
      sourceProjectPath,
      skills: exportable,
      metadata: {
        totalSkills: exportable.length,
        avgConfidence: exportable.length > 0
          ? exportable.reduce((sum, s) => sum + s.confidence, 0) / exportable.length
          : 0,
        avgSuccessRate: exportable.length > 0
          ? exportable.reduce((sum, s) => sum + s.successRate, 0) / exportable.length
          : 0,
        tags: [...allTags].sort(),
      },
    };

    this.logger.info(`Read ${exportable.length} skills from project at "${sourceProjectPath}"`);
    return this.importBundle(bundle, targetStore, strategy);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Check if a skill is a duplicate of an existing one.
   * Duplicate = same name (case-insensitive).
   *
   * @param skill - The incoming skill to check.
   * @param store - The target FileStore to check against.
   * @returns Whether it is a duplicate and the existing skill's ID if so.
   */
  private async isDuplicate(
    skill: ExportableSkill,
    store: FileStore,
  ): Promise<{ isDuplicate: boolean; existingId?: string }> {
    const existing = await store.readAll<StoredSkill>(COLLECTION);
    const match = existing.find((s) => s.name.toLowerCase() === skill.name.toLowerCase());
    return match
      ? { isDuplicate: true, existingId: match.id }
      : { isDuplicate: false };
  }

  /**
   * Strip the `embedding` field from a StoredSkill to produce a
   * JSON-serializable {@link ExportableSkill}.
   */
  private stripEmbedding(skill: StoredSkill): ExportableSkill {
    const { embedding, ...exportable } = skill;
    return exportable;
  }

  /**
   * Prepare an incoming skill for import by updating its timestamp.
   * Does NOT assign an ID — the caller handles ID assignment.
   */
  private prepareForImport(skill: ExportableSkill): ExportableSkill {
    return {
      ...skill,
      updatedAt: Date.now(),
    };
  }

  /**
   * Validate that a bundle has the expected structure.
   *
   * @returns An error message if invalid, or `null` if valid.
   */
  private validateBundle(bundle: unknown): string | null {
    if (!bundle || typeof bundle !== 'object') {
      return 'Bundle is not an object';
    }

    const b = bundle as Record<string, unknown>;

    if (b.version !== BUNDLE_VERSION) {
      return `Unsupported bundle version: expected "${BUNDLE_VERSION}", got "${String(b.version)}"`;
    }

    if (!Array.isArray(b.skills)) {
      return 'Bundle is missing a "skills" array';
    }

    return null;
  }
}
