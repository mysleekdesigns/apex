/**
 * Tool Creation & Mastery — Voyager-inspired Tool Factory
 *
 * Automatically creates, verifies, composes, and tracks mastery of tools
 * extracted from successful episode patterns. The pipeline:
 *
 * 1. Analyse successful episodes for recurring multi-step action patterns.
 * 2. When a pattern meets frequency and success-rate thresholds, propose it
 *    as a new tool with extracted parameters and preconditions.
 * 3. Run a sandboxed verification pass that scores quality, generalisability,
 *    and safety.
 * 4. Detect tool chains (A -> B) and create composite tools for common
 *    pipelines.
 * 5. Track mastery metrics (usage, success rate, failure contexts) over time.
 *
 * Zero LLM calls — pure algorithmic extraction.
 */

import type {
  Episode,
  Action,
  ToolDefinitionApex,
  ToolComposition,
} from '../types.js';
import { generateId } from '../types.js';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link ToolFactory}.
 */
export interface ToolFactoryOptions {
  /** FileStore for persisting tools and compositions. */
  fileStore: FileStore;

  /**
   * Minimum number of episodes a pattern must appear in to be proposed
   * as a tool. Defaults to `3`.
   */
  minFrequency?: number;

  /**
   * Minimum success rate (0-1) for a pattern to qualify.
   * Defaults to `0.8`.
   */
  minSuccessRate?: number;

  /** Maximum action-sequence length to consider. Defaults to `6`. */
  maxPatternLength?: number;

  /** Minimum action-sequence length to consider. Defaults to `2`. */
  minPatternLength?: number;

  /** Logger instance. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Regex patterns for extracting parameters from action descriptions. */
const PARAM_EXTRACTORS: Array<{
  regex: RegExp;
  paramName: string;
  paramType: string;
}> = [
  { regex: /(?:\/[\w.-]+){2,}(?:\.\w+)?/g, paramName: 'path', paramType: 'string' },
  { regex: /"[^"]+"/g, paramName: 'value', paramType: 'string' },
  { regex: /'[^']+'/g, paramName: 'value', paramType: 'string' },
  { regex: /\b\d{2,}\b/g, paramName: 'number', paramType: 'number' },
];

/**
 * Replace concrete values with `<param>` placeholders and return the
 * parameterised template plus discovered parameter names.
 */
function parameterize(description: string): {
  template: string;
  params: Array<{ name: string; type: string }>;
} {
  let template = description;
  const params: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();

  for (const { regex, paramName, paramType } of PARAM_EXTRACTORS) {
    const matches = description.match(regex);
    if (matches) {
      for (const match of matches) {
        template = template.replace(match, `<${paramName}>`);
        const key = `${paramName}:${paramType}`;
        if (!seen.has(key)) {
          seen.add(key);
          params.push({ name: paramName, type: paramType });
        }
      }
    }
  }

  return { template, params };
}

/**
 * Create a serialisable key from an action-type sequence for grouping.
 */
function ngramKey(types: string[]): string {
  return types.join('|');
}

/**
 * Build a human-readable tool name from action types.
 */
function buildToolName(actionTypes: string[]): string {
  return actionTypes
    .map((t) => t.replace(/[_\s]+/g, '-').toLowerCase())
    .join('-then-');
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A pattern discovered across episodes, used internally before tool creation.
 */
interface DiscoveredPattern {
  /** Action types in order. */
  actionTypes: string[];

  /** Parameterised description templates. */
  templates: string[];

  /** Number of episodes containing this pattern. */
  frequency: number;

  /** Success rate across episodes that contain this pattern. */
  successRate: number;

  /** Episode IDs containing this pattern. */
  sourceEpisodeIds: string[];

  /** Parameters extracted from variable parts of descriptions. */
  extractedParams: Array<{ name: string; type: string; description: string }>;
}

// ---------------------------------------------------------------------------
// ToolFactory implementation
// ---------------------------------------------------------------------------

/**
 * Automatic tool creation, verification, composition, and mastery tracking.
 *
 * Usage:
 * ```ts
 * const factory = new ToolFactory({ fileStore, logger });
 * const proposed = factory.proposeTools(episodes);
 * for (const tool of proposed) {
 *   const verified = factory.verify(tool);
 *   if (verified.verificationStatus === 'verified') {
 *     await factory.saveTool(verified);
 *   }
 * }
 * ```
 */
export class ToolFactory {
  private readonly fileStore: FileStore;
  private readonly minFrequency: number;
  private readonly minSuccessRate: number;
  private readonly maxPatternLength: number;
  private readonly minPatternLength: number;
  private readonly logger: Logger;

  /** Collection name for persisting tools. */
  private static readonly TOOLS_COLLECTION = 'apex-tools';

  /** Collection name for persisting compositions. */
  private static readonly COMPOSITIONS_COLLECTION = 'apex-tool-compositions';

  constructor(options: ToolFactoryOptions) {
    this.fileStore = options.fileStore;
    this.minFrequency = options.minFrequency ?? 3;
    this.minSuccessRate = options.minSuccessRate ?? 0.8;
    this.maxPatternLength = options.maxPatternLength ?? 6;
    this.minPatternLength = options.minPatternLength ?? 2;
    this.logger = options.logger ?? new Logger({ prefix: 'apex:tool-factory' });
  }

  // ── Pattern extraction ─────────────────────────────────────────────

  /**
   * Analyse episodes and propose tools for recurring successful patterns.
   *
   * Scans successful episodes for action-type n-grams that recur at least
   * `minFrequency` times with a success rate above `minSuccessRate`, then
   * generates structured tool definitions with extracted parameters.
   *
   * @param episodes - Episodes to mine for patterns.
   * @returns Proposed tool definitions with `verificationStatus: 'pending'`.
   */
  proposeTools(episodes: Episode[]): ToolDefinitionApex[] {
    this.logger.info('Starting tool proposal', { episodeCount: episodes.length });

    const patterns = this.extractPatterns(episodes);
    this.logger.debug('Patterns discovered', { count: patterns.length });

    const tools: ToolDefinitionApex[] = [];
    for (const pattern of patterns) {
      const tool = this.patternToTool(pattern);
      tools.push(tool);
    }

    this.logger.info('Tool proposal complete', { proposedCount: tools.length });
    return tools;
  }

  /**
   * Extract recurring action patterns from episodes.
   *
   * @param episodes - Full set of episodes.
   * @returns Patterns meeting frequency and success-rate thresholds.
   */
  extractPatterns(episodes: Episode[]): DiscoveredPattern[] {
    const successful = episodes.filter((e) => e.outcome.success);
    if (successful.length === 0) return [];

    // Build n-gram frequency map from successful episodes
    const ngramMap = new Map<
      string,
      {
        episodeIds: Set<string>;
        occurrences: Array<{ actions: Action[]; episodeId: string }>;
      }
    >();

    for (const episode of successful) {
      const types = episode.actions.map((a) => a.type);

      for (let len = this.minPatternLength; len <= this.maxPatternLength; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const gram = types.slice(start, start + len);
          const key = ngramKey(gram);

          let entry = ngramMap.get(key);
          if (!entry) {
            entry = { episodeIds: new Set(), occurrences: [] };
            ngramMap.set(key, entry);
          }

          if (!entry.episodeIds.has(episode.id)) {
            entry.episodeIds.add(episode.id);
            entry.occurrences.push({
              actions: episode.actions.slice(start, start + len),
              episodeId: episode.id,
            });
          }
        }
      }
    }

    // Count occurrences in failed episodes for success-rate calculation
    const failed = episodes.filter((e) => !e.outcome.success);
    const failedCounts = new Map<string, number>();

    for (const episode of failed) {
      const types = episode.actions.map((a) => a.type);
      for (let len = this.minPatternLength; len <= this.maxPatternLength; len++) {
        for (let start = 0; start <= types.length - len; start++) {
          const key = ngramKey(types.slice(start, start + len));
          if (ngramMap.has(key)) {
            failedCounts.set(key, (failedCounts.get(key) ?? 0) + 1);
          }
        }
      }
    }

    // Build discovered patterns
    const patterns: DiscoveredPattern[] = [];

    for (const [key, entry] of ngramMap) {
      const frequency = entry.episodeIds.size;
      if (frequency < this.minFrequency) continue;

      const failedCount = failedCounts.get(key) ?? 0;
      const successRate = frequency / (frequency + failedCount);
      if (successRate < this.minSuccessRate) continue;

      const firstOccurrence = entry.occurrences[0];
      const actionTypes = firstOccurrence.actions.map((a) => a.type);

      // Extract parameterised templates and params from first occurrence
      const allParams: Array<{ name: string; type: string; description: string }> = [];
      const paramCounters = new Map<string, number>();
      const templates: string[] = [];

      for (const action of firstOccurrence.actions) {
        const { template, params } = parameterize(action.description);
        templates.push(template);

        for (const p of params) {
          const count = (paramCounters.get(p.name) ?? 0) + 1;
          paramCounters.set(p.name, count);
          const uniqueName = count > 1 ? `${p.name}_${count}` : p.name;
          allParams.push({
            name: uniqueName,
            type: p.type,
            description: `Parameter extracted from step: ${action.type}`,
          });
        }
      }

      patterns.push({
        actionTypes,
        templates,
        frequency,
        successRate,
        sourceEpisodeIds: [...entry.episodeIds],
        extractedParams: allParams,
      });
    }

    return patterns;
  }

  // ── Tool definition generation ─────────────────────────────────────

  /**
   * Convert a discovered pattern into a pending tool definition.
   *
   * @param pattern - The pattern to convert.
   * @returns A tool definition with `verificationStatus: 'pending'`.
   */
  patternToTool(pattern: DiscoveredPattern): ToolDefinitionApex {
    const now = Date.now();
    const name = buildToolName(pattern.actionTypes);

    const stepDescriptions = pattern.actionTypes
      .map((t, i) => `${i + 1}. [${t}] ${pattern.templates[i]}`)
      .join('\n');

    const description = `Auto-extracted tool: ${pattern.actionTypes.join(' -> ')}\n\nSteps:\n${stepDescriptions}`;

    const inputSchema = {
      parameters: pattern.extractedParams.map((p) => ({
        name: p.name,
        type: p.type,
        description: p.description,
        required: true,
      })),
    };

    // Infer preconditions from action types
    const preconditions: string[] = [];
    if (pattern.actionTypes.includes('code_edit')) {
      preconditions.push('Target file must exist and be writable');
    }
    if (pattern.actionTypes.includes('command')) {
      preconditions.push('Shell environment must be available');
    }
    if (pattern.actionTypes.includes('file_read')) {
      preconditions.push('Source file must exist and be readable');
    }

    return {
      id: generateId(),
      name,
      description,
      inputSchema,
      pattern: JSON.stringify({
        actionTypes: pattern.actionTypes,
        templates: pattern.templates,
      }),
      preconditions,
      expectedOutput: `Successful completion of ${pattern.actionTypes.length}-step sequence: ${pattern.actionTypes.join(' -> ')}`,
      sourceEpisodes: pattern.sourceEpisodeIds,
      verificationStatus: 'pending',
      verificationScore: 0,
      masteryMetrics: {
        usageCount: 0,
        successRate: 0,
        avgDuration: 0,
        failureContexts: [],
        lastUsed: 0,
      },
      createdAt: now,
      updatedAt: now,
      tags: [...new Set(pattern.actionTypes.map((t) => t.replace(/[_\s]+/g, '-').toLowerCase()))],
    };
  }

  // ── Verification sandbox ───────────────────────────────────────────

  /**
   * Run verification checks on a proposed tool and assign a score.
   *
   * Checks:
   * - Preconditions are well-defined (non-empty, specific)
   * - Pattern is generalisable (not overfitted — must come from multiple
   *   distinct episodes and have parameterised parts)
   * - Quality score based on clarity, reusability, and safety
   *
   * Mutates and returns the tool with updated `verificationStatus` and
   * `verificationScore`.
   *
   * @param tool - The tool to verify.
   * @returns The tool with updated verification fields.
   */
  verify(tool: ToolDefinitionApex): ToolDefinitionApex {
    this.logger.debug('Verifying tool', { name: tool.name, id: tool.id });

    const scores = {
      preconditions: this.scorePreconditions(tool),
      generalisability: this.scoreGeneralisability(tool),
      clarity: this.scoreClarity(tool),
      reusability: this.scoreReusability(tool),
      safety: this.scoreSafety(tool),
    };

    // Weighted combination
    const totalScore =
      0.15 * scores.preconditions +
      0.30 * scores.generalisability +
      0.20 * scores.clarity +
      0.20 * scores.reusability +
      0.15 * scores.safety;

    const verificationScore = Math.min(1, Math.max(0, totalScore));

    // Determine status
    let verificationStatus: ToolDefinitionApex['verificationStatus'];
    if (verificationScore >= 0.6) {
      verificationStatus = 'verified';
    } else if (verificationScore >= 0.3) {
      verificationStatus = 'pending';
    } else {
      verificationStatus = 'rejected';
    }

    this.logger.debug('Verification result', {
      name: tool.name,
      scores,
      totalScore: Math.round(verificationScore * 1000) / 1000,
      status: verificationStatus,
    });

    return {
      ...tool,
      verificationScore,
      verificationStatus,
      updatedAt: Date.now(),
    };
  }

  /**
   * Score how well-defined the tool's preconditions are.
   * @returns Score in `[0, 1]`.
   */
  private scorePreconditions(tool: ToolDefinitionApex): number {
    if (tool.preconditions.length === 0) return 0.2;

    let score = 0;
    // Credit for having preconditions
    score += Math.min(0.4, tool.preconditions.length * 0.15);

    // Credit for specificity (longer descriptions = more specific)
    const avgLength =
      tool.preconditions.reduce((sum, p) => sum + p.length, 0) /
      tool.preconditions.length;
    score += Math.min(0.3, avgLength / 100);

    // Credit for actionable language
    const actionableWords = ['must', 'should', 'exists', 'available', 'required'];
    const hasActionable = tool.preconditions.some((p) =>
      actionableWords.some((w) => p.toLowerCase().includes(w)),
    );
    if (hasActionable) score += 0.3;

    return Math.min(1, score);
  }

  /**
   * Score whether the tool is generalisable vs. overfitted.
   * @returns Score in `[0, 1]`.
   */
  private scoreGeneralisability(tool: ToolDefinitionApex): number {
    let score = 0;

    // Multiple source episodes indicate generalisability
    const episodeCount = tool.sourceEpisodes.length;
    if (episodeCount >= 5) score += 0.4;
    else if (episodeCount >= 3) score += 0.3;
    else if (episodeCount >= 2) score += 0.15;
    // Single episode = likely overfitted

    // Having parameters indicates the pattern was abstracted
    const paramCount = tool.inputSchema.parameters.length;
    if (paramCount > 0) score += 0.3;
    if (paramCount >= 2) score += 0.1;

    // Multi-step patterns are more likely reusable workflows
    let parsedPattern: { actionTypes?: string[] } = {};
    try {
      parsedPattern = JSON.parse(tool.pattern);
    } catch {
      // not parseable
    }
    const stepCount = parsedPattern.actionTypes?.length ?? 0;
    if (stepCount >= 2 && stepCount <= 5) score += 0.2;

    return Math.min(1, score);
  }

  /**
   * Score the clarity of the tool definition.
   * @returns Score in `[0, 1]`.
   */
  private scoreClarity(tool: ToolDefinitionApex): number {
    let score = 0;

    // Name quality: reasonable length, uses hyphens
    if (tool.name.length >= 5 && tool.name.length <= 60) score += 0.3;
    if (tool.name.includes('-')) score += 0.1;

    // Description quality
    if (tool.description.length >= 20) score += 0.2;
    if (tool.description.includes('Steps:')) score += 0.1;

    // Expected output is defined
    if (tool.expectedOutput.length > 0) score += 0.15;

    // Parameters have descriptions
    const paramsWithDesc = tool.inputSchema.parameters.filter(
      (p) => p.description.length > 0,
    );
    if (tool.inputSchema.parameters.length === 0 || paramsWithDesc.length === tool.inputSchema.parameters.length) {
      score += 0.15;
    }

    return Math.min(1, score);
  }

  /**
   * Score reusability of the tool.
   * @returns Score in `[0, 1]`.
   */
  private scoreReusability(tool: ToolDefinitionApex): number {
    let score = 0;

    // Tags help with discovery
    if (tool.tags.length >= 1) score += 0.2;
    if (tool.tags.length >= 3) score += 0.1;

    // Parameters enable reuse across different contexts
    if (tool.inputSchema.parameters.length > 0) score += 0.3;

    // Not overly specific name (no UUIDs or very long names)
    if (tool.name.length < 80 && !/[0-9a-f]{8}/.test(tool.name)) score += 0.2;

    // Multiple source episodes
    if (tool.sourceEpisodes.length >= 3) score += 0.2;

    return Math.min(1, score);
  }

  /**
   * Score safety of the tool.
   * @returns Score in `[0, 1]`.
   */
  private scoreSafety(tool: ToolDefinitionApex): number {
    let score = 0.5; // Base score — assume reasonable safety

    // Preconditions add safety
    if (tool.preconditions.length > 0) score += 0.2;

    // Check for potentially dangerous patterns
    const dangerousTerms = ['rm -rf', 'force', 'delete', 'drop', 'truncate', 'destroy'];
    const patternLower = tool.pattern.toLowerCase();
    const descLower = tool.description.toLowerCase();
    const hasDangerous = dangerousTerms.some(
      (term) => patternLower.includes(term) || descLower.includes(term),
    );
    if (hasDangerous) score -= 0.3;

    // Tools with expected output are safer (intent is clear)
    if (tool.expectedOutput.length > 10) score += 0.15;

    // Fewer steps = less risk
    let parsedPattern: { actionTypes?: string[] } = {};
    try {
      parsedPattern = JSON.parse(tool.pattern);
    } catch {
      // not parseable
    }
    const stepCount = parsedPattern.actionTypes?.length ?? 0;
    if (stepCount <= 3) score += 0.15;

    return Math.min(1, Math.max(0, score));
  }

  // ── Tool composition ───────────────────────────────────────────────

  /**
   * Detect tools that chain together reliably across episodes and create
   * composite tool definitions.
   *
   * Scans episodes for sequences where Tool A's output is followed by
   * Tool B's input, identifies recurring chains, and produces
   * {@link ToolComposition} objects.
   *
   * @param tools - Known verified tools.
   * @param episodes - Episodes to scan for tool chains.
   * @returns Composite tool compositions meeting frequency thresholds.
   */
  composeTools(
    tools: ToolDefinitionApex[],
    episodes: Episode[],
  ): ToolComposition[] {
    if (tools.length < 2 || episodes.length === 0) return [];

    const successful = episodes.filter((e) => e.outcome.success);
    if (successful.length === 0) return [];

    // Parse each tool's action types for matching
    const toolPatterns = tools
      .filter((t) => t.verificationStatus === 'verified')
      .map((t) => {
        let actionTypes: string[] = [];
        try {
          const parsed = JSON.parse(t.pattern);
          actionTypes = parsed.actionTypes ?? [];
        } catch {
          // skip
        }
        return { tool: t, actionTypes };
      })
      .filter((tp) => tp.actionTypes.length > 0);

    // For each episode, find which tools appear and in what order
    const chainMap = new Map<
      string,
      { toolIds: string[]; toolNames: string[]; count: number }
    >();

    for (const episode of successful) {
      const actionTypes = episode.actions.map((a) => a.type);
      const matchedTools: Array<{ toolId: string; toolName: string; endIndex: number }> = [];

      for (const { tool, actionTypes: patternTypes } of toolPatterns) {
        for (let i = 0; i <= actionTypes.length - patternTypes.length; i++) {
          const slice = actionTypes.slice(i, i + patternTypes.length);
          if (slice.every((t, j) => t === patternTypes[j])) {
            matchedTools.push({
              toolId: tool.id,
              toolName: tool.name,
              endIndex: i + patternTypes.length,
            });
            break;
          }
        }
      }

      // Sort by position in episode
      matchedTools.sort((a, b) => a.endIndex - b.endIndex);

      // Generate pairs
      for (let i = 0; i < matchedTools.length - 1; i++) {
        const pair = [matchedTools[i], matchedTools[i + 1]];
        const key = pair.map((p) => p.toolId).join('|');

        let entry = chainMap.get(key);
        if (!entry) {
          entry = {
            toolIds: pair.map((p) => p.toolId),
            toolNames: pair.map((p) => p.toolName),
            count: 0,
          };
          chainMap.set(key, entry);
        }
        entry.count++;
      }
    }

    // Build compositions for chains that appear frequently enough
    const compositions: ToolComposition[] = [];
    const minChainFreq = Math.max(2, Math.floor(this.minFrequency / 2));

    for (const entry of chainMap.values()) {
      if (entry.count < minChainFreq) continue;

      const composition: ToolComposition = {
        id: generateId(),
        name: entry.toolNames.join('-pipe-'),
        description: `Composite pipeline: ${entry.toolNames.join(' -> ')}. Observed ${entry.count} times in successful episodes.`,
        steps: entry.toolIds.map((toolId, i) => ({
          toolId,
          inputMapping: i === 0 ? {} as Record<string, string> : { input: 'previousOutput' },
        })),
        successRate: entry.count / successful.length,
        usageCount: entry.count,
        createdAt: Date.now(),
      };

      compositions.push(composition);
    }

    this.logger.info('Tool composition complete', {
      compositionCount: compositions.length,
    });

    return compositions;
  }

  // ── Mastery tracking ───────────────────────────────────────────────

  /**
   * Record a tool usage and update mastery metrics.
   *
   * @param tool - The tool that was used.
   * @param success - Whether the usage succeeded.
   * @param duration - Duration of the usage in milliseconds.
   * @param failureContext - Optional context if the usage failed.
   * @returns Updated tool definition.
   */
  recordUsage(
    tool: ToolDefinitionApex,
    success: boolean,
    duration: number,
    failureContext?: string,
  ): ToolDefinitionApex {
    const metrics = { ...tool.masteryMetrics };
    const prevTotal = metrics.usageCount;

    metrics.usageCount += 1;
    metrics.successRate =
      (metrics.successRate * prevTotal + (success ? 1 : 0)) / metrics.usageCount;

    // Running average of duration
    metrics.avgDuration =
      (metrics.avgDuration * prevTotal + duration) / metrics.usageCount;

    metrics.lastUsed = Date.now();

    if (!success && failureContext) {
      metrics.failureContexts = [
        ...metrics.failureContexts.slice(-9),
        failureContext,
      ];
    }

    // Deprecate tools with consistently low success rate after enough usage
    let status = tool.verificationStatus;
    if (metrics.usageCount >= 10 && metrics.successRate < 0.3) {
      status = 'deprecated';
      this.logger.info('Tool deprecated due to low success rate', {
        name: tool.name,
        successRate: metrics.successRate,
      });
    }

    return {
      ...tool,
      masteryMetrics: metrics,
      verificationStatus: status,
      updatedAt: Date.now(),
    };
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Save a tool definition to the file store.
   *
   * @param tool - The tool to persist.
   */
  async saveTool(tool: ToolDefinitionApex): Promise<void> {
    await this.fileStore.write(ToolFactory.TOOLS_COLLECTION, tool.id, tool);
    this.logger.debug('Tool saved', { id: tool.id, name: tool.name });
  }

  /**
   * Load a tool by ID.
   *
   * @param id - The tool ID.
   * @returns The tool or null if not found.
   */
  async loadTool(id: string): Promise<ToolDefinitionApex | null> {
    return this.fileStore.read<ToolDefinitionApex>(ToolFactory.TOOLS_COLLECTION, id);
  }

  /**
   * List all tools, optionally filtered by verification status.
   *
   * @param status - If provided, only return tools with this status.
   * @returns Array of tool definitions.
   */
  async listTools(
    status?: ToolDefinitionApex['verificationStatus'],
  ): Promise<ToolDefinitionApex[]> {
    const all = await this.fileStore.readAll<ToolDefinitionApex>(
      ToolFactory.TOOLS_COLLECTION,
    );
    if (status) {
      return all.filter((t) => t.verificationStatus === status);
    }
    return all;
  }

  /**
   * Save a tool composition to the file store.
   *
   * @param composition - The composition to persist.
   */
  async saveComposition(composition: ToolComposition): Promise<void> {
    await this.fileStore.write(
      ToolFactory.COMPOSITIONS_COLLECTION,
      composition.id,
      composition,
    );
    this.logger.debug('Composition saved', {
      id: composition.id,
      name: composition.name,
    });
  }

  /**
   * List all tool compositions.
   *
   * @returns Array of tool compositions.
   */
  async listCompositions(): Promise<ToolComposition[]> {
    return this.fileStore.readAll<ToolComposition>(
      ToolFactory.COMPOSITIONS_COLLECTION,
    );
  }
}
