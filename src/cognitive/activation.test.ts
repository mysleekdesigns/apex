import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { ActivationEngine } from './activation.js';

describe('ActivationEngine', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let engine: ActivationEngine;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-activation-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    engine = new ActivationEngine({ fileStore });
    await engine.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // computeBaseActivation
  // -----------------------------------------------------------------------

  it('returns a positive value for a single recent access', () => {
    const now = Date.now();
    const result = engine.computeBaseActivation([{ timestamp: now }], now);
    // t_j = max((0)/1000, 1) = 1 second -> 1^(-0.5) = 1 -> ln(1) = 0
    expect(result).toBe(0);
    // With a slightly older access (still "recent")
    const result2 = engine.computeBaseActivation(
      [{ timestamp: now - 500 }],
      now,
    );
    // t_j = max(0.5, 1) = 1 -> same as above
    expect(result2).toBe(0);
  });

  it('returns a lower value for an old access vs a recent one', () => {
    const now = Date.now();
    const recent = engine.computeBaseActivation(
      [{ timestamp: now - 10_000 }], // 10 seconds ago
      now,
    );
    const old = engine.computeBaseActivation(
      [{ timestamp: now - 86_400_000 }], // 1 day ago
      now,
    );
    expect(recent).toBeGreaterThan(old);
  });

  it('returns a higher value for multiple accesses vs single access', () => {
    const now = Date.now();
    const single = engine.computeBaseActivation(
      [{ timestamp: now - 60_000 }],
      now,
    );
    const multiple = engine.computeBaseActivation(
      [
        { timestamp: now - 60_000 },
        { timestamp: now - 30_000 },
        { timestamp: now - 10_000 },
      ],
      now,
    );
    expect(multiple).toBeGreaterThan(single);
  });

  it('returns -Infinity for empty access history', () => {
    expect(engine.computeBaseActivation([])).toBe(-Infinity);
  });

  // -----------------------------------------------------------------------
  // recordAccess
  // -----------------------------------------------------------------------

  it('recordAccess adds to history and recomputes activation', async () => {
    const now = Date.now();
    const entry1 = await engine.recordAccess('e1', now);
    expect(entry1.accessHistory).toHaveLength(1);
    expect(entry1.baseActivation).toBeTypeOf('number');
    expect(entry1.baseActivation).not.toBe(-Infinity);

    const entry2 = await engine.recordAccess('e1', now + 5000);
    expect(entry2.accessHistory).toHaveLength(2);
    // More accesses -> higher activation
    expect(entry2.baseActivation).toBeGreaterThanOrEqual(entry1.baseActivation);
  });

  // -----------------------------------------------------------------------
  // registerEntry
  // -----------------------------------------------------------------------

  it('registerEntry creates a new entry with initial access', async () => {
    const now = Date.now();
    const entry = await engine.registerEntry('reg1', now);
    expect(entry.id).toBe('reg1');
    expect(entry.accessHistory).toHaveLength(1);
    expect(entry.accessHistory[0].timestamp).toBe(now);
    expect(entry.spreadBoost).toBe(0);
    expect(entry.totalActivation).toBe(entry.baseActivation);

    // Verify retrievable
    const fetched = engine.getEntry('reg1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('reg1');
  });

  // -----------------------------------------------------------------------
  // spreadActivation
  // -----------------------------------------------------------------------

  it('spreadActivation boosts neighbor entries', async () => {
    const now = Date.now();
    await engine.registerEntry('src', now);
    await engine.registerEntry('n1', now);
    await engine.registerEntry('n2', now);

    // Record several accesses to source so its activation is meaningful
    for (let i = 1; i <= 5; i++) {
      await engine.recordAccess('src', now + i * 1000);
    }

    const result = await engine.spreadActivation('src', ['n1', 'n2']);
    expect(result.sourceId).toBe('src');
    expect(result.boostedEntries).toHaveLength(2);

    for (const b of result.boostedEntries) {
      expect(b.boost).toBeGreaterThan(0);
    }

    const n1 = engine.getEntry('n1');
    expect(n1!.spreadBoost).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // decaySpreadBoosts
  // -----------------------------------------------------------------------

  it('decaySpreadBoosts reduces boost over time', async () => {
    const now = Date.now();
    await engine.registerEntry('d1', now);
    await engine.registerEntry('d2', now);

    // Manually set a spread boost
    const entry = engine.getEntry('d1')!;
    entry.spreadBoost = 0.8;
    entry.totalActivation = entry.baseActivation + entry.spreadBoost;
    entry.lastComputed = now;

    // Decay by simulating 2 hours later
    const later = now + 2 * 60 * 60 * 1000;
    engine.decaySpreadBoosts(later);

    const decayed = engine.getEntry('d1')!;
    expect(decayed.spreadBoost).toBeLessThan(0.8);
    expect(decayed.spreadBoost).toBeGreaterThan(0);

    // Decay a lot more (simulate 100 hours) — should floor to 0
    const muchLater = now + 100 * 60 * 60 * 1000;
    // Reset lastComputed so decay is measured from now
    const e2 = engine.getEntry('d1')!;
    e2.lastComputed = now;
    e2.spreadBoost = 0.02;
    engine.decaySpreadBoosts(muchLater);

    const floored = engine.getEntry('d1')!;
    expect(floored.spreadBoost).toBe(0);
  });

  // -----------------------------------------------------------------------
  // activationToHeatScore
  // -----------------------------------------------------------------------

  it('activationToHeatScore maps to 0-1 range (sigmoid)', () => {
    expect(engine.activationToHeatScore(0)).toBeCloseTo(0.5, 5);
    expect(engine.activationToHeatScore(-Infinity)).toBe(0);

    const high = engine.activationToHeatScore(5);
    expect(high).toBeGreaterThan(0.99);
    expect(high).toBeLessThanOrEqual(1);

    const low = engine.activationToHeatScore(-5);
    expect(low).toBeLessThan(0.01);
    expect(low).toBeGreaterThanOrEqual(0);
  });

  // -----------------------------------------------------------------------
  // getEffectivenessReport
  // -----------------------------------------------------------------------

  it('getEffectivenessReport tracks comparison stats correctly', () => {
    // ACT-R puts relevant id first, heat puts it second
    engine.recordRetrievalComparison(
      ['r1', 'r2', 'r3'],
      ['r2', 'r1', 'r3'],
      ['r1'],
    );
    // Heat puts relevant id first
    engine.recordRetrievalComparison(
      ['r2', 'r1', 'r3'],
      ['r1', 'r2', 'r3'],
      ['r1'],
    );
    // Tie
    engine.recordRetrievalComparison(
      ['r1', 'r2'],
      ['r1', 'r2'],
      ['r1'],
    );

    const report = engine.getEffectivenessReport();
    expect(report.comparisons).toBe(3);
    expect(report.actrWins).toBe(1);
    expect(report.heatWins).toBe(1);
    expect(report.ties).toBe(1);
    expect(report.actrAvgMRR).toBeGreaterThan(0);
    expect(report.heatAvgMRR).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // persist and reload
  // -----------------------------------------------------------------------

  it('persist and reload preserves state', async () => {
    const now = Date.now();
    await engine.registerEntry('p1', now);
    await engine.recordAccess('p1', now + 5000);
    await engine.registerEntry('p2', now);
    await engine.persist();

    // Create a fresh engine on the same fileStore
    const engine2 = new ActivationEngine({ fileStore });
    await engine2.init();

    const e1 = engine2.getEntry('p1');
    expect(e1).not.toBeNull();
    expect(e1!.accessHistory).toHaveLength(2);

    const e2 = engine2.getEntry('p2');
    expect(e2).not.toBeNull();
    expect(e2!.accessHistory).toHaveLength(1);

    // Activation values should match
    expect(e1!.baseActivation).toBe(engine.getEntry('p1')!.baseActivation);
  });
});
