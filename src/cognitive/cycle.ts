/**
 * Formal Cognitive Cycle — Phase 15: Cognitive Architecture Integration
 *
 * Implements a perceive→decide→act→learn cognitive loop inspired by SOAR/ACT-R,
 * mapping existing MCP tools onto cycle phases and tracking transitions.
 */

import { randomUUID } from 'node:crypto';
import type { FileStore } from '../utils/file-store.js';
import type { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CognitivePhase = 'perceive' | 'decide' | 'act' | 'learn' | 'idle';

export interface PhaseTransition {
  from: CognitivePhase;
  to: CognitivePhase;
  toolName: string;
  timestamp: number;
}

export interface CycleMetrics {
  totalCycles: number;
  completedCycles: number;
  partialCycles: number;
  avgCycleDuration: number;
  avgPhaseTime: Record<CognitivePhase, number>;
  phaseTransitionCounts: Record<string, number>;
  currentPhase: CognitivePhase;
  currentCycleStart: number | null;
  toolsPerPhase: Record<CognitivePhase, Record<string, number>>;
}

export interface CycleEvent {
  id: string;
  cycleId: string;
  phase: CognitivePhase;
  toolName: string;
  timestamp: number;
  duration: number;
}

export interface CognitiveCycleOptions {
  fileStore: FileStore;
  logger?: Logger;
  idleTimeout?: number;
  maxCycleHistory?: number;
}

// ---------------------------------------------------------------------------
// Persisted shapes
// ---------------------------------------------------------------------------

interface PersistedMetrics {
  totalCycles: number;
  completedCycles: number;
  partialCycles: number;
  totalCycleDuration: number;
  cycleCount: number;
  phaseTimeTotals: Record<CognitivePhase, number>;
  phaseTimeCounts: Record<CognitivePhase, number>;
  phaseTransitionCounts: Record<string, number>;
  toolsPerPhase: Record<CognitivePhase, Record<string, number>>;
}

interface PersistedEvents {
  events: CycleEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANONICAL_ORDER: CognitivePhase[] = ['perceive', 'decide', 'act', 'learn'];

const DEFAULT_IDLE_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_MAX_HISTORY = 500;

const COLLECTION = 'cognitive-cycles';

const PHASE_SUGGESTIONS: Record<CognitivePhase, { phase: CognitivePhase; tools: string[] }> = {
  idle: { phase: 'perceive', tools: ['apex_recall', 'apex_status', 'apex_skills'] },
  perceive: { phase: 'decide', tools: ['apex_plan_context', 'apex_foresight_predict'] },
  decide: { phase: 'act', tools: ['apex_record', 'apex_skill_store'] },
  act: { phase: 'learn', tools: ['apex_reflect_store', 'apex_foresight_resolve'] },
  learn: { phase: 'perceive', tools: ['apex_recall'] },
};

// ---------------------------------------------------------------------------
// Tool → Phase mapping
// ---------------------------------------------------------------------------

function buildToolMap(): Map<string, CognitivePhase> {
  const m = new Map<string, CognitivePhase>();

  // Perceive
  for (const t of [
    'apex_recall',
    'apex_skills',
    'apex_status',
    'apex_reflect_get',
    'apex_foresight_check',
  ]) {
    m.set(t, 'perceive');
  }

  // Decide
  for (const t of [
    'apex_plan_context',
    'apex_foresight_predict',
    'apex_curriculum',
    'apex_arch_suggest',
    'apex_prompt_optimize',
  ]) {
    m.set(t, 'decide');
  }

  // Act
  for (const t of [
    'apex_record',
    'apex_skill_store',
    'apex_reflect_store',
    'apex_promote',
    'apex_import',
    'apex_snapshot',
    'apex_rollback',
    'apex_consolidate',
    'apex_setup',
    'apex_prompt_module',
  ]) {
    m.set(t, 'act');
  }

  // Learn
  for (const t of [
    'apex_foresight_resolve',
    'apex_population_evolve',
    'apex_arch_mutate',
    'apex_tool_propose',
    'apex_tool_verify',
    'apex_tool_compose',
  ]) {
    m.set(t, 'learn');
  }

  return m;
}

// ---------------------------------------------------------------------------
// CognitiveCycle
// ---------------------------------------------------------------------------

export class CognitiveCycle {
  private readonly fileStore: FileStore;
  private readonly logger: Logger | undefined;
  private readonly idleTimeout: number;
  private readonly maxCycleHistory: number;
  private readonly toolMap: Map<string, CognitivePhase>;

  private currentPhase: CognitivePhase = 'idle';
  private currentCycleId: string = randomUUID();
  private currentCycleStart: number | null = null;
  private lastToolTimestamp: number | null = null;

  private events: CycleEvent[] = [];
  private transitions: PhaseTransition[] = [];

  // Accumulated metrics
  private metricsData: PersistedMetrics = CognitiveCycle.emptyMetrics();

  // Phases seen in the current cycle (in order of first appearance)
  private currentCyclePhases: CognitivePhase[] = [];

  constructor(opts: CognitiveCycleOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger;
    this.idleTimeout = opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this.maxCycleHistory = opts.maxCycleHistory ?? DEFAULT_MAX_HISTORY;
    this.toolMap = buildToolMap();
  }

  // -- Lifecycle ------------------------------------------------------------

  async init(): Promise<void> {
    const savedMetrics = await this.fileStore.read<PersistedMetrics>(COLLECTION, 'metrics');
    if (savedMetrics) {
      this.metricsData = savedMetrics;
    }
    const savedEvents = await this.fileStore.read<PersistedEvents>(COLLECTION, 'events');
    if (savedEvents) {
      this.events = savedEvents.events;
    }
    this.logger?.debug('CognitiveCycle initialized');
  }

  // -- Public API -----------------------------------------------------------

  classifyTool(toolName: string): CognitivePhase {
    return this.toolMap.get(toolName) ?? 'act';
  }

  recordToolCall(toolName: string, duration: number = 0): CycleEvent {
    const now = Date.now();

    // Check idle timeout — if exceeded, finalize the current cycle and reset
    if (
      this.lastToolTimestamp !== null &&
      now - this.lastToolTimestamp >= this.idleTimeout &&
      this.currentPhase !== 'idle'
    ) {
      this.finalizeCycle();
      this.resetInternal();
    }

    const phase = this.classifyTool(toolName);

    // If idle, starting a new cycle
    if (this.currentPhase === 'idle') {
      this.currentCycleId = randomUUID();
      this.currentCycleStart = now;
      this.currentCyclePhases = [];
    }

    // Record transition if phase changed
    if (phase !== this.currentPhase) {
      this.transitions.push({
        from: this.currentPhase,
        to: phase,
        toolName,
        timestamp: now,
      });

      const key = `${this.currentPhase}→${phase}`;
      this.metricsData.phaseTransitionCounts[key] =
        (this.metricsData.phaseTransitionCounts[key] ?? 0) + 1;

      this.currentPhase = phase;
    }

    // Track phases seen in this cycle
    if (!this.currentCyclePhases.includes(phase)) {
      this.currentCyclePhases.push(phase);
    }

    // Track phase time
    this.metricsData.phaseTimeTotals[phase] =
      (this.metricsData.phaseTimeTotals[phase] ?? 0) + duration;
    this.metricsData.phaseTimeCounts[phase] =
      (this.metricsData.phaseTimeCounts[phase] ?? 0) + 1;

    // Track tool usage per phase
    if (!this.metricsData.toolsPerPhase[phase]) {
      this.metricsData.toolsPerPhase[phase] = {};
    }
    this.metricsData.toolsPerPhase[phase][toolName] =
      (this.metricsData.toolsPerPhase[phase][toolName] ?? 0) + 1;

    // Create event
    const event: CycleEvent = {
      id: randomUUID(),
      cycleId: this.currentCycleId,
      phase,
      toolName,
      timestamp: now,
      duration,
    };

    this.events.push(event);
    this.lastToolTimestamp = now;

    // Trim history
    if (this.events.length > this.maxCycleHistory) {
      this.events = this.events.slice(-this.maxCycleHistory);
    }

    // Check if a full cycle just completed
    if (this.isFullCycleComplete()) {
      this.finalizeCycle();
      // Don't reset — allow continuing in the current phase
    }

    return event;
  }

  getCurrentPhase(): CognitivePhase {
    return this.currentPhase;
  }

  suggestNextPhase(): { phase: CognitivePhase; suggestedTools: string[] } {
    const suggestion = PHASE_SUGGESTIONS[this.currentPhase];
    return { phase: suggestion.phase, suggestedTools: [...suggestion.tools] };
  }

  getCycleQuality(): number {
    if (this.currentCyclePhases.length === 0) return 0;

    let score = 1.0;

    // Penalize missing phases
    const seen = new Set(this.currentCyclePhases);
    for (const phase of CANONICAL_ORDER) {
      if (!seen.has(phase)) {
        score -= 0.25;
      }
    }

    // Penalize out-of-order transitions
    const relevantPhases = this.currentCyclePhases.filter((p) =>
      CANONICAL_ORDER.includes(p),
    );
    for (let i = 1; i < relevantPhases.length; i++) {
      const prevIdx = CANONICAL_ORDER.indexOf(relevantPhases[i - 1]);
      const currIdx = CANONICAL_ORDER.indexOf(relevantPhases[i]);
      if (currIdx < prevIdx) {
        score -= 0.1;
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  getCurrentCycleEvents(): CycleEvent[] {
    return this.events.filter((e) => e.cycleId === this.currentCycleId);
  }

  getMetrics(): CycleMetrics {
    const avgPhaseTime = {} as Record<CognitivePhase, number>;
    for (const phase of ['perceive', 'decide', 'act', 'learn', 'idle'] as CognitivePhase[]) {
      const total = this.metricsData.phaseTimeTotals[phase] ?? 0;
      const count = this.metricsData.phaseTimeCounts[phase] ?? 0;
      avgPhaseTime[phase] = count > 0 ? total / count : 0;
    }

    return {
      totalCycles: this.metricsData.totalCycles,
      completedCycles: this.metricsData.completedCycles,
      partialCycles: this.metricsData.partialCycles,
      avgCycleDuration:
        this.metricsData.cycleCount > 0
          ? this.metricsData.totalCycleDuration / this.metricsData.cycleCount
          : 0,
      avgPhaseTime,
      phaseTransitionCounts: { ...this.metricsData.phaseTransitionCounts },
      currentPhase: this.currentPhase,
      currentCycleStart: this.currentCycleStart,
      toolsPerPhase: JSON.parse(
        JSON.stringify(this.metricsData.toolsPerPhase),
      ) as Record<CognitivePhase, Record<string, number>>,
    };
  }

  reset(): void {
    if (this.currentPhase !== 'idle') {
      this.finalizeCycle();
    }
    this.resetInternal();
  }

  getCycleHistory(limit?: number): CycleEvent[] {
    const n = limit ?? this.events.length;
    return this.events.slice(-n);
  }

  getPhaseContext(): string {
    if (this.currentPhase === 'idle') {
      return 'Currently IDLE. Suggested: start with perception — recall memories, check status, or search skills.';
    }

    const cycleEvents = this.getCurrentCycleEvents();
    const phaseSummaries: string[] = [];

    for (const phase of CANONICAL_ORDER) {
      const phaseEvents = cycleEvents.filter((e) => e.phase === phase);
      if (phaseEvents.length > 0) {
        const tools = [...new Set(phaseEvents.map((e) => e.toolName))];
        phaseSummaries.push(`${phase.toUpperCase()}: used ${tools.join(', ')}`);
      }
    }

    const quality = this.getCycleQuality();
    const suggestion = this.suggestNextPhase();

    const parts: string[] = [
      `Currently in ${this.currentPhase.toUpperCase()} phase.`,
    ];

    if (phaseSummaries.length > 0) {
      parts.push(`Previous: ${phaseSummaries.join('; ')}.`);
    }

    parts.push(
      `Suggested next: ${suggestion.phase.toUpperCase()} phase — ${suggestion.suggestedTools.join(', ')}.`,
    );
    parts.push(`Cycle quality: ${(quality * 100).toFixed(0)}%.`);

    return parts.join(' ');
  }

  async persist(): Promise<void> {
    await this.fileStore.write(COLLECTION, 'metrics', this.metricsData);
    await this.fileStore.write(COLLECTION, 'events', { events: this.events } satisfies PersistedEvents);
    this.logger?.debug('CognitiveCycle persisted');
  }

  // -- Private helpers ------------------------------------------------------

  private isFullCycleComplete(): boolean {
    const seen = new Set(this.currentCyclePhases);
    return CANONICAL_ORDER.every((p) => seen.has(p));
  }

  private finalizeCycle(): void {
    this.metricsData.totalCycles++;

    if (this.isFullCycleComplete()) {
      this.metricsData.completedCycles++;
    } else {
      this.metricsData.partialCycles++;
    }

    if (this.currentCycleStart !== null) {
      const duration = Date.now() - this.currentCycleStart;
      this.metricsData.totalCycleDuration += duration;
      this.metricsData.cycleCount++;
    }
  }

  private resetInternal(): void {
    this.currentPhase = 'idle';
    this.currentCycleId = randomUUID();
    this.currentCycleStart = null;
    this.currentCyclePhases = [];
    this.transitions = [];
  }

  private static emptyMetrics(): PersistedMetrics {
    return {
      totalCycles: 0,
      completedCycles: 0,
      partialCycles: 0,
      totalCycleDuration: 0,
      cycleCount: 0,
      phaseTimeTotals: { perceive: 0, decide: 0, act: 0, learn: 0, idle: 0 },
      phaseTimeCounts: { perceive: 0, decide: 0, act: 0, learn: 0, idle: 0 },
      phaseTransitionCounts: {},
      toolsPerPhase: { perceive: {}, decide: {}, act: {}, learn: {}, idle: {} },
    };
  }
}
