/**
 * A/B Testing Framework (Phase 14)
 *
 * DSPy-inspired prompt auto-optimization system. Evaluates prompt variants
 * using chi-squared statistical testing to determine which performs better.
 *
 * Pure statistical/algorithmic computation — no LLM calls.
 */

import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ABMetrics {
  exposures: number;
  successes: number;
  failures: number;
  totalReward: number;
  avgReward: number;
  successRate: number;
}

export interface ABExperiment {
  id: string;
  name: string;
  description: string;
  controlContent: string;
  treatmentContent: string;
  status: 'running' | 'concluded' | 'rolled-back';
  winner: 'control' | 'treatment' | null;
  controlMetrics: ABMetrics;
  treatmentMetrics: ABMetrics;
  minSampleSize: number;
  significanceLevel: number;
  createdAt: string;
  concludedAt: string | null;
}

export interface ABTestResult {
  experimentId: string;
  chiSquared: number;
  pValue: number;
  significant: boolean;
  winner: 'control' | 'treatment' | 'no-difference';
  controlRate: number;
  treatmentRate: number;
  liftPercent: number;
  sampleSizeSufficient: boolean;
}

export interface ABManagerOptions {
  fileStore: FileStore;
  logger?: Logger;
  defaultMinSampleSize?: number;
  defaultSignificanceLevel?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'ab-experiments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyMetrics(): ABMetrics {
  return {
    exposures: 0,
    successes: 0,
    failures: 0,
    totalReward: 0,
    avgReward: 0,
    successRate: 0,
  };
}

/**
 * Chi-squared lookup for 1 degree of freedom.
 * Returns an approximate p-value bucket.
 */
function chiSquaredPValue(chiSq: number): number {
  if (chiSq >= 10.828) return 0.001;
  if (chiSq >= 6.635) return 0.01;
  if (chiSq >= 3.841) return 0.05;
  return 1.0;
}

/**
 * Compute chi-squared statistic for a 2x2 contingency table.
 *
 *              success   failure
 *   control  [  a    ,    b   ]
 *   treatment[  c    ,    d   ]
 */
function computeChiSquared(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  if (n === 0) return 0;

  const table = [
    [a, b],
    [c, d],
  ];
  const rowTotals = [a + b, c + d];
  const colTotals = [a + c, b + d];

  let chiSq = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const expected = (rowTotals[i] * colTotals[j]) / n;
      if (expected === 0) continue;
      const diff = table[i][j] - expected;
      chiSq += (diff * diff) / expected;
    }
  }
  return chiSq;
}

// ---------------------------------------------------------------------------
// ABTestManager
// ---------------------------------------------------------------------------

export class ABTestManager {
  private readonly store: FileStore;
  private readonly logger: Logger;
  private readonly defaultMinSampleSize: number;
  private readonly defaultSignificanceLevel: number;
  private experiments: Map<string, ABExperiment> = new Map();

  constructor(opts: ABManagerOptions) {
    this.store = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:ab-testing' });
    this.defaultMinSampleSize = opts.defaultMinSampleSize ?? 30;
    this.defaultSignificanceLevel = opts.defaultSignificanceLevel ?? 0.05;
  }

  /** Load persisted experiments from FileStore into memory. */
  async init(): Promise<void> {
    const stored = await this.store.readAll<ABExperiment>(COLLECTION);
    for (const exp of stored) {
      this.experiments.set(exp.name, exp);
    }
    this.logger.info('AB test manager initialised', {
      experimentsLoaded: stored.length,
    });
  }

  /** Create a new A/B experiment and persist it. */
  async createExperiment(input: {
    name: string;
    description: string;
    controlContent: string;
    treatmentContent: string;
    minSampleSize?: number;
    significanceLevel?: number;
  }): Promise<ABExperiment> {
    const id = `ab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const experiment: ABExperiment = {
      id,
      name: input.name,
      description: input.description,
      controlContent: input.controlContent,
      treatmentContent: input.treatmentContent,
      status: 'running',
      winner: null,
      controlMetrics: emptyMetrics(),
      treatmentMetrics: emptyMetrics(),
      minSampleSize: input.minSampleSize ?? this.defaultMinSampleSize,
      significanceLevel: input.significanceLevel ?? this.defaultSignificanceLevel,
      createdAt: new Date().toISOString(),
      concludedAt: null,
    };

    this.experiments.set(experiment.name, experiment);
    await this.store.write(COLLECTION, experiment.id, experiment);
    this.logger.info('Experiment created', { id, name: input.name });
    return experiment;
  }

  /** Get an experiment by name. Returns null if not found. */
  getExperiment(name: string): ABExperiment | null {
    return this.experiments.get(name) ?? null;
  }

  /** List experiments, optionally filtered by status. */
  listExperiments(filter?: { status?: ABExperiment['status'] }): ABExperiment[] {
    const all = Array.from(this.experiments.values());
    if (filter?.status) {
      return all.filter((e) => e.status === filter.status);
    }
    return all;
  }

  /**
   * Get a random variant for the given experiment.
   * Returns null if the experiment is not found or not running.
   */
  getVariant(experimentName: string): { content: string; group: 'control' | 'treatment' } | null {
    const exp = this.experiments.get(experimentName);
    if (!exp || exp.status !== 'running') return null;

    const group: 'control' | 'treatment' = Math.random() < 0.5 ? 'control' : 'treatment';
    const content = group === 'control' ? exp.controlContent : exp.treatmentContent;
    return { content, group };
  }

  /** Record an outcome for a specific group of an experiment. */
  async recordOutcome(
    experimentName: string,
    group: 'control' | 'treatment',
    success: boolean,
    reward?: number,
  ): Promise<void> {
    const exp = this.experiments.get(experimentName);
    if (!exp || exp.status !== 'running') return;

    const metrics = group === 'control' ? exp.controlMetrics : exp.treatmentMetrics;
    metrics.exposures += 1;
    if (success) {
      metrics.successes += 1;
    } else {
      metrics.failures += 1;
    }
    metrics.totalReward += reward ?? (success ? 1 : 0);
    metrics.avgReward = metrics.totalReward / metrics.exposures;
    metrics.successRate = metrics.successes / metrics.exposures;

    await this.store.write(COLLECTION, exp.id, exp);
  }

  /** Evaluate an experiment using chi-squared test. Returns null if not found. */
  evaluateExperiment(experimentName: string): ABTestResult | null {
    const exp = this.experiments.get(experimentName);
    if (!exp) return null;

    const cm = exp.controlMetrics;
    const tm = exp.treatmentMetrics;

    const totalExposures = cm.exposures + tm.exposures;
    const sampleSizeSufficient = totalExposures >= exp.minSampleSize;

    const chiSquared = computeChiSquared(
      cm.successes,
      cm.failures,
      tm.successes,
      tm.failures,
    );

    const pValue = chiSquaredPValue(chiSquared);
    const significant = pValue <= exp.significanceLevel;

    const controlRate = cm.exposures > 0 ? cm.successRate : 0;
    const treatmentRate = tm.exposures > 0 ? tm.successRate : 0;

    let winner: 'control' | 'treatment' | 'no-difference' = 'no-difference';
    if (significant) {
      winner = treatmentRate > controlRate ? 'treatment' : 'control';
    }

    const liftPercent = controlRate > 0
      ? ((treatmentRate - controlRate) / controlRate) * 100
      : 0;

    return {
      experimentId: exp.id,
      chiSquared,
      pValue,
      significant,
      winner,
      controlRate,
      treatmentRate,
      liftPercent,
      sampleSizeSufficient,
    };
  }

  /**
   * Conclude an experiment: check sample size, run chi-squared, and declare
   * a winner if statistically significant.
   */
  async concludeExperiment(experimentName: string): Promise<ABTestResult | null> {
    const exp = this.experiments.get(experimentName);
    if (!exp || exp.status !== 'running') return null;

    const result = this.evaluateExperiment(experimentName);
    if (!result) return null;

    if (result.sampleSizeSufficient && result.significant) {
      exp.winner = result.winner === 'no-difference' ? null : result.winner;
    }

    exp.status = 'concluded';
    exp.concludedAt = new Date().toISOString();
    await this.store.write(COLLECTION, exp.id, exp);
    this.logger.info('Experiment concluded', {
      name: experimentName,
      winner: exp.winner,
      significant: result.significant,
    });
    return result;
  }

  /**
   * Auto-evaluate all running experiments. Concludes those that have
   * sufficient sample size and statistical significance.
   */
  async autoEvaluate(): Promise<ABTestResult[]> {
    const results: ABTestResult[] = [];
    const running = this.listExperiments({ status: 'running' });

    for (const exp of running) {
      const result = this.evaluateExperiment(exp.name);
      if (!result) continue;

      if (result.sampleSizeSufficient && result.significant) {
        const concluded = await this.concludeExperiment(exp.name);
        if (concluded) results.push(concluded);
      }
    }

    return results;
  }

  /** Roll back an experiment to running state (undo conclusion). */
  async rollbackExperiment(experimentName: string): Promise<void> {
    const exp = this.experiments.get(experimentName);
    if (!exp) return;

    exp.status = 'rolled-back';
    exp.winner = null;
    exp.concludedAt = null;
    await this.store.write(COLLECTION, exp.id, exp);
    this.logger.info('Experiment rolled back', { name: experimentName });
  }

  /** Get a summary report of all experiments. */
  getReport(): {
    running: number;
    concluded: number;
    rolledBack: number;
    experiments: ABExperiment[];
  } {
    const all = Array.from(this.experiments.values());
    return {
      running: all.filter((e) => e.status === 'running').length,
      concluded: all.filter((e) => e.status === 'concluded').length,
      rolledBack: all.filter((e) => e.status === 'rolled-back').length,
      experiments: all,
    };
  }

  /** Persist all experiments to FileStore. */
  async persist(): Promise<void> {
    for (const exp of this.experiments.values()) {
      await this.store.write(COLLECTION, exp.id, exp);
    }
    this.logger.info('All experiments persisted', {
      count: this.experiments.size,
    });
  }
}
