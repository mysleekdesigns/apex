import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { FileStore } from '../../src/utils/file-store.js';
import { Logger } from '../../src/utils/logger.js';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

describe('FileStore atomic operations', () => {
  let tmpDir: string;
  let store: FileStore;
  const logger = new Logger({ prefix: 'test', level: 'error' });

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-filestore-test-'));
    store = new FileStore(tmpDir, { logger, checksums: true });
    await store.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Atomic writes
  // -------------------------------------------------------------------------

  describe('atomic write', () => {
    it('writes data that can be read back', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1', task: 'test' });
      const result = await store.read<{ id: string; task: string }>('episodes', 'ep1');
      expect(result).toEqual({ id: 'ep1', task: 'test' });
    });

    it('does not leave .tmp files on success', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1' });
      const dir = path.join(tmpDir, 'episodes');
      const { readdir: rd } = await import('fs/promises');
      const files = await rd(dir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('creates a .sha256 companion file', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1' });
      const checksumPath = path.join(tmpDir, 'episodes', 'ep1.json.sha256');
      const hash = await readFile(checksumPath, 'utf-8');
      const content = await readFile(path.join(tmpDir, 'episodes', 'ep1.json'), 'utf-8');
      expect(hash.trim()).toBe(sha256(content));
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery (corrupt JSON)
  // -------------------------------------------------------------------------

  describe('crash recovery from backup', () => {
    it('restores from .bak when primary is corrupt', async () => {
      // Write valid data first (creates the original file)
      await store.write('episodes', 'ep1', { id: 'ep1', version: 1 });
      // Write again so the first version becomes the .bak
      await store.write('episodes', 'ep1', { id: 'ep1', version: 2 });

      // Corrupt the primary file
      const filePath = path.join(tmpDir, 'episodes', 'ep1.json');
      await writeFile(filePath, '{invalid json!!!', 'utf-8');

      const result = await store.read<{ id: string; version: number }>('episodes', 'ep1');
      // Should recover from backup (version 1, the file before the second write)
      expect(result).not.toBeNull();
      expect(result!.id).toBe('ep1');
      expect(result!.version).toBe(1);
    });

    it('returns null when both primary and backup are corrupt', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1' });
      await store.write('episodes', 'ep1', { id: 'ep1', v: 2 });

      // Corrupt both files
      const filePath = path.join(tmpDir, 'episodes', 'ep1.json');
      await writeFile(filePath, 'CORRUPT', 'utf-8');
      await writeFile(`${filePath}.bak`, 'ALSO_CORRUPT', 'utf-8');

      const result = await store.read('episodes', 'ep1');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Backup rotation
  // -------------------------------------------------------------------------

  describe('backup rotation', () => {
    it('creates backup on overwrite', async () => {
      await store.write('episodes', 'ep1', { version: 1 });
      await store.write('episodes', 'ep1', { version: 2 });

      const bakPath = path.join(tmpDir, 'episodes', 'ep1.json.bak');
      const bakContent = await readFile(bakPath, 'utf-8');
      expect(JSON.parse(bakContent)).toEqual({ version: 1 });
    });

    it('replaces old backup with new one on subsequent writes', async () => {
      await store.write('episodes', 'ep1', { version: 1 });
      await store.write('episodes', 'ep1', { version: 2 });
      await store.write('episodes', 'ep1', { version: 3 });

      const bakPath = path.join(tmpDir, 'episodes', 'ep1.json.bak');
      const bakContent = await readFile(bakPath, 'utf-8');
      // Backup should be version 2 (the file right before the last write)
      expect(JSON.parse(bakContent)).toEqual({ version: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // Checksum verification
  // -------------------------------------------------------------------------

  describe('checksum verification', () => {
    it('detects content modification without checksum update', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1', original: true });

      // Tamper with the file content without updating the checksum
      const filePath = path.join(tmpDir, 'episodes', 'ep1.json');
      await writeFile(filePath, JSON.stringify({ id: 'ep1', tampered: true }, null, 2), 'utf-8');

      // Read should detect mismatch and fall back to backup or null
      const result = await store.read<{ id: string; original?: boolean }>('episodes', 'ep1');
      // Since there's no backup (first write), should return null
      expect(result).toBeNull();
    });

    it('works when checksums are disabled', async () => {
      const noChecksumStore = new FileStore(tmpDir, { logger, checksums: false });

      await noChecksumStore.write('episodes', 'ep2', { id: 'ep2' });

      // No checksum file should exist
      const checksumPath = path.join(tmpDir, 'episodes', 'ep2.json.sha256');
      await expect(stat(checksumPath)).rejects.toThrow();

      // Should still read fine
      const result = await noChecksumStore.read<{ id: string }>('episodes', 'ep2');
      expect(result).toEqual({ id: 'ep2' });
    });

    it('reads files without checksum companion (backward compatibility)', async () => {
      // Directly write a JSON file without checksum
      const dirPath = path.join(tmpDir, 'episodes');
      await mkdir(dirPath, { recursive: true });
      await writeFile(
        path.join(dirPath, 'legacy.json'),
        JSON.stringify({ id: 'legacy' }, null, 2),
        'utf-8'
      );

      const result = await store.read<{ id: string }>('episodes', 'legacy');
      expect(result).toEqual({ id: 'legacy' });
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot auto-restore
  // -------------------------------------------------------------------------

  describe('snapshot auto-restore', () => {
    it('restores from latest snapshot when primary and backup are missing', async () => {
      // Set up a fake snapshot structure
      const snapshotId = 'snap-001';
      const snapshotDir = path.join(tmpDir, 'snapshots', snapshotId);
      const snapshotEpisodesDir = path.join(snapshotDir, 'episodes');
      await mkdir(snapshotEpisodesDir, { recursive: true });

      // Write manifest
      await mkdir(path.join(snapshotDir), { recursive: true });
      await writeFile(
        path.join(snapshotDir, 'manifest.json'),
        JSON.stringify({
          snapshot: { id: snapshotId, timestamp: Date.now(), auto: true },
          entryIds: { episodes: ['ep-from-snap'] },
        }),
        'utf-8'
      );

      // Write the episode data in the snapshot
      await writeFile(
        path.join(snapshotEpisodesDir, 'ep-from-snap.json'),
        JSON.stringify({ id: 'ep-from-snap', fromSnapshot: true }, null, 2),
        'utf-8'
      );

      // Create a store with dataPath pointing to tmpDir (where snapshots live)
      const storeWithSnap = new FileStore(tmpDir, { logger, checksums: false, dataPath: tmpDir });

      // Reading an entry that only exists in the snapshot
      const result = await storeWithSnap.read<{ id: string; fromSnapshot: boolean }>(
        'episodes',
        'ep-from-snap'
      );
      expect(result).toEqual({ id: 'ep-from-snap', fromSnapshot: true });
    });

    it('picks the most recent snapshot when multiple exist', async () => {
      const snap1Dir = path.join(tmpDir, 'snapshots', 'snap-old');
      const snap2Dir = path.join(tmpDir, 'snapshots', 'snap-new');

      for (const dir of [snap1Dir, snap2Dir]) {
        await mkdir(path.join(dir, 'episodes'), { recursive: true });
      }

      // Old snapshot
      await writeFile(
        path.join(snap1Dir, 'manifest.json'),
        JSON.stringify({
          snapshot: { id: 'snap-old', timestamp: 1000, auto: true },
          entryIds: { episodes: ['item'] },
        }),
        'utf-8'
      );
      await writeFile(
        path.join(snap1Dir, 'episodes', 'item.json'),
        JSON.stringify({ version: 'old' }, null, 2),
        'utf-8'
      );

      // New snapshot
      await writeFile(
        path.join(snap2Dir, 'manifest.json'),
        JSON.stringify({
          snapshot: { id: 'snap-new', timestamp: 9000, auto: true },
          entryIds: { episodes: ['item'] },
        }),
        'utf-8'
      );
      await writeFile(
        path.join(snap2Dir, 'episodes', 'item.json'),
        JSON.stringify({ version: 'new' }, null, 2),
        'utf-8'
      );

      const storeWithSnap = new FileStore(tmpDir, { logger, checksums: false, dataPath: tmpDir });
      const result = await storeWithSnap.read<{ version: string }>('episodes', 'item');
      expect(result).toEqual({ version: 'new' });
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe('API backward compatibility', () => {
    it('list excludes .bak, .tmp, and .sha256 files', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1' });
      await store.write('episodes', 'ep1', { id: 'ep1', v: 2 }); // creates .bak

      const ids = await store.list('episodes');
      expect(ids).toEqual(['ep1']);
    });

    it('delete removes data, backup, and checksum files', async () => {
      await store.write('episodes', 'ep1', { id: 'ep1' });
      await store.write('episodes', 'ep1', { id: 'ep1', v: 2 });
      await store.delete('episodes', 'ep1');

      const filePath = path.join(tmpDir, 'episodes', 'ep1.json');
      await expect(stat(filePath)).rejects.toThrow();
      await expect(stat(`${filePath}.bak`)).rejects.toThrow();
      await expect(stat(`${filePath}.sha256`)).rejects.toThrow();
    });

    it('readAll returns all valid items', async () => {
      await store.write('episodes', 'a', { id: 'a' });
      await store.write('episodes', 'b', { id: 'b' });

      const all = await store.readAll<{ id: string }>('episodes');
      expect(all).toHaveLength(2);
      expect(all.map((x) => x.id).sort()).toEqual(['a', 'b']);
    });

    it('constructor works with single argument (no options)', () => {
      const s = new FileStore('/some/path');
      expect(s).toBeInstanceOf(FileStore);
    });
  });
});
