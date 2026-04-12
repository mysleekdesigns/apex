/**
 * LoCoMo-Adapted Recall Accuracy Benchmark for APEX Memory System
 *
 * Tests memory recall accuracy at various depths with three match types:
 * exact, semantic, and partial. Measures recall@K, MRR, false positive
 * rate, and latency.
 *
 * Inspired by the LoCoMo benchmark for long-context memory evaluation.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryManager } from '../memory/manager.js';
import { generateId } from '../types.js';
import { computeMRR, computeRecallAtK } from '../utils/similarity.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecallBenchmarkConfig {
  /** Memory depths to test (number of entries seeded). */
  depths: number[];
  /** Number of queries to run per depth per match type. */
  queriesPerDepth: number;
  /** Maximum results to retrieve per query. */
  topK: number;
}

export interface RecallBenchmarkResult {
  depth: number;
  matchType: 'exact' | 'semantic' | 'partial';
  metrics: {
    recall1: number;
    recall5: number;
    recall10: number;
    mrr: number;
    falsePositiveRate: number;
    avgLatencyMs: number;
  };
}

// ---------------------------------------------------------------------------
// Synthetic data generation
// ---------------------------------------------------------------------------

const DOMAINS = [
  'typescript', 'react', 'python', 'testing', 'debugging',
  'refactoring', 'deployment', 'database', 'api', 'authentication',
] as const;

const TASK_TEMPLATES: string[] = [
  'fix {domain} compilation error in module',
  'add unit tests for {domain} service layer',
  'refactor {domain} handler to use dependency injection',
  'debug {domain} timeout issue in production',
  'implement {domain} caching strategy for performance',
  'migrate {domain} schema to new version',
  'update {domain} configuration for staging environment',
  'resolve {domain} race condition in async handler',
  'optimize {domain} query performance with indexing',
  'add error handling to {domain} integration endpoint',
  'create {domain} validation middleware',
  'set up {domain} monitoring and alerting',
  'write integration tests for {domain} workflow',
  'implement {domain} retry logic with backoff',
  'fix {domain} memory leak in event listener',
  'add {domain} rate limiting to public endpoint',
  'configure {domain} logging with structured output',
  'implement {domain} pagination for list endpoint',
  'fix {domain} serialization bug in response payload',
  'add {domain} health check endpoint',
];

/**
 * Semantic paraphrases: alternative wordings for the same concept.
 * Used to test recall when queries use different vocabulary.
 */
const SEMANTIC_MAPPINGS: Record<string, string[]> = {
  'fix': ['resolve', 'repair', 'correct', 'patch'],
  'error': ['bug', 'issue', 'defect', 'problem'],
  'compilation': ['build', 'transpilation', 'compile-time'],
  'add': ['implement', 'create', 'introduce', 'build'],
  'unit tests': ['test suite', 'test coverage', 'automated tests'],
  'refactor': ['restructure', 'reorganize', 'clean up'],
  'debug': ['troubleshoot', 'diagnose', 'investigate'],
  'timeout': ['latency spike', 'slow response', 'performance degradation'],
  'optimize': ['improve performance', 'speed up', 'make faster'],
  'query': ['database call', 'data fetch', 'db operation'],
  'authentication': ['auth', 'login', 'identity verification'],
  'deployment': ['release', 'shipping', 'rollout'],
  'caching': ['memoization', 'cache layer', 'in-memory store'],
  'memory leak': ['resource leak', 'unbounded allocation', 'gc pressure'],
  'rate limiting': ['throttling', 'request cap', 'traffic control'],
};

interface SeededEntry {
  id: string;
  content: string;
  domain: string;
}

function generateSyntheticEntries(count: number): SeededEntry[] {
  const entries: SeededEntry[] = [];
  for (let i = 0; i < count; i++) {
    const domain = DOMAINS[i % DOMAINS.length];
    const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length];
    const content = template.replace('{domain}', domain);
    entries.push({
      id: generateId(),
      content,
      domain,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

interface BenchmarkQuery {
  queryText: string;
  relevantIds: Set<string>;
  matchType: 'exact' | 'semantic' | 'partial';
}

function generateExactQueries(
  entries: SeededEntry[],
  count: number,
): BenchmarkQuery[] {
  const queries: BenchmarkQuery[] = [];
  const step = Math.max(1, Math.floor(entries.length / count));

  for (let i = 0; i < count && i * step < entries.length; i++) {
    const target = entries[i * step];
    // Use a significant portion of the stored content as the query
    const words = target.content.split(/\s+/);
    const queryText = words.slice(0, Math.max(3, Math.ceil(words.length * 0.7))).join(' ');

    // The target entry plus any others with same content/keywords should match
    const relevantIds = new Set<string>();
    relevantIds.add(target.id);
    // Also consider entries sharing the same domain keyword overlap
    for (const e of entries) {
      if (e.id !== target.id && e.content === target.content) {
        relevantIds.add(e.id);
      }
    }

    queries.push({ queryText, relevantIds, matchType: 'exact' });
  }

  return queries;
}

function generateSemanticQueries(
  entries: SeededEntry[],
  count: number,
): BenchmarkQuery[] {
  const queries: BenchmarkQuery[] = [];
  const step = Math.max(1, Math.floor(entries.length / count));

  for (let i = 0; i < count && i * step < entries.length; i++) {
    const target = entries[i * step];
    // Replace keywords with semantic alternatives
    let queryText = target.content;
    for (const [original, alternatives] of Object.entries(SEMANTIC_MAPPINGS)) {
      if (queryText.includes(original)) {
        const alt = alternatives[i % alternatives.length];
        queryText = queryText.replace(original, alt);
        break; // One substitution per query
      }
    }

    const relevantIds = new Set<string>();
    relevantIds.add(target.id);

    queries.push({ queryText, relevantIds, matchType: 'semantic' });
  }

  return queries;
}

function generatePartialQueries(
  entries: SeededEntry[],
  count: number,
): BenchmarkQuery[] {
  const queries: BenchmarkQuery[] = [];
  const step = Math.max(1, Math.floor(entries.length / count));

  for (let i = 0; i < count && i * step < entries.length; i++) {
    const target = entries[i * step];
    // Use just the domain keyword as a partial match
    const queryText = `${target.domain} issue`;

    // All entries sharing this domain are relevant for partial match
    const relevantIds = new Set<string>();
    for (const e of entries) {
      if (e.domain === target.domain) {
        relevantIds.add(e.id);
      }
    }

    queries.push({ queryText, relevantIds, matchType: 'partial' });
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: RecallBenchmarkConfig = {
  depths: [10, 100, 500, 1000],
  queriesPerDepth: 20,
  topK: 10,
};

/**
 * Run the LoCoMo-adapted recall accuracy benchmark.
 *
 * Creates an isolated MemoryManager per depth, seeds it with synthetic
 * episodes, then queries with exact, semantic, and partial match queries
 * to measure retrieval quality.
 */
export async function runRecallBenchmark(
  config?: Partial<RecallBenchmarkConfig>,
): Promise<RecallBenchmarkResult[]> {
  const cfg: RecallBenchmarkConfig = { ...DEFAULT_CONFIG, ...config };
  const results: RecallBenchmarkResult[] = [];

  for (const depth of cfg.depths) {
    // Create isolated temp directory for this run
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bench-'));
    const projectDataPath = path.join(tmpDir, '.apex-data');

    try {
      const mm = new MemoryManager({
        projectDataPath,
        projectPath: tmpDir,
        limits: { working: 10, episodic: depth + 100, semantic: 5000 },
      });
      await mm.init();

      // Seed memory with synthetic entries
      const entries = generateSyntheticEntries(depth);
      const entryIdMap = new Map<string, string>();

      for (const entry of entries) {
        const stored = await mm.addToEpisodic(entry.content);
        entryIdMap.set(entry.id, stored.id);
      }

      // Remap synthetic IDs to actual stored IDs
      function remapIds(originalIds: Set<string>): Set<string> {
        const mapped = new Set<string>();
        for (const origId of originalIds) {
          const storedId = entryIdMap.get(origId);
          if (storedId) mapped.add(storedId);
        }
        return mapped;
      }

      // Generate queries for each match type
      const matchTypes = [
        { type: 'exact' as const, generator: generateExactQueries },
        { type: 'semantic' as const, generator: generateSemanticQueries },
        { type: 'partial' as const, generator: generatePartialQueries },
      ];

      for (const { type, generator } of matchTypes) {
        const queries = generator(entries, cfg.queriesPerDepth);

        let totalRecall1 = 0;
        let totalRecall5 = 0;
        let totalRecall10 = 0;
        let totalMRR = 0;
        let totalFP = 0;
        let totalLatencyMs = 0;
        let queryCount = 0;

        for (const q of queries) {
          const relevantIds = remapIds(q.relevantIds);
          if (relevantIds.size === 0) continue;

          const start = performance.now();
          const searchResults = await mm.recall(q.queryText, cfg.topK);
          const latencyMs = performance.now() - start;

          const rankedIds = searchResults.map((r) => r.entry.id);

          totalRecall1 += computeRecallAtK(rankedIds, relevantIds, 1);
          totalRecall5 += computeRecallAtK(rankedIds, relevantIds, Math.min(5, cfg.topK));
          totalRecall10 += computeRecallAtK(rankedIds, relevantIds, Math.min(10, cfg.topK));
          totalMRR += computeMRR(rankedIds, relevantIds);

          // False positive rate: fraction of returned results not in relevant set
          const fpCount = rankedIds.filter((id) => !relevantIds.has(id)).length;
          totalFP += rankedIds.length > 0 ? fpCount / rankedIds.length : 0;

          totalLatencyMs += latencyMs;
          queryCount++;
        }

        if (queryCount > 0) {
          results.push({
            depth,
            matchType: type,
            metrics: {
              recall1: totalRecall1 / queryCount,
              recall5: totalRecall5 / queryCount,
              recall10: totalRecall10 / queryCount,
              mrr: totalMRR / queryCount,
              falsePositiveRate: totalFP / queryCount,
              avgLatencyMs: totalLatencyMs / queryCount,
            },
          });
        }
      }
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  return results;
}
