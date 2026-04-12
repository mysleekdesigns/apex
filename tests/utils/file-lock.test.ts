/**
 * Tests for APEX LockManager — in-process async mutex.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LockManager } from '../../src/utils/file-lock.js';
import { FileStore } from '../../src/utils/file-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('LockManager', () => {
  let lm: LockManager;

  beforeEach(() => {
    lm = new LockManager(500); // 500ms default timeout for faster tests
  });

  // ── Basic acquire/release ─────────────────────────────────────

  it('acquires and releases a lock', async () => {
    const release = await lm.acquire('key-a');
    expect(lm.isLocked('key-a')).toBe(true);
    release();
    expect(lm.isLocked('key-a')).toBe(false);
  });

  it('release is idempotent', async () => {
    const release = await lm.acquire('key-b');
    release();
    release(); // second call is a no-op
    expect(lm.isLocked('key-b')).toBe(false);
  });

  // ── Serialization ─────────────────────────────────────────────

  it('serializes two concurrent acquires on the same key', async () => {
    const order: number[] = [];

    const release1 = await lm.acquire('serial');
    order.push(1);

    // Start second acquire — it should block until release1 is called
    const p2 = lm.acquire('serial').then((release2) => {
      order.push(2);
      release2();
    });

    // Give the event loop a tick — second acquire should NOT have resolved
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);

    release1();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('processes waiters in FIFO order', async () => {
    const order: number[] = [];
    const release1 = await lm.acquire('fifo');

    const p2 = lm.acquire('fifo').then((r) => { order.push(2); r(); });
    const p3 = lm.acquire('fifo').then((r) => { order.push(3); r(); });
    const p4 = lm.acquire('fifo').then((r) => { order.push(4); r(); });

    release1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  // ── Timeout ───────────────────────────────────────────────────

  it('rejects acquire when timeout is exceeded', async () => {
    const _release = await lm.acquire('timeout-key');

    await expect(
      lm.acquire('timeout-key', 50), // 50ms timeout, lock held
    ).rejects.toThrow(/Lock timeout/);

    _release();
  });

  // ── Deadlock detection ────────────────────────────────────────

  it('force-releases a lock held past the deadlock timeout', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shortLm = new LockManager(100); // 100ms deadlock timeout

    const _release = await shortLm.acquire('deadlock-key');
    expect(shortLm.isLocked('deadlock-key')).toBe(true);

    // Wait for the deadlock timer to fire
    await new Promise((r) => setTimeout(r, 150));

    expect(shortLm.isLocked('deadlock-key')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Deadlock detected'),
    );

    warnSpy.mockRestore();
  });

  it('deadlock force-release passes lock to next waiter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shortLm = new LockManager(100);

    // Acquire and intentionally never release
    await shortLm.acquire('dl-handoff');

    let secondAcquired = false;
    const p2 = shortLm.acquire('dl-handoff', 300).then((release) => {
      secondAcquired = true;
      release();
    });

    // Wait for deadlock timer to fire and pass lock to waiter
    await new Promise((r) => setTimeout(r, 150));
    await p2;

    expect(secondAcquired).toBe(true);
    warnSpy.mockRestore();
  });

  // ── tryAcquire ────────────────────────────────────────────────

  it('tryAcquire returns release function when lock is free', () => {
    const release = lm.tryAcquire('try-key');
    expect(release).not.toBeNull();
    expect(lm.isLocked('try-key')).toBe(true);
    release!();
    expect(lm.isLocked('try-key')).toBe(false);
  });

  it('tryAcquire returns null when lock is held', async () => {
    const release = await lm.acquire('try-held');
    expect(lm.tryAcquire('try-held')).toBeNull();
    release();
  });

  // ── Independent keys ──────────────────────────────────────────

  it('locks on different keys do not interfere', async () => {
    const releaseA = await lm.acquire('key-x');
    const releaseB = await lm.acquire('key-y');

    expect(lm.isLocked('key-x')).toBe(true);
    expect(lm.isLocked('key-y')).toBe(true);

    releaseA();
    expect(lm.isLocked('key-x')).toBe(false);
    expect(lm.isLocked('key-y')).toBe(true);

    releaseB();
  });

  // ── size property ─────────────────────────────────────────────

  it('tracks lock count via size', async () => {
    expect(lm.size).toBe(0);
    const r1 = await lm.acquire('s1');
    const r2 = await lm.acquire('s2');
    expect(lm.size).toBe(2);
    r1();
    expect(lm.size).toBe(1);
    r2();
    expect(lm.size).toBe(0);
  });
});

// ── Stress test: concurrent writes ────────────────────────────────

describe('FileStore concurrent writes (stress test)', () => {
  const TEST_DIR = path.join(os.tmpdir(), `apex-lock-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  it('10 concurrent writes to the same file do not corrupt data', async () => {
    const store = new FileStore(TEST_DIR);
    await store.init();

    const collection = 'episodes';
    const id = 'concurrent-target';

    // Fire 10 writes concurrently, each with a different payload
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.write(collection, id, { index: i, data: `payload-${i}` }),
    );

    await Promise.all(writes);

    // Read the result — it should be valid JSON (one of the payloads)
    const result = await store.read<{ index: number; data: string }>(collection, id);
    expect(result).not.toBeNull();
    expect(result!.index).toBeGreaterThanOrEqual(0);
    expect(result!.index).toBeLessThan(10);
    expect(result!.data).toMatch(/^payload-\d$/);

    // Clean up
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('concurrent writes to different files all succeed', async () => {
    const dir = TEST_DIR + '-multi';
    const store = new FileStore(dir);
    await store.init();

    const collection = 'memory';
    const count = 10;

    const writes = Array.from({ length: count }, (_, i) =>
      store.write(collection, `item-${i}`, { value: i }),
    );

    await Promise.all(writes);

    const ids = await store.list(collection);
    expect(ids.length).toBe(count);

    for (let i = 0; i < count; i++) {
      const item = await store.read<{ value: number }>(collection, `item-${i}`);
      expect(item).toEqual({ value: i });
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
