/**
 * APEX Snapshot / Rollback Manager
 *
 * Provides point-in-time snapshots of memory state and the ability to
 * restore from a previous snapshot. Supports both automatic snapshots
 * (created before consolidation, with pruning) and named snapshots
 * (user-created, never auto-pruned).
 */

import { mkdir, cp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { generateId, type MemoryTier, type Snapshot } from "../types.js";
import { FileStore } from "../utils/file-store.js";
import { Logger } from "../utils/logger.js";

/** Collections that hold tier data and are captured in snapshots. */
const TIER_COLLECTIONS = ["episodes", "memory", "skills", "reflections"] as const;

/** Manifest stored inside each snapshot directory. */
interface SnapshotManifest {
  /** The snapshot metadata. */
  snapshot: Snapshot;
  /** Entry IDs present in each tier collection at snapshot time. */
  entryIds: Record<string, string[]>;
}

export interface SnapshotManagerOptions {
  /** Absolute path to the `.apex-data/` directory. */
  dataPath: string;
  /** FileStore instance for reading/writing JSON data. */
  fileStore?: FileStore;
  /** Logger instance. */
  logger?: Logger;
  /** Maximum number of auto-snapshots to retain (default 5). */
  maxAutoSnapshots?: number;
}

/**
 * Manages creation, listing, restoration, and deletion of memory snapshots.
 *
 * Each snapshot captures a lightweight manifest (tier sizes + entry IDs) plus
 * copies of all tier data files. Snapshots live under
 * `<dataPath>/snapshots/<snapshotId>/`.
 */
export class SnapshotManager {
  private readonly dataPath: string;
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly maxAutoSnapshots: number;

  constructor(options: SnapshotManagerOptions) {
    this.dataPath = options.dataPath;
    this.fileStore = options.fileStore ?? new FileStore(options.dataPath);
    this.logger = options.logger ?? new Logger({ prefix: "apex:snapshots" });
    this.maxAutoSnapshots = options.maxAutoSnapshots ?? 5;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a snapshot of the current memory state.
   *
   * @param options.name - Optional human-readable label. Auto-generated if omitted.
   * @param options.auto - Whether this is an automatic (pre-consolidation) snapshot.
   * @param options.tierSizes - Entry counts per tier to record in metadata.
   * @returns The created Snapshot metadata.
   */
  async createSnapshot(options: {
    name?: string;
    auto: boolean;
    tierSizes: Record<MemoryTier, number>;
  }): Promise<Snapshot> {
    const id = generateId();
    const timestamp = Date.now();
    const name =
      options.name ?? `snapshot-${new Date(timestamp).toISOString().replace(/[:.]/g, "-")}`;

    const snapshot: Snapshot = {
      id,
      name,
      timestamp,
      tierSizes: options.tierSizes,
      auto: options.auto,
    };

    // Gather entry IDs per collection
    const entryIds: Record<string, string[]> = {};
    for (const collection of TIER_COLLECTIONS) {
      entryIds[collection] = await this.fileStore.list(collection);
    }

    // Build the snapshot directory
    const snapshotDir = this.snapshotDir(id);
    await mkdir(snapshotDir, { recursive: true });

    // Write manifest
    const manifest: SnapshotManifest = { snapshot, entryIds };
    await this.fileStore.write(`snapshots/${id}`, "manifest", manifest);

    // Copy tier data files into the snapshot subdirectory
    for (const collection of TIER_COLLECTIONS) {
      const srcDir = path.join(this.dataPath, collection);
      const destDir = path.join(snapshotDir, collection);
      await this.copyDirSafe(srcDir, destDir);
    }

    // Persist snapshot metadata in the top-level snapshots collection for listing
    await this.fileStore.write("snapshots", id, snapshot);

    this.logger.info(`Created snapshot "${name}"`, { id, auto: options.auto, tierSizes: options.tierSizes });

    return snapshot;
  }

  /**
   * Create an automatic snapshot (e.g. before consolidation).
   * Auto-snapshots are pruned to keep only the most recent N.
   *
   * @param tierSizes - Current entry counts per tier.
   * @returns The created Snapshot metadata.
   */
  async autoSnapshot(tierSizes: Record<MemoryTier, number>): Promise<Snapshot> {
    const snapshot = await this.createSnapshot({
      name: `auto-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      auto: true,
      tierSizes,
    });

    await this.pruneAutoSnapshots();

    return snapshot;
  }

  /**
   * Create a named snapshot via the `apex_snapshot` tool.
   * Named snapshots are never automatically pruned.
   *
   * @param name - Human-readable label for the snapshot.
   * @param tierSizes - Current entry counts per tier.
   * @returns The created Snapshot metadata.
   */
  async createNamedSnapshot(
    name: string,
    tierSizes: Record<MemoryTier, number>,
  ): Promise<Snapshot> {
    return this.createSnapshot({ name, auto: false, tierSizes });
  }

  /**
   * Restore memory state from a snapshot.
   *
   * @param snapshotId - The ID of the snapshot to restore, or `"latest"` for the most recent.
   * @returns The Snapshot metadata of the restored snapshot.
   * @throws If the snapshot is not found.
   */
  async rollback(snapshotId: string): Promise<Snapshot> {
    // Resolve "latest" to the most recent snapshot
    if (snapshotId === "latest") {
      const all = await this.listSnapshots();
      if (all.length === 0) {
        throw new Error("No snapshots available for rollback.");
      }
      snapshotId = all[0].id;
    }

    // Read snapshot metadata
    const snapshot = await this.fileStore.read<Snapshot>("snapshots", snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot "${snapshotId}" not found.`);
    }

    const snapshotDir = this.snapshotDir(snapshotId);

    // Restore each tier collection from the snapshot
    for (const collection of TIER_COLLECTIONS) {
      const srcDir = path.join(snapshotDir, collection);
      const destDir = path.join(this.dataPath, collection);

      // Clear existing tier data
      await rm(destDir, { recursive: true, force: true });
      await mkdir(destDir, { recursive: true });

      // Copy snapshot data back
      await this.copyDirSafe(srcDir, destDir);
    }

    this.logger.info(`Rolled back to snapshot "${snapshot.name ?? snapshotId}"`, {
      id: snapshotId,
      tierSizes: snapshot.tierSizes,
    });

    return snapshot;
  }

  /**
   * List all snapshots sorted by timestamp descending (newest first).
   *
   * @returns Array of Snapshot metadata objects.
   */
  async listSnapshots(): Promise<Snapshot[]> {
    const ids = await this.fileStore.list("snapshots");

    const snapshots: Snapshot[] = [];
    for (const id of ids) {
      // Skip subdirectory manifests — only read top-level snapshot metadata
      const data = await this.fileStore.read<Snapshot>("snapshots", id);
      if (data && data.timestamp !== undefined && data.tierSizes !== undefined) {
        snapshots.push(data);
      }
    }

    // Sort newest first
    snapshots.sort((a, b) => b.timestamp - a.timestamp);

    return snapshots;
  }

  /**
   * Delete a specific snapshot and all its associated data.
   *
   * @param snapshotId - The ID of the snapshot to delete.
   */
  async deleteSnapshot(snapshotId: string): Promise<void> {
    // Remove the snapshot data directory
    const snapshotDir = this.snapshotDir(snapshotId);
    await rm(snapshotDir, { recursive: true, force: true });

    // Remove the top-level metadata entry
    await this.fileStore.delete("snapshots", snapshotId);

    this.logger.info(`Deleted snapshot "${snapshotId}"`);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Return the directory path for a given snapshot's data.
   */
  private snapshotDir(snapshotId: string): string {
    return path.join(this.dataPath, "snapshots", snapshotId);
  }

  /**
   * Prune auto-snapshots to keep only the most recent N.
   */
  private async pruneAutoSnapshots(): Promise<void> {
    const all = await this.listSnapshots();
    const autoSnapshots = all.filter((s) => s.auto);

    if (autoSnapshots.length <= this.maxAutoSnapshots) {
      return;
    }

    // autoSnapshots is already sorted newest-first; remove the oldest ones
    const toRemove = autoSnapshots.slice(this.maxAutoSnapshots);
    for (const snapshot of toRemove) {
      await this.deleteSnapshot(snapshot.id);
      this.logger.debug(`Pruned auto-snapshot "${snapshot.name ?? snapshot.id}"`);
    }
  }

  /**
   * Copy a directory's contents to a destination, creating the destination
   * if it does not exist. Silently succeeds if the source does not exist
   * (the tier may be empty).
   */
  private async copyDirSafe(src: string, dest: string): Promise<void> {
    try {
      const entries = await readdir(src);
      if (entries.length === 0) {
        return;
      }
      await mkdir(dest, { recursive: true });
      await cp(src, dest, { recursive: true });
    } catch {
      // Source directory may not exist if the tier has no data yet
      await mkdir(dest, { recursive: true });
    }
  }
}
