/**
 * Performance Regression Detection for APEX Evolution Engine (Phase 14)
 *
 * Detects when prompt changes degrade performance and supports automatic
 * rollback. Tracks performance snapshots per module, computes baselines,
 * checks for regressions against configurable thresholds, and provides
 * learning curve data for trend analysis.
 *
 * Pure statistical/algorithmic — no LLM calls.
 */

import { generateId } from '../types.js';
import { Logger } from '../utils/logger.js';
import { FileStore } from '../utils/file-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PerformanceMetrics {
  successRate: number;       // 0-1
  avgReward: number;         // 0-1
  recallHitRate: number;     // 0-1
  avgLatency: number;        // ms
  sampleSize: number;
}

export interface PerformanceSnapshot {
  id: string;
  moduleName: string;
  metrics: PerformanceMetrics;
  changeDescription: string;
  timestamp: string;
}

export interface RegressionAlert {
  id: string;
  moduleName: string;
  metric: keyof PerformanceMetrics;
  baselineValue: number;
  currentValue: number;
  degradationPercent: number;
  severity: 'warning' | 'critical';
  autoRollbackTriggered: boolean;
  timestamp: string;
}

export interface LearningCurvePoint {
  timestamp: string;
  moduleName: string;
  successRate: number;
  avgReward: number;
  changeDescription: string;
}

export interface RegressionDetectorOptions {
  fileStore: FileStore;
  logger?: Logger;
  warningThreshold?: number;       // Default: 0.05
  criticalThreshold?: number;      // Default: 0.15
  minSamplesForDetection?: number; // Default: 10
  maxSnapshotsPerModule?: number;  // Default: 50
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOTS_COLLECTION = 'perf-snapshots';
const ALERTS_COLLECTION = 'regression-alerts';

const COMPOSITE_WEIGHTS = {
  successRate: 0.5,
  avgReward: 0.3,
  recallHitRate: 0.2,
} as const;

const CHECKED_METRICS: readonly (keyof PerformanceMetrics)[] = [
  'successRate',
  'avgReward',
  'recallHitRate',
  'avgLatency',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compositeScore(metrics: PerformanceMetrics): number {
  return (
    metrics.successRate * COMPOSITE_WEIGHTS.successRate +
    metrics.avgReward * COMPOSITE_WEIGHTS.avgReward +
    metrics.recallHitRate * COMPOSITE_WEIGHTS.recallHitRate
  );
}

/**
 * Simple linear regression slope for an array of y-values with implicit
 * x = 0, 1, 2, ...
 */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

// ---------------------------------------------------------------------------
// RegressionDetector
// ---------------------------------------------------------------------------

export class RegressionDetector {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;
  private readonly minSamplesForDetection: number;
  private readonly maxSnapshotsPerModule: number;

  private snapshots: Map<string, PerformanceSnapshot[]> = new Map();
  private alerts: RegressionAlert[] = [];
  private rollbackCount = 0;

  constructor(opts: RegressionDetectorOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:regression-detector' });
    this.warningThreshold = opts.warningThreshold ?? 0.05;
    this.criticalThreshold = opts.criticalThreshold ?? 0.15;
    this.minSamplesForDetection = opts.minSamplesForDetection ?? 10;
    this.maxSnapshotsPerModule = opts.maxSnapshotsPerModule ?? 50;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async init(): Promise<void> {
    const storedSnapshots = await this.fileStore.read<PerformanceSnapshot[]>(
      SNAPSHOTS_COLLECTION,
      'all-snapshots',
    );
    if (storedSnapshots) {
      this.snapshots = new Map();
      for (const snap of storedSnapshots) {
        const list = this.snapshots.get(snap.moduleName) ?? [];
        list.push(snap);
        this.snapshots.set(snap.moduleName, list);
      }
    }

    const storedAlerts = await this.fileStore.read<RegressionAlert[]>(
      ALERTS_COLLECTION,
      'all-alerts',
    );
    if (storedAlerts) {
      this.alerts = storedAlerts;
    }

    const meta = await this.fileStore.read<{ rollbackCount: number }>(
      ALERTS_COLLECTION,
      'meta',
    );
    if (meta) {
      this.rollbackCount = meta.rollbackCount;
    }

    this.logger.debug('RegressionDetector initialized', {
      modules: this.snapshots.size,
      alerts: this.alerts.length,
    });
  }

  async persist(): Promise<void> {
    const allSnapshots: PerformanceSnapshot[] = [];
    for (const list of this.snapshots.values()) {
      allSnapshots.push(...list);
    }
    await this.fileStore.write(SNAPSHOTS_COLLECTION, 'all-snapshots', allSnapshots);
    await this.fileStore.write(ALERTS_COLLECTION, 'all-alerts', this.alerts);
    await this.fileStore.write(ALERTS_COLLECTION, 'meta', {
      rollbackCount: this.rollbackCount,
    });
  }

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  async recordSnapshot(input: {
    moduleName: string;
    metrics: PerformanceMetrics;
    changeDescription: string;
  }): Promise<PerformanceSnapshot> {
    const snapshot: PerformanceSnapshot = {
      id: generateId(),
      moduleName: input.moduleName,
      metrics: { ...input.metrics },
      changeDescription: input.changeDescription,
      timestamp: new Date().toISOString(),
    };

    const list = this.snapshots.get(input.moduleName) ?? [];
    list.push(snapshot);

    // Evict oldest if over limit, but keep baseline
    if (list.length > this.maxSnapshotsPerModule) {
      const baseline = this.findBaseline(list);
      const baselineId = baseline?.id;
      // Remove oldest that is NOT the baseline
      const idx = list.findIndex((s) => s.id !== baselineId);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }

    this.snapshots.set(input.moduleName, list);
    await this.persist();

    this.logger.info('Recorded performance snapshot', {
      moduleName: input.moduleName,
      compositeScore: compositeScore(input.metrics),
    });

    return snapshot;
  }

  getBaseline(moduleName: string): PerformanceSnapshot | null {
    const list = this.snapshots.get(moduleName);
    if (!list || list.length === 0) return null;
    return this.findBaseline(list);
  }

  private findBaseline(snapshots: PerformanceSnapshot[]): PerformanceSnapshot {
    let best = snapshots[0];
    let bestScore = compositeScore(best.metrics);
    for (let i = 1; i < snapshots.length; i++) {
      const score = compositeScore(snapshots[i].metrics);
      if (score > bestScore) {
        best = snapshots[i];
        bestScore = score;
      }
    }
    return best;
  }

  // -----------------------------------------------------------------------
  // Regression detection
  // -----------------------------------------------------------------------

  checkForRegression(
    moduleName: string,
    currentMetrics: PerformanceMetrics,
  ): RegressionAlert[] {
    const baseline = this.getBaseline(moduleName);
    if (!baseline) return [];

    if (currentMetrics.sampleSize < this.minSamplesForDetection) return [];

    const newAlerts: RegressionAlert[] = [];

    for (const metric of CHECKED_METRICS) {
      const baselineValue = baseline.metrics[metric];
      const currentValue = currentMetrics[metric];

      // For latency, higher is worse — invert the comparison
      let degradation: number;
      if (metric === 'avgLatency') {
        degradation =
          (currentValue - baselineValue) / Math.max(baselineValue, 0.01) * 100;
      } else {
        degradation =
          (baselineValue - currentValue) / Math.max(baselineValue, 0.01) * 100;
      }

      if (degradation <= 0) continue;

      let severity: 'warning' | 'critical' | null = null;
      if (degradation > this.criticalThreshold * 100) {
        severity = 'critical';
      } else if (degradation > this.warningThreshold * 100) {
        severity = 'warning';
      }

      if (severity) {
        const alert: RegressionAlert = {
          id: generateId(),
          moduleName,
          metric,
          baselineValue,
          currentValue,
          degradationPercent: degradation,
          severity,
          autoRollbackTriggered: false,
          timestamp: new Date().toISOString(),
        };
        newAlerts.push(alert);
        this.alerts.push(alert);
      }
    }

    if (newAlerts.length > 0) {
      this.logger.warn('Regression detected', {
        moduleName,
        alertCount: newAlerts.length,
        severities: newAlerts.map((a) => a.severity),
      });
    }

    return newAlerts;
  }

  // -----------------------------------------------------------------------
  // Alerts
  // -----------------------------------------------------------------------

  getAlerts(filter?: { moduleName?: string; severity?: 'warning' | 'critical' }): RegressionAlert[] {
    let result = this.alerts;
    if (filter?.moduleName) {
      result = result.filter((a) => a.moduleName === filter.moduleName);
    }
    if (filter?.severity) {
      result = result.filter((a) => a.severity === filter.severity);
    }
    return result;
  }

  async clearAlerts(moduleName: string): Promise<void> {
    this.alerts = this.alerts.filter((a) => a.moduleName !== moduleName);
    await this.persist();
  }

  // -----------------------------------------------------------------------
  // Learning curve
  // -----------------------------------------------------------------------

  getLearningCurve(moduleName: string): LearningCurvePoint[] {
    const list = this.snapshots.get(moduleName);
    if (!list) return [];
    return list.map((snap) => ({
      timestamp: snap.timestamp,
      moduleName: snap.moduleName,
      successRate: snap.metrics.successRate,
      avgReward: snap.metrics.avgReward,
      changeDescription: snap.changeDescription,
    }));
  }

  getAllLearningCurves(): Record<string, LearningCurvePoint[]> {
    const result: Record<string, LearningCurvePoint[]> = {};
    for (const moduleName of this.snapshots.keys()) {
      result[moduleName] = this.getLearningCurve(moduleName);
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Rollback
  // -----------------------------------------------------------------------

  shouldRollback(
    moduleName: string,
    currentMetrics: PerformanceMetrics,
  ): { rollback: boolean; reason: string; rollbackTo: PerformanceSnapshot | null } {
    const baseline = this.getBaseline(moduleName);
    if (!baseline) {
      return { rollback: false, reason: 'No baseline available', rollbackTo: null };
    }

    if (currentMetrics.sampleSize < this.minSamplesForDetection) {
      return { rollback: false, reason: 'Insufficient samples for detection', rollbackTo: null };
    }

    const alerts = this.checkForRegression(moduleName, currentMetrics);
    const hasCritical = alerts.some((a) => a.severity === 'critical');

    if (hasCritical) {
      return {
        rollback: true,
        reason: `Critical regression detected in ${alerts
          .filter((a) => a.severity === 'critical')
          .map((a) => a.metric)
          .join(', ')}`,
        rollbackTo: baseline,
      };
    }

    return { rollback: false, reason: 'No critical regression detected', rollbackTo: null };
  }

  async recordRollback(moduleName: string, rolledBackTo: PerformanceSnapshot): Promise<void> {
    this.rollbackCount++;

    // Mark relevant alerts as having triggered rollback
    for (const alert of this.alerts) {
      if (alert.moduleName === moduleName && !alert.autoRollbackTriggered) {
        alert.autoRollbackTriggered = true;
      }
    }

    this.logger.warn('Rollback recorded', {
      moduleName,
      rolledBackToId: rolledBackTo.id,
      totalRollbacks: this.rollbackCount,
    });

    await this.persist();
  }

  // -----------------------------------------------------------------------
  // Trend analysis
  // -----------------------------------------------------------------------

  computeTrend(moduleName: string): 'improving' | 'stable' | 'degrading' {
    const list = this.snapshots.get(moduleName);
    if (!list || list.length < 2) return 'stable';

    const recent = list.slice(-5);
    const scores = recent.map((s) => compositeScore(s.metrics));
    const slope = linearSlope(scores);

    if (slope > 0.02) return 'improving';
    if (slope < -0.02) return 'degrading';
    return 'stable';
  }

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------

  getReport(): {
    totalModules: number;
    modulesWithRegression: number;
    totalAlerts: number;
    criticalAlerts: number;
    rollbacksPerformed: number;
    modules: Array<{
      name: string;
      currentScore: number;
      baselineScore: number;
      trend: 'improving' | 'stable' | 'degrading';
      snapshotCount: number;
    }>;
  } {
    const moduleNames = Array.from(this.snapshots.keys());
    const modulesWithRegression = new Set(
      this.alerts.map((a) => a.moduleName),
    ).size;

    const modules = moduleNames.map((name) => {
      const list = this.snapshots.get(name)!;
      const latest = list[list.length - 1];
      const baseline = this.findBaseline(list);
      return {
        name,
        currentScore: compositeScore(latest.metrics),
        baselineScore: compositeScore(baseline.metrics),
        trend: this.computeTrend(name),
        snapshotCount: list.length,
      };
    });

    return {
      totalModules: moduleNames.length,
      modulesWithRegression,
      totalAlerts: this.alerts.length,
      criticalAlerts: this.alerts.filter((a) => a.severity === 'critical').length,
      rollbacksPerformed: this.rollbackCount,
      modules,
    };
  }
}
