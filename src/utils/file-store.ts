import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { Logger } from './logger.js';
import { LockManager } from './file-lock.js';

const COLLECTIONS = ['episodes', 'memory', 'skills', 'reflections', 'metrics', 'snapshots'] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** Compute SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export interface FileStoreOptions {
  /** Logger instance. If omitted a default logger is created. */
  logger?: Logger;
  /** Enable checksum verification on read/write (default: true). */
  checksums?: boolean;
  /**
   * Absolute path to the data directory containing snapshots for
   * auto-restore on corruption. If omitted, snapshot restore is skipped.
   */
  dataPath?: string;
  /** Lock manager instance. If omitted a new one is created. */
  lockManager?: LockManager;
}

export class FileStore {
  private basePath: string;
  private logger: Logger;
  private checksums: boolean;
  private dataPath: string | undefined;
  private readonly locks: LockManager;

  constructor(basePath: string, options?: FileStoreOptions) {
    this.basePath = basePath;
    this.logger = options?.logger ?? new Logger({ prefix: 'apex:file-store' });
    this.checksums = options?.checksums ?? true;
    this.dataPath = options?.dataPath;
    this.locks = options?.lockManager ?? new LockManager();
  }

  /** Get the base path of the file store. */
  getBasePath(): string {
    return this.basePath;
  }

  /** Create the .apex-data/ directory structure. */
  async init(): Promise<void> {
    for (const collection of COLLECTIONS) {
      await mkdir(path.join(this.basePath, collection), { recursive: true });
    }
  }

  /**
   * Read a single item from a collection by ID. Returns null if not found.
   *
   * Recovery chain on corruption:
   *   1. Try `.bak` companion file
   *   2. Try latest snapshot (if dataPath is configured)
   *   3. Return null
   */
  async read<T>(collection: string, id: string): Promise<T | null> {
    const filePath = path.join(this.basePath, collection, `${id}.json`);

    // Attempt primary file
    const primary = await this.readAndValidate<T>(filePath);
    if (primary !== null) return primary;

    // Attempt backup file
    const bakPath = `${filePath}.bak`;
    const backup = await this.readAndValidate<T>(bakPath);
    if (backup !== null) {
      this.logger.warn(`Restored "${collection}/${id}" from backup file`, { filePath });
      // Repair primary from backup (atomic)
      await this.atomicWrite(filePath, JSON.stringify(backup, null, 2));
      return backup;
    }

    // Attempt snapshot restore
    const fromSnapshot = await this.restoreFromSnapshot<T>(collection, id);
    if (fromSnapshot !== null) {
      this.logger.warn(`Auto-restored "${collection}/${id}" from latest snapshot`, { filePath });
      // Persist the restored data
      await this.writeInternal(filePath, fromSnapshot);
      return fromSnapshot;
    }

    return null;
  }

  /** Write an item to a collection. Creates the collection directory if needed. */
  async write<T>(collection: string, id: string, data: T): Promise<void> {
    const lockKey = `${collection}:${id}`;
    const release = await this.locks.acquire(lockKey);
    try {
      const dirPath = path.join(this.basePath, collection);
      await mkdir(dirPath, { recursive: true });
      const filePath = path.join(dirPath, `${id}.json`);

      // Create backup of existing file before overwriting
      await this.createBackup(filePath);

      await this.writeInternal(filePath, data);
    } finally {
      release();
    }
  }

  /** List all IDs in a collection. */
  async list(collection: string): Promise<string[]> {
    try {
      const dirPath = path.join(this.basePath, collection);
      const files = await readdir(dirPath);
      return files
        .filter((f) => f.endsWith('.json') && !f.endsWith('.bak') && !f.endsWith('.tmp'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /** Delete an item from a collection (removes data, backup, and checksum files). */
  async delete(collection: string, id: string): Promise<void> {
    const lockKey = `${collection}:${id}`;
    const release = await this.locks.acquire(lockKey);
    try {
      const filePath = path.join(this.basePath, collection, `${id}.json`);
      try { await rm(filePath); } catch { /* already gone */ }
      try { await rm(`${filePath}.bak`); } catch { /* already gone */ }
      try { await rm(`${filePath}.sha256`); } catch { /* already gone */ }
    } finally {
      release();
    }
  }

  /** Read all items from a collection. Acquires a collection-level lock. */
  async readAll<T>(collection: string): Promise<T[]> {
    const lockKey = collection;
    const release = await this.locks.acquire(lockKey);
    try {
      const ids = await this.list(collection);
      const items: T[] = [];
      for (const id of ids) {
        const item = await this.read<T>(collection, id);
        if (item !== null) items.push(item);
      }
      return items;
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Read a file, parse as JSON, and optionally verify checksum.
   * Returns null on any failure (file not found, invalid JSON, checksum mismatch).
   */
  private async readAndValidate<T>(filePath: string): Promise<T | null> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null; // file does not exist
    }

    // Validate JSON
    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch {
      this.logger.warn(`Corrupt JSON detected`, { filePath });
      return null;
    }

    // Verify checksum if enabled
    if (this.checksums) {
      const checksumPath = `${filePath}.sha256`;
      try {
        const expectedHash = (await readFile(checksumPath, 'utf-8')).trim();
        const actualHash = sha256(content);
        if (expectedHash !== actualHash) {
          this.logger.warn(`Checksum mismatch — possible corruption`, {
            filePath,
            expected: expectedHash,
            actual: actualHash,
          });
          return null;
        }
      } catch {
        // No checksum file — skip verification (backward-compatible with
        // files written before checksums were enabled)
      }
    }

    return parsed;
  }

  /**
   * Write data to filePath atomically:
   *   1. Write to `${filePath}.tmp`
   *   2. Write checksum to `${filePath}.sha256.tmp`
   *   3. Rename both into place
   */
  private async writeInternal<T>(filePath: string, data: T): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await this.atomicWrite(filePath, content);

    if (this.checksums) {
      const hash = sha256(content);
      const checksumPath = `${filePath}.sha256`;
      await this.atomicWrite(checksumPath, hash);
    }
  }

  /**
   * Atomic write: write to a `.tmp` sibling, then rename into place.
   * Cleans up the temp file on failure.
   */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const dirPath = path.dirname(filePath);
    await mkdir(dirPath, { recursive: true });
    // Use a unique suffix to avoid collisions under concurrent writes
    const nonce = randomBytes(6).toString('hex');
    const tmpPath = `${filePath}.${nonce}.tmp`;
    try {
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { await rm(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Copy the existing file to a `.bak` companion if it exists.
   */
  private async createBackup(filePath: string): Promise<void> {
    try {
      await stat(filePath);
      await copyFile(filePath, `${filePath}.bak`);
    } catch {
      // File doesn't exist yet — nothing to back up
    }
  }

  /**
   * Attempt to restore an entry from the latest snapshot.
   * Returns the parsed data or null if no snapshot contains the entry.
   */
  private async restoreFromSnapshot<T>(collection: string, id: string): Promise<T | null> {
    if (!this.dataPath) return null;

    try {
      const snapshotsDir = path.join(this.dataPath, 'snapshots');
      const entries = await readdir(snapshotsDir).catch(() => [] as string[]);

      // Find snapshot subdirectories (each is an ID directory with tier data)
      // We need to find the latest — read manifests to get timestamps
      interface ManifestInfo { dir: string; timestamp: number }
      const manifests: ManifestInfo[] = [];

      for (const entry of entries) {
        const manifestPath = path.join(snapshotsDir, entry, 'manifest.json');
        try {
          const raw = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw) as { snapshot: { timestamp: number } };
          manifests.push({ dir: entry, timestamp: manifest.snapshot.timestamp });
        } catch {
          // Not a snapshot directory or corrupt manifest — skip
        }
      }

      if (manifests.length === 0) return null;

      // Sort newest first
      manifests.sort((a, b) => b.timestamp - a.timestamp);

      // Try each snapshot, newest first, until we find the entry
      for (const m of manifests) {
        const snapshotFilePath = path.join(
          snapshotsDir, m.dir, collection, `${id}.json`
        );
        try {
          const content = await readFile(snapshotFilePath, 'utf-8');
          const parsed = JSON.parse(content) as T;
          return parsed;
        } catch {
          // Entry not in this snapshot — try next
        }
      }
    } catch {
      // Snapshot restore is best-effort
    }

    return null;
  }
}
