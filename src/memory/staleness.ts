/**
 * APEX Staleness Detection System
 *
 * Tracks source files referenced by memory entries and skills, detects when
 * those files have changed on disk, and tags search results accordingly.
 * Uses mtime comparison with optional git confirmation for change detection.
 */

import { statSync } from "node:fs";
import { execSync } from "node:child_process";
import type { MemoryEntry, Skill, SearchResult } from "../types.js";
import { Logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of checking a single memory entry or skill for staleness. */
export interface StalenessResult {
  /** Whether any tracked source file has changed or gone missing. */
  stale: boolean;
  /** Source files whose content has changed since last recorded state. */
  changedFiles: string[];
  /** Source files that no longer exist on disk. */
  missingFiles: string[];
}

/** Aggregate statistics from the staleness detector. */
export interface StalenessStats {
  /** Total number of entries/skills checked since last reset. */
  totalChecked: number;
  /** Number of entries/skills found to be stale. */
  staleCount: number;
  /** Number of entries/skills with invalid code references. */
  invalidCount: number;
  /** Number of unique file paths currently tracked. */
  filesTracked: number;
}

/** Recorded state for a single tracked file. */
interface FileState {
  /** Last-known modification time (epoch ms). */
  mtime: number;
  /** Optional content hash for deeper comparison (reserved for future use). */
  hash?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tag prepended to content when source files have changed. */
const STALE_TAG = "[STALE \u2014 source files changed since learned]";

/** Tag prepended to content when referenced code identifiers are missing. */
const INVALID_TAG = "[POSSIBLY INVALID \u2014 referenced code not found]";

/**
 * Regex to extract identifiers from memory content.
 *
 * Matches:
 *  - Backtick-quoted identifiers: `someFunction`
 *  - "function X" / "class Y" / "interface Z" / "type T" patterns
 */
const IDENTIFIER_PATTERNS = [
  /`([A-Za-z_$][A-Za-z0-9_$]*)`/g,
  /\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
];

// ---------------------------------------------------------------------------
// StalenessDetector
// ---------------------------------------------------------------------------

/**
 * Detects whether knowledge stored in memory entries and skills has gone stale
 * by monitoring the source files they reference.
 *
 * @example
 * ```ts
 * const detector = new StalenessDetector({ projectPath: "/my/project" });
 * const result = detector.checkEntry(someMemoryEntry);
 * if (result.stale) {
 *   console.log("Changed:", result.changedFiles);
 * }
 * ```
 */
export class StalenessDetector {
  /** Absolute path to the project root (used for git commands). */
  private readonly projectPath: string;

  /** Logger instance. */
  private readonly logger: Logger;

  /** Map of absolute file path to its last-known state. */
  private readonly fileStates: Map<string, FileState> = new Map();

  /** Running statistics. */
  private stats: StalenessStats = {
    totalChecked: 0,
    staleCount: 0,
    invalidCount: 0,
    filesTracked: 0,
  };

  /**
   * @param options.projectPath - Absolute path to the project root directory.
   * @param options.logger      - Optional Logger instance; a default is created if omitted.
   */
  constructor(options: { projectPath: string; logger?: Logger }) {
    this.projectPath = options.projectPath;
    this.logger = options.logger ?? new Logger({ prefix: "staleness" });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Check whether a set of source file paths have changed on disk since
   * they were last recorded.
   *
   * For files encountered for the first time the current state is stored and
   * they are reported as unchanged.
   *
   * @param filePaths - Absolute paths to check.
   * @returns Object listing changed and missing files.
   */
  checkFiles(filePaths: string[]): { changedFiles: string[]; missingFiles: string[] } {
    const changedFiles: string[] = [];
    const missingFiles: string[] = [];

    for (const filePath of filePaths) {
      const currentMtime = this.getFileMtime(filePath);

      if (currentMtime === null) {
        missingFiles.push(filePath);
        continue;
      }

      const known = this.fileStates.get(filePath);

      if (!known) {
        // First encounter -- record current state, treat as unchanged.
        this.recordFileState(filePath, currentMtime);
        continue;
      }

      if (currentMtime !== known.mtime) {
        // Mtime differs -- confirm via git when possible.
        if (this.confirmChangeViaGit(filePath)) {
          changedFiles.push(filePath);
        } else {
          // Git not available or inconclusive; trust mtime.
          changedFiles.push(filePath);
        }
      }
    }

    return { changedFiles, missingFiles };
  }

  /**
   * Check whether a {@link MemoryEntry} or {@link Skill} is stale based on
   * its `sourceFiles`.
   *
   * @param entry - A MemoryEntry or Skill with an optional `sourceFiles` array.
   * @returns A {@link StalenessResult} describing the staleness state.
   */
  checkEntry(entry: MemoryEntry | Skill): StalenessResult {
    this.stats.totalChecked++;

    const sourceFiles = entry.sourceFiles ?? [];
    if (sourceFiles.length === 0) {
      return { stale: false, changedFiles: [], missingFiles: [] };
    }

    const { changedFiles, missingFiles } = this.checkFiles(sourceFiles);
    const stale = changedFiles.length > 0 || missingFiles.length > 0;

    if (stale) {
      this.stats.staleCount++;
      this.logger.debug("Entry marked stale", {
        id: entry.id,
        changedFiles,
        missingFiles,
      });
    }

    return { stale, changedFiles, missingFiles };
  }

  /**
   * Check whether code identifiers referenced in the entry's content still
   * exist somewhere in the project source tree.
   *
   * Extracts identifiers from backtick-quoted names and
   * `function/class/interface/type` declarations mentioned in the content,
   * then runs `grep -r` to verify they still appear in the codebase.
   *
   * @param content - The textual content to scan for identifiers.
   * @returns An array of identifiers that could **not** be found.
   */
  checkReferenceValidity(content: string): string[] {
    const identifiers = this.extractIdentifiers(content);

    if (identifiers.length === 0) {
      return [];
    }

    const missing: string[] = [];

    for (const id of identifiers) {
      if (!this.identifierExistsInProject(id)) {
        missing.push(id);
      }
    }

    if (missing.length > 0) {
      this.stats.invalidCount++;
      this.logger.debug("Invalid references found", { missing });
    }

    return missing;
  }

  /**
   * Enrich an array of {@link SearchResult} objects with staleness and
   * validity tags prepended to each entry's content.
   *
   * Tags applied:
   *  - `[STALE -- source files changed since learned]`
   *  - `[POSSIBLY INVALID -- referenced code not found]`
   *
   * @param results - Search results to tag.
   * @returns The same array with content strings potentially modified.
   */
  tagSearchResults(results: SearchResult[]): SearchResult[] {
    return results.map((result) => {
      const tags: string[] = [];

      // Check staleness via source files.
      const stalenessResult = this.checkEntry(result.entry);
      if (stalenessResult.stale) {
        tags.push(STALE_TAG);
      }

      // Check reference validity.
      const missingRefs = this.checkReferenceValidity(result.entry.content);
      if (missingRefs.length > 0) {
        tags.push(INVALID_TAG);
      }

      if (tags.length > 0) {
        return {
          ...result,
          entry: {
            ...result.entry,
            content: `${tags.join(" ")} ${result.entry.content}`,
            stale: stalenessResult.stale || undefined,
          },
        };
      }

      return result;
    });
  }

  /**
   * Return aggregate staleness statistics.
   *
   * @returns A snapshot of the current {@link StalenessStats}.
   */
  getStats(): StalenessStats {
    return {
      ...this.stats,
      filesTracked: this.fileStates.size,
    };
  }

  /**
   * Refresh stored file states so that currently-changed files are recorded
   * as up-to-date. Call this after the user has acknowledged or addressed
   * staleness warnings.
   *
   * @param filePaths - Optional list of specific paths to refresh. If
   *   omitted, **all** tracked files are refreshed.
   */
  refresh(filePaths?: string[]): void {
    const paths = filePaths ?? [...this.fileStates.keys()];

    for (const filePath of paths) {
      const mtime = this.getFileMtime(filePath);
      if (mtime !== null) {
        this.recordFileState(filePath, mtime);
      } else {
        // File no longer exists -- remove from tracking.
        this.fileStates.delete(filePath);
      }
    }

    // Reset stale/invalid counters after a refresh.
    this.stats.staleCount = 0;
    this.stats.invalidCount = 0;
    this.stats.filesTracked = this.fileStates.size;

    this.logger.info("File states refreshed", { count: paths.length });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Get the modification time of a file, or `null` if the file does not
   * exist or cannot be accessed.
   */
  private getFileMtime(filePath: string): number | null {
    try {
      const stat = statSync(filePath);
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Store the current state of a file for future comparison.
   */
  private recordFileState(filePath: string, mtime: number): void {
    this.fileStates.set(filePath, { mtime });
    this.stats.filesTracked = this.fileStates.size;
  }

  /**
   * Attempt to confirm a file change using `git diff`. Returns `true` if
   * git reports the file as changed, or if git is unavailable (in which case
   * we fall back to trusting the mtime signal).
   */
  private confirmChangeViaGit(filePath: string): boolean {
    try {
      const output = execSync(
        `git diff --name-only HEAD -- "${filePath}"`,
        {
          cwd: this.projectPath,
          encoding: "utf-8",
          timeout: 5_000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // If git outputs the filename, the file has uncommitted changes.
      return output.trim().length > 0;
    } catch {
      // Git not available or command failed -- fall back to mtime.
      return true;
    }
  }

  /**
   * Extract code identifiers mentioned in a piece of text.
   *
   * Looks for:
   *  - Backtick-quoted names: `myFunction`
   *  - Declaration patterns: function myFunction, class MyClass, etc.
   *
   * Short identifiers (fewer than 3 characters) and common language keywords
   * are filtered out to reduce false positives.
   */
  private extractIdentifiers(content: string): string[] {
    const found = new Set<string>();

    for (const pattern of IDENTIFIER_PATTERNS) {
      // Reset lastIndex for global regexes.
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const id = match[1];
        if (id && id.length >= 3 && !KEYWORDS.has(id.toLowerCase())) {
          found.add(id);
        }
      }
    }

    return [...found];
  }

  /**
   * Check whether an identifier exists anywhere in the project source tree
   * using `grep -r`.
   *
   * Returns `true` if at least one match is found, `false` otherwise.
   */
  private identifierExistsInProject(identifier: string): boolean {
    try {
      execSync(
        `grep -r --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" -l "${identifier}" .`,
        {
          cwd: this.projectPath,
          encoding: "utf-8",
          timeout: 10_000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // grep exits 0 when matches are found.
      return true;
    } catch {
      // grep exits 1 when no matches found, or command failed.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Common keywords to exclude from identifier extraction
// ---------------------------------------------------------------------------

/** @internal */
const KEYWORDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "const",
  "let",
  "var",
  "enum",
  "import",
  "export",
  "return",
  "async",
  "await",
  "from",
  "new",
  "this",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "any",
  "unknown",
  "never",
  "for",
  "while",
  "break",
  "continue",
  "switch",
  "case",
  "default",
  "throw",
  "try",
  "catch",
  "finally",
  "extends",
  "implements",
  "static",
  "private",
  "protected",
  "public",
  "readonly",
  "abstract",
  "override",
  "declare",
  "module",
  "require",
  "yield",
  "delete",
  "typeof",
  "instanceof",
  "keyof",
  "infer",
]);
