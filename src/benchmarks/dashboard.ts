/**
 * APEX Benchmark Dashboard
 *
 * Generates an HTML report from benchmark results, provides CI gate
 * checking, and tracks benchmark history for trend visualisation.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Individual benchmark result entry for dashboard aggregation. */
export interface BenchmarkEntry {
  name: string;
  category: 'recall' | 'skill-transfer' | 'reflection' | 'consolidation' | 'latency';
  score: number;         // normalised 0-1
  passed: boolean;       // did it meet the gate threshold?
  threshold: number;     // the gate threshold
  details: Record<string, number>;  // metric breakdown
  timestamp: number;
  latencyMs?: number;
}

/** Full dashboard report data. */
export interface DashboardReport {
  generatedAt: number;
  entries: BenchmarkEntry[];
  summary: {
    totalBenchmarks: number;
    passed: number;
    failed: number;
    overallScore: number;  // weighted average
  };
  history: DashboardReport[];  // past reports for trend lines
}

/** CI gate configuration. */
export interface CIGateConfig {
  /** Recall must be below this threshold at 10K entries (default 100ms). */
  maxRecallLatencyMs: number;
  /** Embedding must complete within this threshold (default 50ms). */
  maxEmbeddingLatencyMs: number;
  /** Minimum overall benchmark score to pass (default 0.5). */
  minOverallScore: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CI_GATE_CONFIG: CIGateConfig = {
  maxRecallLatencyMs: 100,
  maxEmbeddingLatencyMs: 50,
  minOverallScore: 0.5,
};

const MAX_HISTORY_ENTRIES = 20;

// ---------------------------------------------------------------------------
// Category weights for overall score calculation
// ---------------------------------------------------------------------------

const CATEGORY_WEIGHTS: Record<BenchmarkEntry['category'], number> = {
  recall: 0.3,
  'skill-transfer': 0.2,
  reflection: 0.2,
  consolidation: 0.2,
  latency: 0.1,
};

// ---------------------------------------------------------------------------
// History management
// ---------------------------------------------------------------------------

/** Load benchmark history from disk. */
export async function loadHistory(historyPath: string): Promise<DashboardReport[]> {
  try {
    const raw = await readFile(historyPath, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data as DashboardReport[];
    }
    return [];
  } catch {
    return [];
  }
}

/** Save current results to history, keeping at most MAX_HISTORY_ENTRIES. */
export async function saveToHistory(
  report: DashboardReport,
  historyPath: string,
): Promise<void> {
  const existing = await loadHistory(historyPath);

  // Strip nested history from the report before storing
  const stripped: DashboardReport = {
    ...report,
    history: [],
  };

  existing.push(stripped);

  // Keep only the most recent entries
  const trimmed = existing.slice(-MAX_HISTORY_ENTRIES);

  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(trimmed, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// CI gate checking
// ---------------------------------------------------------------------------

/** Check if benchmarks pass CI gates. */
export function checkCIGates(
  entries: BenchmarkEntry[],
  config?: Partial<CIGateConfig>,
): { passed: boolean; failures: string[] } {
  const cfg: CIGateConfig = { ...DEFAULT_CI_GATE_CONFIG, ...config };
  const failures: string[] = [];

  // Check overall score
  const overallScore = computeOverallScore(entries);
  if (overallScore < cfg.minOverallScore) {
    failures.push(
      `Overall score ${overallScore.toFixed(3)} is below minimum ${cfg.minOverallScore}`,
    );
  }

  // Check recall latency entries
  for (const entry of entries) {
    if (entry.category === 'recall' && entry.latencyMs !== undefined) {
      if (entry.latencyMs > cfg.maxRecallLatencyMs) {
        failures.push(
          `Recall latency for "${entry.name}" is ${entry.latencyMs.toFixed(1)}ms, ` +
          `exceeds max ${cfg.maxRecallLatencyMs}ms`,
        );
      }
    }
    if (entry.category === 'latency' && entry.latencyMs !== undefined) {
      if (entry.latencyMs > cfg.maxEmbeddingLatencyMs) {
        failures.push(
          `Embedding latency for "${entry.name}" is ${entry.latencyMs.toFixed(1)}ms, ` +
          `exceeds max ${cfg.maxEmbeddingLatencyMs}ms`,
        );
      }
    }
  }

  // Check individual benchmark pass/fail
  for (const entry of entries) {
    if (!entry.passed) {
      failures.push(
        `Benchmark "${entry.name}" failed: score ${entry.score.toFixed(3)} < threshold ${entry.threshold}`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

function computeOverallScore(entries: BenchmarkEntry[]): number {
  if (entries.length === 0) return 0;

  // Group by category
  const categoryScores = new Map<string, number[]>();
  for (const entry of entries) {
    const existing = categoryScores.get(entry.category) ?? [];
    existing.push(entry.score);
    categoryScores.set(entry.category, existing);
  }

  // Weighted average across categories
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [category, scores] of categoryScores) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const weight = CATEGORY_WEIGHTS[category as BenchmarkEntry['category']] ?? 0.1;
    weightedSum += avgScore * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatScore(score: number): string {
  return (score * 100).toFixed(1) + '%';
}

function statusIcon(passed: boolean): string {
  return passed ? '&#10003;' : '&#10007;';
}

function statusClass(passed: boolean): string {
  return passed ? 'pass' : 'fail';
}

function generateSummarySection(report: DashboardReport): string {
  const { summary } = report;
  const overallClass = summary.overallScore >= 0.5 ? 'pass' : 'fail';

  return `
    <section class="summary">
      <h2>Summary</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-value">${summary.totalBenchmarks}</div>
          <div class="summary-label">Total Benchmarks</div>
        </div>
        <div class="summary-card pass">
          <div class="summary-value">${summary.passed}</div>
          <div class="summary-label">Passed</div>
        </div>
        <div class="summary-card ${summary.failed > 0 ? 'fail' : 'pass'}">
          <div class="summary-value">${summary.failed}</div>
          <div class="summary-label">Failed</div>
        </div>
        <div class="summary-card ${overallClass}">
          <div class="summary-value">${formatScore(summary.overallScore)}</div>
          <div class="summary-label">Overall Score</div>
        </div>
      </div>
    </section>`;
}

function generateBenchmarkTable(entries: BenchmarkEntry[]): string {
  const rows = entries.map((entry) => {
    const detailCells = Object.entries(entry.details)
      .map(([key, val]) => `<span class="detail-chip">${escapeHtml(key)}: ${val.toFixed(3)}</span>`)
      .join(' ');

    return `
      <tr class="${statusClass(entry.passed)}">
        <td class="status-cell">${statusIcon(entry.passed)}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(entry.category)}</td>
        <td>${formatScore(entry.score)}</td>
        <td>${formatScore(entry.threshold)}</td>
        <td>${entry.latencyMs !== undefined ? entry.latencyMs.toFixed(1) + 'ms' : '-'}</td>
        <td class="details-cell">${detailCells}</td>
      </tr>`;
  });

  return `
    <section class="benchmarks">
      <h2>Benchmark Details</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Category</th>
            <th>Score</th>
            <th>Threshold</th>
            <th>Latency</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join('\n')}
        </tbody>
      </table>
    </section>`;
}

function generateLatencyChart(entries: BenchmarkEntry[]): string {
  const latencyEntries = entries.filter((e) => e.latencyMs !== undefined);
  if (latencyEntries.length === 0) return '';

  const maxLatency = Math.max(...latencyEntries.map((e) => e.latencyMs!));
  const bars = latencyEntries.map((entry) => {
    const widthPct = maxLatency > 0 ? (entry.latencyMs! / maxLatency) * 100 : 0;
    const barClass = entry.passed ? 'bar-pass' : 'bar-fail';
    return `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(entry.name)}</div>
        <div class="bar-container">
          <div class="bar ${barClass}" style="width: ${widthPct.toFixed(1)}%">
            ${entry.latencyMs!.toFixed(1)}ms
          </div>
        </div>
      </div>`;
  });

  return `
    <section class="latency-chart">
      <h2>Latency</h2>
      ${bars.join('\n')}
    </section>`;
}

function generateHistorySection(history: DashboardReport[]): string {
  if (history.length === 0) return '';

  const maxScore = 1;
  const chartHeight = 200;
  const chartWidth = 600;
  const pointSpacing = history.length > 1
    ? chartWidth / (history.length - 1)
    : chartWidth;

  const points = history.map((report, i) => {
    const x = history.length > 1 ? i * pointSpacing : chartWidth / 2;
    const y = chartHeight - (report.summary.overallScore / maxScore) * chartHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = points.join(' ');
  const dots = history.map((report, i) => {
    const x = history.length > 1 ? i * pointSpacing : chartWidth / 2;
    const y = chartHeight - (report.summary.overallScore / maxScore) * chartHeight;
    const date = new Date(report.generatedAt).toLocaleDateString();
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="trend-dot">
      <title>${date}: ${formatScore(report.summary.overallScore)}</title>
    </circle>`;
  });

  // Threshold line at 50%
  const thresholdY = chartHeight - (0.5 / maxScore) * chartHeight;

  return `
    <section class="history">
      <h2>Score Trend</h2>
      <svg viewBox="-20 -10 ${chartWidth + 40} ${chartHeight + 30}" class="trend-chart">
        <line x1="0" y1="${thresholdY}" x2="${chartWidth}" y2="${thresholdY}"
              class="threshold-line" />
        <text x="${chartWidth + 5}" y="${thresholdY + 4}" class="threshold-label">50%</text>
        <polyline points="${polyline}" class="trend-line" />
        ${dots.join('\n')}
        <text x="0" y="${chartHeight + 18}" class="axis-label">
          ${history.length > 0 ? new Date(history[0].generatedAt).toLocaleDateString() : ''}
        </text>
        <text x="${chartWidth}" y="${chartHeight + 18}" class="axis-label" text-anchor="end">
          ${history.length > 0 ? new Date(history[history.length - 1].generatedAt).toLocaleDateString() : ''}
        </text>
      </svg>
    </section>`;
}

function generateCSS(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      padding: 2rem;
      line-height: 1.6;
    }
    h1 { color: #7c83ff; margin-bottom: 0.5rem; }
    h2 { color: #a8b2d1; margin-bottom: 1rem; font-size: 1.3rem; }
    .subtitle { color: #888; margin-bottom: 2rem; }
    section { margin-bottom: 2.5rem; }

    /* Summary cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
    }
    .summary-card {
      background: #16213e;
      border-radius: 8px;
      padding: 1.5rem;
      text-align: center;
      border: 1px solid #2a2a4a;
    }
    .summary-card.pass { border-color: #2ecc71; }
    .summary-card.fail { border-color: #e74c3c; }
    .summary-value { font-size: 2rem; font-weight: bold; }
    .summary-card.pass .summary-value { color: #2ecc71; }
    .summary-card.fail .summary-value { color: #e74c3c; }
    .summary-label { color: #888; margin-top: 0.5rem; font-size: 0.85rem; text-transform: uppercase; }

    /* Benchmark table */
    table {
      width: 100%;
      border-collapse: collapse;
      background: #16213e;
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      background: #0f3460;
      padding: 0.75rem 1rem;
      text-align: left;
      font-weight: 600;
      color: #a8b2d1;
      font-size: 0.85rem;
      text-transform: uppercase;
    }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #2a2a4a; }
    tr.pass .status-cell { color: #2ecc71; font-weight: bold; }
    tr.fail .status-cell { color: #e74c3c; font-weight: bold; }
    tr.fail { background: rgba(231, 76, 60, 0.05); }
    .details-cell { font-size: 0.8rem; }
    .detail-chip {
      display: inline-block;
      background: #0f3460;
      border-radius: 4px;
      padding: 2px 6px;
      margin: 2px;
      font-size: 0.75rem;
      color: #a8b2d1;
    }

    /* Latency bars */
    .bar-row { display: flex; align-items: center; margin-bottom: 0.5rem; }
    .bar-label {
      width: 240px;
      flex-shrink: 0;
      font-size: 0.85rem;
      color: #a8b2d1;
      text-align: right;
      padding-right: 1rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-container {
      flex: 1;
      background: #16213e;
      border-radius: 4px;
      height: 28px;
      overflow: hidden;
    }
    .bar {
      height: 100%;
      border-radius: 4px;
      display: flex;
      align-items: center;
      padding-left: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      min-width: 60px;
      transition: width 0.3s;
    }
    .bar-pass { background: linear-gradient(90deg, #2ecc71, #27ae60); color: #fff; }
    .bar-fail { background: linear-gradient(90deg, #e74c3c, #c0392b); color: #fff; }

    /* Trend chart */
    .trend-chart { width: 100%; max-width: 700px; }
    .trend-line { fill: none; stroke: #7c83ff; stroke-width: 2; }
    .trend-dot { fill: #7c83ff; }
    .threshold-line { stroke: #e67e22; stroke-dasharray: 6 3; stroke-width: 1; }
    .threshold-label { fill: #e67e22; font-size: 12px; }
    .axis-label { fill: #888; font-size: 11px; }

    /* Warning section */
    .warning-card {
      background: rgba(231, 76, 60, 0.1);
      border: 1px solid #e74c3c;
      border-radius: 8px;
      padding: 1rem 1.5rem;
      color: #e74c3c;
      font-size: 0.9rem;
    }
    .warning-card ul { margin-top: 0.5rem; padding-left: 1.5rem; }
  `;
}

function buildReport(entries: BenchmarkEntry[], history: DashboardReport[]): DashboardReport {
  const passed = entries.filter((e) => e.passed).length;
  const failed = entries.length - passed;

  return {
    generatedAt: Date.now(),
    entries,
    summary: {
      totalBenchmarks: entries.length,
      passed,
      failed,
      overallScore: computeOverallScore(entries),
    },
    history,
  };
}

/** Generate HTML dashboard report. Returns the HTML content. */
export async function generateDashboard(
  entries: BenchmarkEntry[],
  outputPath: string,
  historyPath?: string,
): Promise<string> {
  const history = historyPath ? await loadHistory(historyPath) : [];
  const report = buildReport(entries, history);
  const ciResult = checkCIGates(entries);

  const generatedDate = new Date(report.generatedAt).toLocaleString();

  let ciWarning = '';
  if (!ciResult.passed) {
    const items = ciResult.failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('\n');
    ciWarning = `
      <section>
        <div class="warning-card">
          <strong>CI Gate Failures</strong>
          <ul>${items}</ul>
        </div>
      </section>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>APEX Benchmark Dashboard</title>
  <style>${generateCSS()}</style>
</head>
<body>
  <h1>APEX Benchmark Dashboard</h1>
  <p class="subtitle">Generated ${escapeHtml(generatedDate)}</p>
  ${ciWarning}
  ${generateSummarySection(report)}
  ${generateBenchmarkTable(entries)}
  ${generateLatencyChart(entries)}
  ${generateHistorySection(history)}
</body>
</html>`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf-8');

  // Save to history if path provided
  if (historyPath) {
    await saveToHistory(report, historyPath);
  }

  return html;
}

// ---------------------------------------------------------------------------
// Full suite runner (stub — wired up later when benchmark modules are ready)
// ---------------------------------------------------------------------------

/**
 * Run all benchmarks and generate a full report.
 *
 * Currently a skeleton that processes any entries passed through the runner
 * pipeline. Individual benchmark modules will be wired in once they stabilise.
 */
export async function runFullBenchmarkSuite(
  outputDir: string,
): Promise<DashboardReport> {
  const entries: BenchmarkEntry[] = [];
  const now = Date.now();

  // Placeholder: each benchmark module would be imported and run here.
  // Use try/catch per module so one failure doesn't block the rest.
  //
  // Example (to be wired up):
  //   try {
  //     const recallResults = await runRecallBenchmark();
  //     for (const r of recallResults) {
  //       entries.push(normaliseRecallResult(r));
  //     }
  //   } catch (err) {
  //     entries.push(errorEntry('recall', err));
  //   }

  const historyPath = path.join(outputDir, '.apex-data', 'benchmarks', 'history.json');
  const outputPath = path.join(outputDir, 'benchmark-dashboard.html');

  const history = await loadHistory(historyPath);
  const report = buildReport(entries, history);
  report.generatedAt = now;

  await generateDashboard(entries, outputPath, historyPath);

  return report;
}
