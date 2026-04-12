import { randomUUID } from 'node:crypto';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalStatus = 'active' | 'completed' | 'blocked' | 'abandoned';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Goal {
  id: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  parentId: string | null;
  subGoalIds: string[];
  deadline: string | null;
  progress: number;
  context: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GoalStackSummary {
  totalGoals: number;
  activeGoals: number;
  completedGoals: number;
  blockedGoals: number;
  topLevelGoals: Goal[];
  urgentGoals: Goal[];
  recentlyCompleted: Goal[];
}

export interface GoalStackOptions {
  fileStore: FileStore;
  logger?: Logger;
  maxGoals?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'goals';

const PRIORITY_ORDER: Record<GoalPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// GoalStack
// ---------------------------------------------------------------------------

export class GoalStack {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private readonly maxGoals: number;
  private goals: Map<string, Goal> = new Map();

  constructor(opts: GoalStackOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:goal-stack' });
    this.maxGoals = opts.maxGoals ?? 100;
  }

  /** Load all persisted goals into memory. */
  async init(): Promise<void> {
    const ids = await this.fileStore.list(COLLECTION);
    for (const id of ids) {
      const goal = await this.fileStore.read<Goal>(COLLECTION, id);
      if (goal) {
        this.goals.set(goal.id, goal);
      }
    }
    this.logger.info(`GoalStack initialised`, { goalCount: this.goals.size });
  }

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  async addGoal(input: {
    description: string;
    priority?: GoalPriority;
    parentId?: string;
    deadline?: string;
    context?: string;
    tags?: string[];
  }): Promise<Goal> {
    if (this.goals.size >= this.maxGoals) {
      this.logger.warn('Max goals reached, refusing to add', { maxGoals: this.maxGoals });
      throw new Error(`Maximum number of goals (${this.maxGoals}) reached`);
    }

    if (input.parentId != null && !this.goals.has(input.parentId)) {
      throw new Error(`Parent goal "${input.parentId}" not found`);
    }

    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(),
      description: input.description,
      status: 'active',
      priority: input.priority ?? 'medium',
      parentId: input.parentId ?? null,
      subGoalIds: [],
      deadline: input.deadline ?? null,
      progress: 0,
      context: input.context ?? '',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.goals.set(goal.id, goal);

    // Link to parent
    if (goal.parentId != null) {
      const parent = this.goals.get(goal.parentId)!;
      parent.subGoalIds.push(goal.id);
      parent.updatedAt = now;
      await this.fileStore.write(COLLECTION, parent.id, parent);
    }

    await this.fileStore.write(COLLECTION, goal.id, goal);
    return goal;
  }

  getGoal(id: string): Goal | null {
    return this.goals.get(id) ?? null;
  }

  async updateGoal(
    id: string,
    updates: Partial<Pick<Goal, 'description' | 'priority' | 'status' | 'deadline' | 'context' | 'tags' | 'progress'>>,
  ): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    Object.assign(goal, updates, { updatedAt: new Date().toISOString() });
    await this.fileStore.write(COLLECTION, goal.id, goal);
    return goal;
  }

  async completeGoal(id: string): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    const now = new Date().toISOString();
    goal.status = 'completed';
    goal.progress = 1;
    goal.completedAt = now;
    goal.updatedAt = now;
    await this.fileStore.write(COLLECTION, goal.id, goal);

    // Recompute parent progress up the chain
    if (goal.parentId != null) {
      await this.recomputeProgressChain(goal.parentId);
    }

    return goal;
  }

  async blockGoal(id: string, reason?: string): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    goal.status = 'blocked';
    goal.updatedAt = new Date().toISOString();
    if (reason) {
      goal.context = goal.context
        ? `${goal.context}\nBlocked: ${reason}`
        : `Blocked: ${reason}`;
    }
    await this.fileStore.write(COLLECTION, goal.id, goal);
    return goal;
  }

  async abandonGoal(id: string, cascade?: boolean): Promise<Goal | null> {
    const goal = this.goals.get(id);
    if (!goal) return null;

    const now = new Date().toISOString();
    goal.status = 'abandoned';
    goal.updatedAt = now;
    await this.fileStore.write(COLLECTION, goal.id, goal);

    if (cascade) {
      await this.abandonSubGoals(goal.subGoalIds);
    }

    if (goal.parentId != null) {
      await this.recomputeProgressChain(goal.parentId);
    }

    return goal;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getActiveGoals(): Goal[] {
    const active = [...this.goals.values()].filter((g) => g.status === 'active');
    return active.sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pd !== 0) return pd;
      return compareDeadlines(a.deadline, b.deadline);
    });
  }

  getTopLevelGoals(): Goal[] {
    return [...this.goals.values()].filter((g) => g.parentId === null);
  }

  getSubGoals(parentId: string): Goal[] {
    const parent = this.goals.get(parentId);
    if (!parent) return [];
    return parent.subGoalIds
      .map((sid) => this.goals.get(sid))
      .filter((g): g is Goal => g != null);
  }

  getGoalTree(rootId: string): { goal: Goal; children: Array<{ goal: Goal; children: unknown[] }> } {
    const goal = this.goals.get(rootId);
    if (!goal) {
      throw new Error(`Goal "${rootId}" not found`);
    }
    return {
      goal,
      children: goal.subGoalIds
        .map((cid) => {
          const child = this.goals.get(cid);
          if (!child) return null;
          return this.getGoalTree(child.id);
        })
        .filter((c): c is { goal: Goal; children: Array<{ goal: Goal; children: unknown[] }> } => c != null),
    };
  }

  getSummary(): GoalStackSummary {
    const all = [...this.goals.values()];
    const completed = all.filter((g) => g.status === 'completed');
    return {
      totalGoals: all.length,
      activeGoals: all.filter((g) => g.status === 'active').length,
      completedGoals: completed.length,
      blockedGoals: all.filter((g) => g.status === 'blocked').length,
      topLevelGoals: this.getTopLevelGoals(),
      urgentGoals: this.getUrgentGoals(),
      recentlyCompleted: completed
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
        .slice(0, 5),
    };
  }

  getContextString(): string {
    const topLevel = this.getTopLevelGoals().filter((g) => g.status === 'active');
    if (topLevel.length === 0) return 'No active goals.';

    const lines: string[] = [`Active goals (${topLevel.length}):`];
    for (const goal of topLevel) {
      lines.push(this.formatGoalLine(goal, 0));
      for (const sub of this.getSubGoals(goal.id)) {
        lines.push(this.formatGoalLine(sub, 1));
      }
    }
    return lines.join('\n');
  }

  recomputeProgress(goalId: string): number {
    const goal = this.goals.get(goalId);
    if (!goal) return 0;

    if (goal.subGoalIds.length === 0) return goal.progress;

    const subs = this.getSubGoals(goalId);
    if (subs.length === 0) return goal.progress;

    const completed = subs.filter((s) => s.status === 'completed').length;
    return completed / subs.length;
  }

  searchGoals(query: string): Goal[] {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0);
    if (keywords.length === 0) return [];

    const scored: Array<{ goal: Goal; score: number }> = [];
    for (const goal of this.goals.values()) {
      const haystack = [goal.description, goal.context, ...goal.tags]
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (haystack.includes(kw)) score++;
      }
      if (score > 0) scored.push({ goal, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.goal);
  }

  getUrgentGoals(withinHours: number = 24): Goal[] {
    const now = Date.now();
    const cutoff = now + withinHours * 60 * 60 * 1000;

    return [...this.goals.values()].filter((g) => {
      if (g.status !== 'active') return false;
      if (g.priority === 'critical') return true;
      if (g.deadline != null) {
        const dl = new Date(g.deadline).getTime();
        return dl <= cutoff;
      }
      return false;
    });
  }

  async persist(): Promise<void> {
    for (const goal of this.goals.values()) {
      await this.fileStore.write(COLLECTION, goal.id, goal);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async abandonSubGoals(subGoalIds: string[]): Promise<void> {
    for (const sid of subGoalIds) {
      const sub = this.goals.get(sid);
      if (sub && sub.status !== 'abandoned') {
        sub.status = 'abandoned';
        sub.updatedAt = new Date().toISOString();
        await this.fileStore.write(COLLECTION, sub.id, sub);
        if (sub.subGoalIds.length > 0) {
          await this.abandonSubGoals(sub.subGoalIds);
        }
      }
    }
  }

  private async recomputeProgressChain(goalId: string): Promise<void> {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const newProgress = this.recomputeProgress(goalId);
    if (goal.progress !== newProgress) {
      goal.progress = newProgress;
      goal.updatedAt = new Date().toISOString();
      await this.fileStore.write(COLLECTION, goal.id, goal);
    }

    if (goal.parentId != null) {
      await this.recomputeProgressChain(goal.parentId);
    }
  }

  private formatGoalLine(goal: Goal, indent: number): string {
    const pad = '  '.repeat(indent);
    const tag = goal.priority.toUpperCase();
    const pct = Math.round(goal.progress * 100);

    let detail: string;
    if (goal.status === 'completed') {
      detail = 'completed';
    } else {
      const parts: string[] = [];
      if (goal.status !== 'active') parts.push(goal.status);
      parts.push(`${pct}%`);
      detail = parts.join(', ');
    }

    let line = `${pad}- [${tag}] ${goal.description} (${detail})`;
    if (goal.deadline != null && goal.status === 'active') {
      const dl = goal.deadline.split('T')[0];
      line = `${pad}- [${tag}] ${goal.description} (${pct}% progress, deadline: ${dl})`;
    }
    return line;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function compareDeadlines(a: string | null, b: string | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}
