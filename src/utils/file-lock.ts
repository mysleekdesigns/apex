/**
 * APEX File Lock — In-process async mutex for protecting concurrent file operations.
 *
 * This is a single-process advisory lock using Promises (NOT OS-level file locks).
 * It serializes async operations on the same key to prevent race conditions
 * when multiple MCP handlers write to the same file concurrently.
 */

/** Function returned by acquire() — call it to release the lock. */
export type ReleaseFn = () => void;

interface LockEntry {
  /** Promise that resolves when this lock holder is done. */
  promise: Promise<void>;
  /** Release function to resolve the promise. */
  release: ReleaseFn;
  /** Timestamp when the lock was acquired. */
  acquiredAt: number;
  /** Timeout handle for deadlock detection. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class LockManager {
  private locks = new Map<string, LockEntry>();
  private waitQueues = new Map<string, Array<{
    resolve: (release: ReleaseFn) => void;
    reject: (err: Error) => void;
  }>>();

  /** Default timeout in ms before a lock is considered deadlocked. */
  readonly defaultTimeout: number;

  constructor(defaultTimeout = DEFAULT_TIMEOUT_MS) {
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Acquire a named lock. Returns a release function.
   * If the lock is held, waits in a FIFO queue.
   * Throws if waiting longer than `timeout` ms.
   */
  async acquire(key: string, timeout?: number): Promise<ReleaseFn> {
    const timeoutMs = timeout ?? this.defaultTimeout;

    if (!this.locks.has(key)) {
      // Lock is free — acquire immediately
      return this.createLock(key);
    }

    // Lock is held — enqueue and wait
    return new Promise<ReleaseFn>((resolve, reject) => {
      if (!this.waitQueues.has(key)) {
        this.waitQueues.set(key, []);
      }
      const queue = this.waitQueues.get(key)!;

      const timer = setTimeout(() => {
        // Remove ourselves from the queue
        const idx = queue.indexOf(waiter);
        if (idx !== -1) queue.splice(idx, 1);
        reject(new Error(`Lock timeout: failed to acquire lock "${key}" within ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter = {
        resolve: (release: ReleaseFn) => {
          clearTimeout(timer);
          resolve(release);
        },
        reject,
      };

      queue.push(waiter);
    });
  }

  /**
   * Non-blocking lock attempt. Returns a release function if the lock is free,
   * or null if it's currently held.
   */
  tryAcquire(key: string): ReleaseFn | null {
    if (this.locks.has(key)) {
      return null;
    }
    // We need to return synchronously, so we create the lock entry directly
    return this.createLockSync(key);
  }

  /** Check if a named lock is currently held. */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  /** Number of locks currently held (for diagnostics). */
  get size(): number {
    return this.locks.size;
  }

  /**
   * Create a lock entry and return the release function.
   * Sets up deadlock detection timeout.
   */
  private createLock(key: string): ReleaseFn {
    return this.createLockSync(key);
  }

  private createLockSync(key: string): ReleaseFn {
    let releaseFn!: ReleaseFn;
    const promise = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    const release = this.buildRelease(key, releaseFn);

    const timeoutHandle = setTimeout(() => {
      console.warn(`[APEX LockManager] Deadlock detected: lock "${key}" held for >${this.defaultTimeout}ms — force-releasing`);
      release();
    }, this.defaultTimeout);

    const entry: LockEntry = {
      promise,
      release,
      acquiredAt: Date.now(),
      timeoutHandle,
    };

    this.locks.set(key, entry);
    return release;
  }

  /**
   * Build the release function for a lock key. Handles:
   * - Removing the lock entry
   * - Clearing the deadlock timer
   * - Passing the lock to the next waiter in the queue
   */
  private buildRelease(key: string, resolveFn: () => void): ReleaseFn {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;

      const entry = this.locks.get(key);
      if (entry?.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
      }

      this.locks.delete(key);
      resolveFn();

      // Hand the lock to the next waiter in the queue
      const queue = this.waitQueues.get(key);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) {
          this.waitQueues.delete(key);
        }
        const nextRelease = this.createLockSync(key);
        next.resolve(nextRelease);
      }
    };
  }
}

/** Singleton lock manager for the process. */
export const lockManager = new LockManager();
