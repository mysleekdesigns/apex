/**
 * Consolidation Loss Benchmark
 *
 * Measures information loss during memory tier promotions
 * (working → episodic → semantic). Tracks query answerability,
 * promotion retention, and merge quality across consolidation cycles.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryManager } from '../memory/manager.js';
import { combinedSimilarity } from '../utils/similarity.js';
import { getEmbedding } from '../utils/embeddings.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ConsolidationLossConfig {
  /** Number of entries to seed into working memory (default 20). */
  entryCount: number;
  /** Number of queries to test per entry (default 2). */
  queriesPerEntry: number;
  /** How many consolidation rounds to run (default 2). */
  consolidationCycles: number;
}

export interface ConsolidationLossResult {
  /** Can promoted entries still answer original queries? */
  promotionRetention: {
    /** Fraction of original entries still retrievable after working→episodic */
    workingToEpisodic: number;
    /** Fraction of original entries still retrievable after episodic→semantic */
    episodicToSemantic: number;
    /** Overall retention across all promotions */
    overallRetention: number;
  };
  /** Query answerability before and after consolidation */
  queryAnswerability: {
    preConsolidation: number;
    postConsolidation: number;
    answerabilityDelta: number;
  };
  /** Merge quality assessment */
  mergeQuality: {
    /** Of merged entries, what fraction preserve key facts from originals? */
    factPreservation: number;
    /** Average similarity between original and merged content */
    avgContentSimilarity: number;
    entriesMerged: number;
  };
  totalEntriesSeeded: number;
  totalQueriesRun: number;
  avgLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------

const DOMAINS = [
  'typescript', 'react', 'python', 'testing', 'debugging',
  'refactoring', 'deployment', 'database', 'api', 'authentication',
] as const;

const TEMPLATES = [
  'fix {domain} compilation error in parser module',
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
  'implement {domain} retry logic with exponential backoff',
  'fix {domain} memory leak in event listener cleanup',
  'add {domain} rate limiting to public endpoint',
  'configure {domain} logging with structured output format',
  'implement {domain} pagination for list endpoint',
  'fix {domain} serialization bug in response payload',
  'add {domain} health check endpoint with metrics',
];

interface SeededEntry {
  content: string;
  queries: string[];
}

function generateEntries(count: number): SeededEntry[] {
  const entries: SeededEntry[] = [];
  for (let i = 0; i < count; i++) {
    const domain = DOMAINS[i % DOMAINS.length];
    const template = TEMPLATES[i % TEMPLATES.length];
    const content = template.replace('{domain}', domain);

    // Generate queries that should match this entry
    const words = content.split(/\s+/);
    const queries = [
      // Use a subset of original words
      words.slice(0, Math.max(3, Math.ceil(words.length * 0.6))).join(' '),
      // Use domain + key action word
      `${domain} ${words[0]}`,
    ];

    entries.push({ content, queries });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if any result content is similar enough to the original. */
function isRetained(
  originalContent: string,
  results: Array<{ entry: { content: string } }>,
  threshold = 0.3,
): boolean {
  const origEmb = getEmbedding(originalContent);
  for (const r of results) {
    const resEmb = getEmbedding(r.entry.content);
    const sim = combinedSimilarity(origEmb, resEmb);
    if (sim >= threshold) return true;
  }
  return false;
}

/** Compute keyword overlap between two strings as a fact-preservation proxy. */
function keywordOverlap(a: string, b: string): number {
  const kwA = new Set(getEmbedding(a).keywords);
  const kwB = new Set(getEmbedding(b).keywords);
  if (kwA.size === 0 && kwB.size === 0) return 1;
  if (kwA.size === 0 || kwB.size === 0) return 0;
  let intersection = 0;
  for (const k of kwA) if (kwB.has(k)) intersection++;
  const union = new Set([...kwA, ...kwB]).size;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ConsolidationLossConfig = {
  entryCount: 20,
  queriesPerEntry: 2,
  consolidationCycles: 2,
};

/**
 * Run the consolidation loss benchmark.
 *
 * Creates an isolated MemoryManager, seeds working memory, then runs
 * consolidation cycles while measuring retention, answerability, and
 * merge quality at each tier transition.
 */
export async function runConsolidationLossBenchmark(
  config?: Partial<ConsolidationLossConfig>,
): Promise<ConsolidationLossResult> {
  const cfg: ConsolidationLossConfig = { ...DEFAULT_CONFIG, ...config };

  // Use small limits to force promotions
  const workingCapacity = Math.max(1, Math.min(5, Math.floor(cfg.entryCount / 2)));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-consoloss-'));
  const projectDataPath = path.join(tmpDir, '.apex-data');

  try {
    const mm = new MemoryManager({
      projectDataPath,
      projectPath: tmpDir,
      limits: {
        working: workingCapacity,
        episodic: 50,
        semantic: 100,
      },
      consolidationThreshold: workingCapacity,
    });
    await mm.init();

    const entries = generateEntries(cfg.entryCount);
    const allQueries: Array<{ query: string; originalContent: string }> = [];
    let totalLatencyMs = 0;
    let queryCount = 0;

    // -------------------------------------------------------------------
    // Phase 1: Seed working memory and measure pre-consolidation queries
    // -------------------------------------------------------------------

    for (const entry of entries) {
      mm.addToWorking(entry.content);
      for (const q of entry.queries.slice(0, cfg.queriesPerEntry)) {
        allQueries.push({ query: q, originalContent: entry.content });
      }
    }

    // Allow overflow handlers to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Measure pre-consolidation answerability
    let preAnswerable = 0;
    for (const { query, originalContent } of allQueries) {
      const start = performance.now();
      const results = await mm.recall(query, 10);
      totalLatencyMs += performance.now() - start;
      queryCount++;
      if (isRetained(originalContent, results)) preAnswerable++;
    }
    const preConsolidation = allQueries.length > 0
      ? preAnswerable / allQueries.length
      : 0;

    // -------------------------------------------------------------------
    // Phase 2: Consolidate working → episodic, measure retention
    // -------------------------------------------------------------------

    await mm.consolidate();

    let workingToEpisodicRetained = 0;
    for (const entry of entries) {
      const start = performance.now();
      const results = await mm.recall(entry.content, 10);
      totalLatencyMs += performance.now() - start;
      queryCount++;
      if (isRetained(entry.content, results)) workingToEpisodicRetained++;
    }
    const workingToEpisodic = entries.length > 0
      ? workingToEpisodicRetained / entries.length
      : 0;

    // -------------------------------------------------------------------
    // Phase 3: Boost heat scores and age entries to trigger episodic→semantic
    // -------------------------------------------------------------------

    // Access entries multiple times to increase heat scores
    for (let cycle = 0; cycle < cfg.consolidationCycles; cycle++) {
      for (const entry of entries) {
        const start = performance.now();
        await mm.recall(entry.content, 5);
        totalLatencyMs += performance.now() - start;
        queryCount++;
      }

      // Record content into episodic directly with high relevance
      // to increase the chance of semantic promotion
      for (let i = 0; i < Math.min(5, entries.length); i++) {
        await mm.addToEpisodic(entries[i].content);
      }

      await mm.consolidate();
    }

    // -------------------------------------------------------------------
    // Phase 4: Measure episodic→semantic retention
    // -------------------------------------------------------------------

    let episodicToSemanticRetained = 0;
    for (const entry of entries) {
      const start = performance.now();
      const results = await mm.recall(entry.content, 10);
      totalLatencyMs += performance.now() - start;
      queryCount++;
      if (isRetained(entry.content, results)) episodicToSemanticRetained++;
    }
    const episodicToSemantic = entries.length > 0
      ? episodicToSemanticRetained / entries.length
      : 0;

    // -------------------------------------------------------------------
    // Phase 5: Measure post-consolidation query answerability
    // -------------------------------------------------------------------

    let postAnswerable = 0;
    for (const { query, originalContent } of allQueries) {
      const start = performance.now();
      const results = await mm.recall(query, 10);
      totalLatencyMs += performance.now() - start;
      queryCount++;
      if (isRetained(originalContent, results)) postAnswerable++;
    }
    const postConsolidation = allQueries.length > 0
      ? postAnswerable / allQueries.length
      : 0;

    // -------------------------------------------------------------------
    // Phase 6: Measure merge quality
    // -------------------------------------------------------------------

    const status = await mm.status();
    const entriesMerged = status.semantic.dedupHitCount;

    // Compare semantic entries against originals for fact preservation
    const semanticMemory = mm.getSemanticMemory();
    const semanticEntries = semanticMemory.all();

    let totalFactPreservation = 0;
    let totalContentSimilarity = 0;
    let comparisonCount = 0;

    for (const semEntry of semanticEntries) {
      const semEmb = getEmbedding(semEntry.content);
      let bestOverlap = 0;
      let bestSimilarity = 0;

      for (const orig of entries) {
        const origEmb = getEmbedding(orig.content);
        const overlap = keywordOverlap(orig.content, semEntry.content);
        const sim = combinedSimilarity(origEmb, semEmb);
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestOverlap = overlap;
        }
      }

      totalFactPreservation += bestOverlap;
      totalContentSimilarity += bestSimilarity;
      comparisonCount++;
    }

    const factPreservation = comparisonCount > 0
      ? totalFactPreservation / comparisonCount
      : 0;
    const avgContentSimilarity = comparisonCount > 0
      ? totalContentSimilarity / comparisonCount
      : 0;

    // -------------------------------------------------------------------
    // Build result
    // -------------------------------------------------------------------

    const overallRetention = (workingToEpisodic + episodicToSemantic) / 2;

    return {
      promotionRetention: {
        workingToEpisodic,
        episodicToSemantic,
        overallRetention,
      },
      queryAnswerability: {
        preConsolidation,
        postConsolidation,
        answerabilityDelta: postConsolidation - preConsolidation,
      },
      mergeQuality: {
        factPreservation,
        avgContentSimilarity,
        entriesMerged,
      },
      totalEntriesSeeded: cfg.entryCount,
      totalQueriesRun: queryCount,
      avgLatencyMs: queryCount > 0 ? totalLatencyMs / queryCount : 0,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
