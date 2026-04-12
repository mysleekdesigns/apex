/**
 * APEX Audit Log
 *
 * Append-only log for all memory mutations. Writes to JSON Lines format
 * (.jsonl) with automatic rotation when the file exceeds a size threshold.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single audit log entry. */
export interface AuditEntry {
  /** Unix-epoch millisecond timestamp. */
  timestamp: number;
  /** Operation type (e.g. 'record', 'consolidate', 'promote', 'delete'). */
  operation: string;
  /** Memory tier affected (e.g. 'working', 'episodic', 'semantic', 'procedural'). */
  tier: string;
  /** ID of the memory entry affected. */
  entryId: string;
  /** Human-readable detail string. */
  details: string;
  /** Whether the operation succeeded. */
  success: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AuditLogOptions {
  /** Absolute path to the `.apex-data/` directory. */
  dataPath: string;
  /** Logger instance. */
  logger?: Logger;
  /** Maximum file size in bytes before rotation. Default: 1 MB. */
  maxFileSize?: number;
}

// ---------------------------------------------------------------------------
// AuditLog
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE = 1_048_576; // 1 MB

/**
 * Append-only audit log for memory mutations.
 *
 * Writes one JSON object per line (JSON Lines / `.jsonl` format).
 * Auto-rotates when the active file exceeds `maxFileSize`.
 */
export class AuditLog {
  private readonly auditDir: string;
  private readonly activeFile: string;
  private readonly logger: Logger;
  private readonly maxFileSize: number;
  private initialized = false;

  /** Queue of pending writes (fire-and-forget). */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AuditLogOptions) {
    this.auditDir = path.join(options.dataPath, 'audit');
    this.activeFile = path.join(this.auditDir, 'audit.jsonl');
    this.logger = options.logger ?? new Logger({ prefix: 'apex:audit' });
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_SIZE;
  }

  /**
   * Ensure the audit directory exists.
   * Called lazily on first write.
   */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.auditDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Append an audit entry. Fire-and-forget — does not block the caller.
   * Errors are caught and logged rather than thrown.
   */
  append(entry: AuditEntry): void {
    // Chain writes to preserve ordering and avoid concurrent file ops
    this.writeQueue = this.writeQueue
      .then(() => this.doAppend(entry))
      .catch((err) => {
        this.logger.error('Audit log write failed', { error: err });
      });
  }

  /**
   * Perform the actual append + optional rotation.
   */
  private async doAppend(entry: AuditEntry): Promise<void> {
    await this.ensureDir();

    const line = JSON.stringify(entry) + '\n';
    await appendFile(this.activeFile, line, 'utf-8');

    // Check rotation
    await this.maybeRotate();
  }

  /**
   * Rotate the active log file if it exceeds the size threshold.
   * Renames to `audit-{timestamp}.jsonl` and starts a fresh file.
   */
  private async maybeRotate(): Promise<void> {
    try {
      const info = await stat(this.activeFile);
      if (info.size >= this.maxFileSize) {
        const rotatedName = `audit-${Date.now()}.jsonl`;
        const rotatedPath = path.join(this.auditDir, rotatedName);
        await rename(this.activeFile, rotatedPath);
        this.logger.info('Audit log rotated', { rotatedTo: rotatedName });
      }
    } catch {
      // File may not exist yet or stat failed — ignore
    }
  }

  /**
   * Read the most recent entries from the active log file.
   *
   * Reads all lines from the active file and returns the last `limit` entries.
   * Does not read rotated files.
   *
   * @param limit - Maximum number of entries to return. Default: 50.
   * @returns Array of AuditEntry objects, newest last.
   */
  async getRecentEntries(limit = 50): Promise<AuditEntry[]> {
    await this.ensureDir();

    const entries: AuditEntry[] = [];
    try {
      const stream = createReadStream(this.activeFile, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as AuditEntry);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File may not exist — return empty
    }

    // Return the last `limit` entries
    return entries.slice(-limit);
  }

  /**
   * Wait for all pending writes to complete.
   * Useful in tests and graceful shutdown.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
