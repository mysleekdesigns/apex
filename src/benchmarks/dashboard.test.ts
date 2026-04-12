/**
 * Tests for the APEX Benchmark Dashboard module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  type BenchmarkEntry,
  type DashboardReport,
  generateDashboard,
  checkCIGates,
  loadHistory,
  saveToHistory,
} from './dashboard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<BenchmarkEntry> = {}): BenchmarkEntry {
  return {
    name: 'test-benchmark',
    category: 'recall',
    score: 0.8,
    passed: true,
    threshold: 0.5,
    details: { recall1: 0.9, mrr: 0.85 },
    timestamp: Date.now(),
    latencyMs: 42,
    ...overrides,
  };
}

function makeMixedEntries(): BenchmarkEntry[] {
  return [
    makeEntry({ name: 'recall-exact', category: 'recall', score: 0.9, passed: true, threshold: 0.5, latencyMs: 30 }),
    makeEntry({ name: 'recall-semantic', category: 'recall', score: 0.7, passed: true, threshold: 0.5, latencyMs: 55 }),
    makeEntry({ name: 'skill-transfer-basic', category: 'skill-transfer', score: 0.6, passed: true, threshold: 0.4 }),
    makeEntry({ name: 'reflection-quality', category: 'reflection', score: 0.75, passed: true, threshold: 0.5 }),
    makeEntry({ name: 'consolidation-loss', category: 'consolidation', score: 0.85, passed: true, threshold: 0.5 }),
    makeEntry({ name: 'embedding-latency', category: 'latency', score: 0.95, passed: true, threshold: 0.5, latencyMs: 25 }),
  ];
}

function makeReport(overrides: Partial<DashboardReport> = {}): DashboardReport {
  const entries = makeMixedEntries();
  const passed = entries.filter((e) => e.passed).length;
  return {
    generatedAt: Date.now(),
    entries,
    summary: {
      totalBenchmarks: entries.length,
      passed,
      failed: entries.length - passed,
      overallScore: 0.79,
    },
    history: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('dashboard', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apex-dashboard-test-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // HTML generation
  // -------------------------------------------------------------------------

  describe('generateDashboard', () => {
    it('produces valid HTML with expected sections', async () => {
      const entries = makeMixedEntries();
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>APEX Benchmark Dashboard</title>');
      expect(html).toContain('Summary');
      expect(html).toContain('Benchmark Details');
      expect(html).toContain('Latency');
    });

    it('includes benchmark names and scores in the HTML', async () => {
      const entries = [
        makeEntry({ name: 'my-unique-bench', score: 0.72, passed: true }),
      ];
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      expect(html).toContain('my-unique-bench');
      expect(html).toContain('72.0%');
    });

    it('writes the HTML file to disk', async () => {
      const entries = makeMixedEntries();
      const outputPath = path.join(tmpDir, 'output', 'dashboard.html');

      await generateDashboard(entries, outputPath);

      const content = await readFile(outputPath, 'utf-8');
      expect(content).toContain('<title>APEX Benchmark Dashboard</title>');
    });

    it('shows pass/fail status icons', async () => {
      const entries = [
        makeEntry({ name: 'passing', passed: true }),
        makeEntry({ name: 'failing', passed: false, score: 0.2 }),
      ];
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      // Check mark and X mark
      expect(html).toContain('&#10003;');
      expect(html).toContain('&#10007;');
    });

    it('renders history trend section when history is provided', async () => {
      const historyPath = path.join(tmpDir, 'history.json');
      const pastReport = makeReport({ generatedAt: Date.now() - 86400000 });

      // Seed history
      await saveToHistory(pastReport, historyPath);

      const entries = makeMixedEntries();
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath, historyPath);

      expect(html).toContain('Score Trend');
      expect(html).toContain('trend-chart');
    });

    it('shows CI gate warnings when benchmarks fail gates', async () => {
      const entries = [
        makeEntry({ name: 'bad-recall', category: 'recall', score: 0.1, passed: false, threshold: 0.5, latencyMs: 200 }),
      ];
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      expect(html).toContain('CI Gate Failures');
      expect(html).toContain('bad-recall');
    });

    it('does not show CI warning when all gates pass', async () => {
      const entries = makeMixedEntries();
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      expect(html).not.toContain('CI Gate Failures');
    });

    it('escapes HTML in benchmark names', async () => {
      const entries = [
        makeEntry({ name: '<script>alert("xss")</script>' }),
      ];
      const outputPath = path.join(tmpDir, 'report.html');

      const html = await generateDashboard(entries, outputPath);

      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  // -------------------------------------------------------------------------
  // CI gate checking
  // -------------------------------------------------------------------------

  describe('checkCIGates', () => {
    it('passes when all benchmarks meet thresholds', () => {
      const entries = makeMixedEntries();
      const result = checkCIGates(entries);

      expect(result.passed).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('fails when overall score is below minimum', () => {
      const entries = [
        makeEntry({ score: 0.1, passed: false, category: 'recall' }),
        makeEntry({ score: 0.1, passed: false, category: 'skill-transfer' }),
        makeEntry({ score: 0.1, passed: false, category: 'reflection' }),
      ];
      const result = checkCIGates(entries);

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('Overall score'))).toBe(true);
    });

    it('fails when recall latency exceeds threshold', () => {
      const entries = [
        makeEntry({ name: 'slow-recall', category: 'recall', latencyMs: 150, score: 0.8 }),
      ];
      const result = checkCIGates(entries, { maxRecallLatencyMs: 100 });

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('Recall latency'))).toBe(true);
    });

    it('fails when embedding latency exceeds threshold', () => {
      const entries = [
        makeEntry({ name: 'slow-embed', category: 'latency', latencyMs: 80, score: 0.8 }),
      ];
      const result = checkCIGates(entries, { maxEmbeddingLatencyMs: 50 });

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('Embedding latency'))).toBe(true);
    });

    it('reports individual benchmark failures', () => {
      const entries = [
        makeEntry({ name: 'good-bench', passed: true, score: 0.8 }),
        makeEntry({ name: 'bad-bench', passed: false, score: 0.2, threshold: 0.5 }),
      ];
      const result = checkCIGates(entries);

      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('bad-bench'))).toBe(true);
      expect(result.failures.some((f) => f.includes('good-bench'))).toBe(false);
    });

    it('respects custom config overrides', () => {
      const entries = [
        makeEntry({ category: 'recall', latencyMs: 200, score: 0.9 }),
      ];

      // Should fail with default config (100ms max)
      const strict = checkCIGates(entries);
      expect(strict.passed).toBe(false);

      // Should pass with relaxed config
      const relaxed = checkCIGates(entries, { maxRecallLatencyMs: 300 });
      expect(relaxed.passed).toBe(true);
    });

    it('passes with empty entries', () => {
      const result = checkCIGates([]);
      // No entries means no individual failures, but overall score is 0
      // which is below the 0.5 minimum
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('Overall score'))).toBe(true);
    });

    it('passes empty entries when minOverallScore is 0', () => {
      const result = checkCIGates([], { minOverallScore: 0 });
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // History load/save roundtrip
  // -------------------------------------------------------------------------

  describe('loadHistory / saveToHistory', () => {
    it('returns empty array when no history file exists', async () => {
      const result = await loadHistory(path.join(tmpDir, 'nonexistent.json'));
      expect(result).toEqual([]);
    });

    it('roundtrips a report through save and load', async () => {
      const historyPath = path.join(tmpDir, 'history.json');
      const report = makeReport();

      await saveToHistory(report, historyPath);
      const loaded = await loadHistory(historyPath);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].summary.totalBenchmarks).toBe(report.summary.totalBenchmarks);
      expect(loaded[0].summary.overallScore).toBe(report.summary.overallScore);
    });

    it('appends to existing history', async () => {
      const historyPath = path.join(tmpDir, 'history.json');

      await saveToHistory(makeReport({ generatedAt: 1000 }), historyPath);
      await saveToHistory(makeReport({ generatedAt: 2000 }), historyPath);
      await saveToHistory(makeReport({ generatedAt: 3000 }), historyPath);

      const loaded = await loadHistory(historyPath);
      expect(loaded).toHaveLength(3);
      expect(loaded[0].generatedAt).toBe(1000);
      expect(loaded[2].generatedAt).toBe(3000);
    });

    it('trims history to 20 entries', async () => {
      const historyPath = path.join(tmpDir, 'history.json');

      for (let i = 0; i < 25; i++) {
        await saveToHistory(makeReport({ generatedAt: i * 1000 }), historyPath);
      }

      const loaded = await loadHistory(historyPath);
      expect(loaded).toHaveLength(20);
      // Should keep the most recent 20
      expect(loaded[0].generatedAt).toBe(5 * 1000);
      expect(loaded[19].generatedAt).toBe(24 * 1000);
    });

    it('strips nested history from saved reports', async () => {
      const historyPath = path.join(tmpDir, 'history.json');
      const report = makeReport({
        history: [makeReport(), makeReport()],
      });

      await saveToHistory(report, historyPath);
      const loaded = await loadHistory(historyPath);

      expect(loaded[0].history).toEqual([]);
    });

    it('creates parent directories if they do not exist', async () => {
      const historyPath = path.join(tmpDir, 'deep', 'nested', 'history.json');
      await saveToHistory(makeReport(), historyPath);

      const loaded = await loadHistory(historyPath);
      expect(loaded).toHaveLength(1);
    });

    it('handles corrupt JSON gracefully', async () => {
      const historyPath = path.join(tmpDir, 'bad.json');
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(historyPath, '{ invalid json !!!', 'utf-8');

      const loaded = await loadHistory(historyPath);
      expect(loaded).toEqual([]);
    });
  });
});
