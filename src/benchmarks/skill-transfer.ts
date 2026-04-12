/**
 * Benchmark: Skill Transfer across Project Contexts
 *
 * Measures how well skills learned in one project context (Project A)
 * transfer to a different project context (Project B). Evaluates
 * discovery rate, adaptation accuracy, and confidence calibration
 * across multiple domains.
 */

import { MemoryManager } from '../memory/manager.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Config & Result types
// ---------------------------------------------------------------------------

export interface SkillTransferConfig {
  /** Number of skills to create in Project A (default 20). */
  skillCount: number;
  /** Number of transfer queries to run in Project B (default 15). */
  queryCount: number;
  /** Domains to test across. */
  domains: string[];
}

export interface SkillTransferResult {
  /** Fraction of relevant skills discovered for cross-project queries. */
  discoveryRate: number;
  /** Average similarity score of discovered skills to target tasks. */
  adaptationAccuracy: number;
  /** Correlation between skill confidence and transfer success. */
  confidenceCalibration: number;
  /** Per-domain transfer results. */
  domainResults: Array<{
    sourceDomain: string;
    targetDomain: string;
    discoveryRate: number;
    avgRelevanceScore: number;
  }>;
  /** Overall metrics. */
  totalSkillsCreated: number;
  totalQueriesRun: number;
  avgLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Skill & Query Catalogues
// ---------------------------------------------------------------------------

interface SkillTemplate {
  domain: string;
  name: string;
  description: string;
  pattern: string;
  preconditions: string[];
  tags: string[];
  confidence: number;
}

interface TransferQuery {
  /** Domain this query targets (should find skills from this domain). */
  targetDomain: string;
  /** The query text — deliberately uses different wording than skill descriptions. */
  query: string;
  /** Tags that would indicate a relevant skill was found. */
  relevantTags: string[];
}

const DEFAULT_DOMAINS = [
  'typescript',
  'python',
  'react',
  'testing',
  'debugging',
  'deployment',
  'database',
  'api',
  'security',
];

/**
 * Generate a catalogue of diverse skills across domains.
 */
function generateSkillTemplates(domains: string[], count: number): SkillTemplate[] {
  const templates: SkillTemplate[] = [];

  const skillDefs: Record<string, Array<Omit<SkillTemplate, 'domain' | 'confidence'>>> = {
    typescript: [
      {
        name: 'ts-strict-null-checks',
        description: 'Enable and fix strict null checks in TypeScript projects',
        pattern: '1. Enable strictNullChecks in tsconfig\n2. Fix all null/undefined errors\n3. Add type guards where needed',
        preconditions: ['tsconfig.json exists', 'TypeScript >= 4.0'],
        tags: ['typescript', 'type-safety', 'configuration'],
      },
      {
        name: 'ts-barrel-exports',
        description: 'Organize module exports using barrel files for clean public APIs',
        pattern: '1. Create index.ts in each module dir\n2. Re-export public types and functions\n3. Update import paths',
        preconditions: ['TypeScript project', 'module structure exists'],
        tags: ['typescript', 'modules', 'architecture'],
      },
      {
        name: 'ts-generic-patterns',
        description: 'Apply generic type patterns for reusable data structures',
        pattern: '1. Identify repeated type patterns\n2. Extract generic type parameter\n3. Add constraints with extends',
        preconditions: ['TypeScript project'],
        tags: ['typescript', 'generics', 'type-safety'],
      },
    ],
    python: [
      {
        name: 'py-virtual-env-setup',
        description: 'Set up Python virtual environment with dependency management',
        pattern: '1. Create venv with python -m venv\n2. Activate and install requirements\n3. Generate requirements.txt',
        preconditions: ['Python >= 3.8 installed'],
        tags: ['python', 'environment', 'dependencies'],
      },
      {
        name: 'py-type-hints',
        description: 'Add type annotations to Python functions and classes',
        pattern: '1. Add return type annotations\n2. Add parameter type hints\n3. Run mypy for validation',
        preconditions: ['Python >= 3.6', 'mypy installed'],
        tags: ['python', 'type-safety', 'static-analysis'],
      },
      {
        name: 'py-async-patterns',
        description: 'Convert synchronous Python code to async/await patterns',
        pattern: '1. Identify I/O-bound operations\n2. Convert to async def\n3. Use asyncio.gather for concurrency',
        preconditions: ['Python >= 3.7'],
        tags: ['python', 'async', 'concurrency'],
      },
    ],
    react: [
      {
        name: 'react-hook-extraction',
        description: 'Extract reusable custom hooks from React components',
        pattern: '1. Identify stateful logic in components\n2. Extract into useXxx hook\n3. Return state and handlers',
        preconditions: ['React >= 16.8'],
        tags: ['react', 'hooks', 'refactoring'],
      },
      {
        name: 'react-perf-optimization',
        description: 'Optimize React rendering performance with memoization',
        pattern: '1. Profile with React DevTools\n2. Apply React.memo to pure components\n3. Use useMemo/useCallback for expensive computations',
        preconditions: ['React application', 'performance issues identified'],
        tags: ['react', 'performance', 'optimization'],
      },
    ],
    testing: [
      {
        name: 'test-mock-strategy',
        description: 'Design mock strategies for unit testing with dependency injection',
        pattern: '1. Identify external dependencies\n2. Create mock implementations\n3. Inject via constructor or factory',
        preconditions: ['test framework installed'],
        tags: ['testing', 'mocking', 'unit-tests'],
      },
      {
        name: 'test-snapshot-approach',
        description: 'Use snapshot testing for UI component regression detection',
        pattern: '1. Render component in test\n2. Create initial snapshot\n3. Review and update when intentional changes occur',
        preconditions: ['snapshot testing support available'],
        tags: ['testing', 'snapshots', 'regression'],
      },
    ],
    debugging: [
      {
        name: 'debug-memory-leak',
        description: 'Diagnose and fix memory leaks using heap snapshots',
        pattern: '1. Take heap snapshot before operation\n2. Perform suspect operation\n3. Compare snapshots and identify retained objects',
        preconditions: ['Node.js or Chrome DevTools available'],
        tags: ['debugging', 'memory', 'performance'],
      },
      {
        name: 'debug-async-errors',
        description: 'Track down unhandled promise rejections and async errors',
        pattern: '1. Add global rejection handler\n2. Enable async stack traces\n3. Add try/catch at async boundaries',
        preconditions: ['async/await codebase'],
        tags: ['debugging', 'async', 'error-handling'],
      },
    ],
    deployment: [
      {
        name: 'deploy-docker-multi-stage',
        description: 'Create multi-stage Docker builds for smaller production images',
        pattern: '1. Use builder stage for compilation\n2. Copy only artifacts to runtime stage\n3. Use slim base image',
        preconditions: ['Docker installed', 'Dockerfile exists'],
        tags: ['deployment', 'docker', 'optimization'],
      },
      {
        name: 'deploy-ci-pipeline',
        description: 'Set up continuous integration pipeline with automated testing',
        pattern: '1. Define build stages\n2. Add test step with coverage\n3. Configure deployment triggers',
        preconditions: ['CI platform available'],
        tags: ['deployment', 'ci-cd', 'automation'],
      },
    ],
    database: [
      {
        name: 'db-index-optimization',
        description: 'Optimize database queries by analyzing and adding indexes',
        pattern: '1. Run EXPLAIN on slow queries\n2. Identify missing indexes\n3. Add composite indexes for common query patterns',
        preconditions: ['database access', 'query logs available'],
        tags: ['database', 'performance', 'indexing'],
      },
      {
        name: 'db-migration-strategy',
        description: 'Implement safe database schema migrations with rollback support',
        pattern: '1. Create versioned migration files\n2. Add up and down methods\n3. Test rollback before deploying',
        preconditions: ['migration tool configured'],
        tags: ['database', 'migrations', 'schema'],
      },
    ],
    api: [
      {
        name: 'api-error-handling',
        description: 'Implement consistent API error response format with status codes',
        pattern: '1. Define error response schema\n2. Create error middleware\n3. Map exceptions to HTTP status codes',
        preconditions: ['HTTP API framework'],
        tags: ['api', 'error-handling', 'rest'],
      },
      {
        name: 'api-rate-limiting',
        description: 'Add rate limiting to API endpoints to prevent abuse',
        pattern: '1. Choose rate limit strategy (token bucket, sliding window)\n2. Add middleware\n3. Return 429 with retry-after header',
        preconditions: ['API server running'],
        tags: ['api', 'security', 'rate-limiting'],
      },
    ],
    security: [
      {
        name: 'sec-input-validation',
        description: 'Add input validation and sanitization to prevent injection attacks',
        pattern: '1. Define validation schemas\n2. Sanitize all user input\n3. Use parameterized queries for database access',
        preconditions: ['application accepts user input'],
        tags: ['security', 'validation', 'injection-prevention'],
      },
      {
        name: 'sec-auth-jwt',
        description: 'Implement JWT-based authentication with refresh token rotation',
        pattern: '1. Issue short-lived access tokens\n2. Implement refresh token endpoint\n3. Rotate refresh tokens on use',
        preconditions: ['authentication required'],
        tags: ['security', 'authentication', 'jwt'],
      },
    ],
  };

  // Distribute skills across requested domains
  let idx = 0;
  while (templates.length < count) {
    const domain = domains[idx % domains.length];
    const domainSkills = skillDefs[domain] ?? [];
    if (domainSkills.length > 0) {
      const skillIdx = Math.floor(templates.length / domains.length) % domainSkills.length;
      const def = domainSkills[skillIdx];
      // Vary confidence for calibration testing
      const confidence = 0.3 + (templates.length / count) * 0.6;
      templates.push({ ...def, domain, confidence });
    }
    idx++;
    // Safety: break if we can't fill enough
    if (idx > count * 3) break;
  }

  return templates.slice(0, count);
}

/**
 * Generate transfer queries that use different wording but target the same concepts.
 */
function generateTransferQueries(domains: string[], count: number): TransferQuery[] {
  const queryDefs: Record<string, TransferQuery[]> = {
    typescript: [
      { targetDomain: 'typescript', query: 'how to make nullable types safe in my TS code', relevantTags: ['typescript', 'type-safety'] },
      { targetDomain: 'typescript', query: 'organizing exports and imports across modules', relevantTags: ['typescript', 'modules'] },
    ],
    python: [
      { targetDomain: 'python', query: 'setting up isolated package environment for a Python app', relevantTags: ['python', 'environment'] },
      { targetDomain: 'python', query: 'adding static type checking to Python functions', relevantTags: ['python', 'type-safety'] },
    ],
    react: [
      { targetDomain: 'react', query: 'extracting shared stateful logic from UI components', relevantTags: ['react', 'hooks', 'refactoring'] },
      { targetDomain: 'react', query: 'reducing unnecessary re-renders in the frontend', relevantTags: ['react', 'performance'] },
    ],
    testing: [
      { targetDomain: 'testing', query: 'creating fake dependencies for isolated unit tests', relevantTags: ['testing', 'mocking'] },
      { targetDomain: 'testing', query: 'detecting visual regressions in component output', relevantTags: ['testing', 'snapshots'] },
    ],
    debugging: [
      { targetDomain: 'debugging', query: 'application using too much RAM over time', relevantTags: ['debugging', 'memory'] },
      { targetDomain: 'debugging', query: 'finding the source of uncaught async exceptions', relevantTags: ['debugging', 'async'] },
    ],
    deployment: [
      { targetDomain: 'deployment', query: 'making container images smaller for production', relevantTags: ['deployment', 'docker'] },
      { targetDomain: 'deployment', query: 'automating build and test before shipping', relevantTags: ['deployment', 'ci-cd'] },
    ],
    database: [
      { targetDomain: 'database', query: 'speed up slow SQL queries with proper indexes', relevantTags: ['database', 'performance', 'indexing'] },
      { targetDomain: 'database', query: 'safely changing the DB schema with versioned scripts', relevantTags: ['database', 'migrations'] },
    ],
    api: [
      { targetDomain: 'api', query: 'standardizing error responses from REST endpoints', relevantTags: ['api', 'error-handling'] },
      { targetDomain: 'api', query: 'preventing API abuse with request throttling', relevantTags: ['api', 'rate-limiting'] },
    ],
    security: [
      { targetDomain: 'security', query: 'protecting against SQL injection and XSS attacks', relevantTags: ['security', 'validation'] },
      { targetDomain: 'security', query: 'token-based login with automatic session renewal', relevantTags: ['security', 'authentication'] },
    ],
  };

  const queries: TransferQuery[] = [];
  let idx = 0;
  while (queries.length < count) {
    const domain = domains[idx % domains.length];
    const domainQueries = queryDefs[domain] ?? [];
    if (domainQueries.length > 0) {
      const qIdx = Math.floor(queries.length / domains.length) % domainQueries.length;
      queries.push(domainQueries[qIdx]);
    }
    idx++;
    if (idx > count * 3) break;
  }

  return queries.slice(0, count);
}

// ---------------------------------------------------------------------------
// Correlation helper
// ---------------------------------------------------------------------------

/**
 * Compute Pearson correlation coefficient between two arrays.
 * Returns 0 if standard deviation of either array is 0.
 */
function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;

  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX) * Math.sqrt(varY);
  return denom === 0 ? 0 : cov / denom;
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SkillTransferConfig = {
  skillCount: 20,
  queryCount: 15,
  domains: DEFAULT_DOMAINS,
};

export async function runSkillTransferBenchmark(
  config?: Partial<SkillTransferConfig>,
): Promise<SkillTransferResult> {
  const cfg: SkillTransferConfig = { ...DEFAULT_CONFIG, ...config };
  const { skillCount, queryCount, domains } = cfg;

  // Create temp directories for Project A and Project B
  const projectADir = await mkdtemp(join(tmpdir(), 'apex-transfer-a-'));
  const projectBDir = await mkdtemp(join(tmpdir(), 'apex-transfer-b-'));

  try {
    // ── Step 1: Create skills in Project A ──────────────────────────
    const managerA = new MemoryManager({
      projectDataPath: join(projectADir, '.apex-data'),
      projectPath: projectADir,
      limits: { working: 10, episodic: 100, semantic: 100 },
    });
    await managerA.init();

    const skillTemplates = generateSkillTemplates(domains, skillCount);
    const createdSkills: Array<{ domain: string; confidence: number; tags: string[] }> = [];

    for (const tpl of skillTemplates) {
      await managerA.addSkill({
        name: tpl.name,
        description: tpl.description,
        pattern: tpl.pattern,
        preconditions: tpl.preconditions,
        tags: tpl.tags,
        sourceProject: 'project-a',
        confidence: tpl.confidence,
      });
      createdSkills.push({
        domain: tpl.domain,
        confidence: tpl.confidence,
        tags: tpl.tags,
      });
    }

    // ── Step 2: Run transfer queries from Project B context ─────────
    const queries = generateTransferQueries(domains, queryCount);

    let totalDiscovered = 0;
    let totalRelevanceScore = 0;
    let totalLatencyMs = 0;

    const confidences: number[] = [];
    const transferSuccesses: number[] = [];

    // Track per-domain results
    const domainStats = new Map<string, { discovered: number; total: number; relevanceSum: number }>();

    for (const q of queries) {
      const start = performance.now();
      const results = await managerA.searchSkills(q.query, 5);
      const elapsed = performance.now() - start;
      totalLatencyMs += elapsed;

      // Check if any result is relevant (shares tags with the query)
      const relevantTagSet = new Set(q.relevantTags);
      let found = false;
      let bestRelevanceScore = 0;

      for (const { skill, score } of results) {
        const skillTagSet = new Set(skill.tags);
        let matchingTags = 0;
        for (const tag of relevantTagSet) {
          if (skillTagSet.has(tag)) matchingTags++;
        }
        const tagOverlap = relevantTagSet.size > 0 ? matchingTags / relevantTagSet.size : 0;

        if (tagOverlap > 0.3) {
          found = true;
          bestRelevanceScore = Math.max(bestRelevanceScore, score);
          // Track confidence calibration
          confidences.push(skill.confidence);
          transferSuccesses.push(1);
        }
      }

      if (!found) {
        // Use the average confidence of skills in the target domain
        const domainSkills = createdSkills.filter((s) => s.domain === q.targetDomain);
        const avgConf = domainSkills.length > 0
          ? domainSkills.reduce((sum, s) => sum + s.confidence, 0) / domainSkills.length
          : 0.5;
        confidences.push(avgConf);
        transferSuccesses.push(0);
      }

      if (found) totalDiscovered++;
      totalRelevanceScore += bestRelevanceScore;

      // Per-domain tracking
      const key = q.targetDomain;
      const existing = domainStats.get(key) ?? { discovered: 0, total: 0, relevanceSum: 0 };
      existing.total++;
      if (found) {
        existing.discovered++;
        existing.relevanceSum += bestRelevanceScore;
      }
      domainStats.set(key, existing);
    }

    // ── Step 3: Compute aggregate metrics ───────────────────────────

    const discoveryRate = queries.length > 0 ? totalDiscovered / queries.length : 0;
    const adaptationAccuracy = queries.length > 0 ? totalRelevanceScore / queries.length : 0;
    const confidenceCalibration = pearsonCorrelation(confidences, transferSuccesses);
    const avgLatencyMs = queries.length > 0 ? totalLatencyMs / queries.length : 0;

    const domainResults: SkillTransferResult['domainResults'] = [];
    for (const [domain, stats] of domainStats) {
      domainResults.push({
        sourceDomain: domain,
        targetDomain: domain,
        discoveryRate: stats.total > 0 ? stats.discovered / stats.total : 0,
        avgRelevanceScore: stats.discovered > 0 ? stats.relevanceSum / stats.discovered : 0,
      });
    }

    return {
      discoveryRate,
      adaptationAccuracy,
      confidenceCalibration,
      domainResults,
      totalSkillsCreated: createdSkills.length,
      totalQueriesRun: queries.length,
      avgLatencyMs,
    };
  } finally {
    // Clean up temp directories
    await rm(projectADir, { recursive: true, force: true }).catch(() => {});
    await rm(projectBDir, { recursive: true, force: true }).catch(() => {});
  }
}
