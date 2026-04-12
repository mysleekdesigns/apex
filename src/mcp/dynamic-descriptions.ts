import { randomUUID } from 'crypto';
import { FileStore } from '../utils/file-store.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MutationType =
  | 'original'
  | 'rephrase'
  | 'add-example'
  | 'remove-example'
  | 'adjust-emphasis'
  | 'simplify'
  | 'elaborate';

export interface VariantMetrics {
  exposures: number;
  successes: number;
  failures: number;
  totalReward: number;
  avgReward: number;
}

export interface PromptVariant {
  id: string;
  content: string;
  mutationType: MutationType;
  parentVariantId: string | null;
  metrics: VariantMetrics;
  createdAt: string;
}

export interface PromptModuleMetrics {
  totalExposures: number;
  successRate: number;
  avgReward: number;
  lastUpdated: string;
}

export interface PromptModule {
  id: string;
  name: string;
  category: 'tool-description' | 'behavior' | 'few-shot';
  content: string;
  version: number;
  activeVariantId: string | null;
  variants: PromptVariant[];
  metrics: PromptModuleMetrics;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const COLLECTION = 'prompt-modules';

export interface PromptModuleRegistryOptions {
  fileStore: FileStore;
  logger?: Logger;
}

export class PromptModuleRegistry {
  private readonly fileStore: FileStore;
  private readonly logger: Logger;
  private modules: Map<string, PromptModule> = new Map();

  constructor(opts: PromptModuleRegistryOptions) {
    this.fileStore = opts.fileStore;
    this.logger = opts.logger ?? new Logger({ prefix: 'apex:dynamic-descriptions' });
  }

  /** Load all modules from the store into memory. */
  async init(): Promise<void> {
    const items = await this.fileStore.readAll<PromptModule>(COLLECTION);
    for (const mod of items) {
      this.modules.set(mod.name, mod);
    }
    this.logger.debug('Loaded prompt modules', { count: this.modules.size });
  }

  /** Register a new prompt module. */
  async register(input: {
    name: string;
    category: PromptModule['category'];
    content: string;
  }): Promise<PromptModule> {
    const now = new Date().toISOString();
    const mod: PromptModule = {
      id: randomUUID(),
      name: input.name,
      category: input.category,
      content: input.content,
      version: 1,
      activeVariantId: null,
      variants: [],
      metrics: {
        totalExposures: 0,
        successRate: 0,
        avgReward: 0,
        lastUpdated: now,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.modules.set(mod.name, mod);
    await this.fileStore.write(COLLECTION, mod.id, mod);
    this.logger.info('Registered prompt module', { name: mod.name, id: mod.id });
    return mod;
  }

  /** Get the active content for a module (variant content if set, else base). */
  getActiveContent(moduleName: string): string | null {
    const mod = this.modules.get(moduleName);
    if (!mod) return null;

    if (mod.activeVariantId) {
      const variant = mod.variants.find((v) => v.id === mod.activeVariantId);
      if (variant) return variant.content;
    }
    return mod.content;
  }

  /** List all modules. */
  listModules(): PromptModule[] {
    return [...this.modules.values()];
  }

  /** Get modules filtered by category. */
  getByCategory(category: PromptModule['category']): PromptModule[] {
    return [...this.modules.values()].filter((m) => m.category === category);
  }

  /** Add a variant to a module for A/B testing. */
  async addVariant(
    moduleName: string,
    content: string,
    mutationType: MutationType,
  ): Promise<PromptVariant> {
    const mod = this.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" not found`);

    const variant: PromptVariant = {
      id: randomUUID(),
      content,
      mutationType,
      parentVariantId: mod.activeVariantId,
      metrics: {
        exposures: 0,
        successes: 0,
        failures: 0,
        totalReward: 0,
        avgReward: 0,
      },
      createdAt: new Date().toISOString(),
    };

    mod.variants.push(variant);
    mod.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, mod.id, mod);
    this.logger.info('Added variant', { module: moduleName, variantId: variant.id, mutationType });
    return variant;
  }

  /** Set the active variant for a module. */
  async setActiveVariant(moduleName: string, variantId: string): Promise<void> {
    const mod = this.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" not found`);

    const variant = mod.variants.find((v) => v.id === variantId);
    if (!variant) throw new Error(`Variant "${variantId}" not found in module "${moduleName}"`);

    mod.activeVariantId = variantId;
    mod.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, mod.id, mod);
    this.logger.info('Set active variant', { module: moduleName, variantId });
  }

  /** Record that a module's content was exposed (shown to a user/agent). */
  async recordExposure(moduleName: string, variantId?: string): Promise<void> {
    const mod = this.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" not found`);

    mod.metrics.totalExposures++;
    mod.metrics.lastUpdated = new Date().toISOString();

    const vid = variantId ?? mod.activeVariantId;
    if (vid) {
      const variant = mod.variants.find((v) => v.id === vid);
      if (variant) {
        variant.metrics.exposures++;
      }
    }

    await this.fileStore.write(COLLECTION, mod.id, mod);
  }

  /** Record an outcome after a module's content was used. */
  async recordOutcome(
    moduleName: string,
    success: boolean,
    reward?: number,
    variantId?: string,
  ): Promise<void> {
    const mod = this.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" not found`);

    const r = reward ?? (success ? 1 : 0);

    // Update module-level metrics
    const totalOutcomes =
      mod.metrics.totalExposures > 0 ? mod.metrics.totalExposures : 1;
    // Recalculate success rate from variant data if available, otherwise approximate
    const prevTotal = totalOutcomes - 1;
    const prevSuccesses = Math.round(mod.metrics.successRate * prevTotal);
    const newSuccesses = prevSuccesses + (success ? 1 : 0);
    mod.metrics.successRate = newSuccesses / totalOutcomes;

    const prevTotalReward = mod.metrics.avgReward * prevTotal;
    mod.metrics.avgReward = (prevTotalReward + r) / totalOutcomes;
    mod.metrics.lastUpdated = new Date().toISOString();

    // Update variant-level metrics
    const vid = variantId ?? mod.activeVariantId;
    if (vid) {
      const variant = mod.variants.find((v) => v.id === vid);
      if (variant) {
        if (success) {
          variant.metrics.successes++;
        } else {
          variant.metrics.failures++;
        }
        variant.metrics.totalReward += r;
        const vTotal = variant.metrics.successes + variant.metrics.failures;
        variant.metrics.avgReward = vTotal > 0 ? variant.metrics.totalReward / vTotal : 0;
      }
    }

    mod.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, mod.id, mod);
  }

  /** Get metrics for a module. */
  getMetrics(moduleName: string): PromptModuleMetrics | null {
    const mod = this.modules.get(moduleName);
    return mod ? { ...mod.metrics } : null;
  }

  /**
   * Get a dynamic tool description assembled from modules.
   * Looks for a module named `${toolName}_description` in the tool-description category.
   */
  getDynamicDescription(toolName: string): string | null {
    const descName = `${toolName}_description`;
    return this.getActiveContent(descName);
  }

  /** Hot-swap a module's content: create a new 'original' variant and activate it. */
  async hotSwap(moduleName: string, newContent: string): Promise<void> {
    const mod = this.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" not found`);

    const variant: PromptVariant = {
      id: randomUUID(),
      content: newContent,
      mutationType: 'original',
      parentVariantId: mod.activeVariantId,
      metrics: {
        exposures: 0,
        successes: 0,
        failures: 0,
        totalReward: 0,
        avgReward: 0,
      },
      createdAt: new Date().toISOString(),
    };

    mod.variants.push(variant);
    mod.activeVariantId = variant.id;
    mod.version++;
    mod.updatedAt = new Date().toISOString();
    await this.fileStore.write(COLLECTION, mod.id, mod);
    this.logger.info('Hot-swapped module', { module: moduleName, newVersion: mod.version });
  }

  /** Persist all in-memory modules to the store. */
  async persist(): Promise<void> {
    for (const mod of this.modules.values()) {
      await this.fileStore.write(COLLECTION, mod.id, mod);
    }
    this.logger.debug('Persisted all prompt modules', { count: this.modules.size });
  }
}
