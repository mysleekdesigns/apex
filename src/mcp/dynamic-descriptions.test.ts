import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../utils/file-store.js';
import { PromptModuleRegistry } from './dynamic-descriptions.js';

describe('PromptModuleRegistry', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: PromptModuleRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'apex-test-'));
    fileStore = new FileStore(tmpDir);
    await fileStore.init();
    registry = new PromptModuleRegistry({ fileStore });
    await registry.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a new module and stores it', async () => {
    const mod = await registry.register({
      name: 'apex_recall_description',
      category: 'tool-description',
      content: 'Search your memory for relevant context.',
    });

    expect(mod.id).toBeTruthy();
    expect(mod.name).toBe('apex_recall_description');
    expect(mod.category).toBe('tool-description');
    expect(mod.content).toBe('Search your memory for relevant context.');
    expect(mod.version).toBe(1);
    expect(mod.activeVariantId).toBeNull();
    expect(mod.variants).toEqual([]);
    expect(mod.metrics.totalExposures).toBe(0);
  });

  it('returns base content when no variant is active', async () => {
    await registry.register({
      name: 'test_module',
      category: 'behavior',
      content: 'Base content here.',
    });

    const content = registry.getActiveContent('test_module');
    expect(content).toBe('Base content here.');
  });

  it('returns null for unknown module name', () => {
    expect(registry.getActiveContent('nonexistent')).toBeNull();
  });

  it('adds a variant and returns variant content when set active', async () => {
    await registry.register({
      name: 'test_module',
      category: 'behavior',
      content: 'Original content.',
    });

    const variant = await registry.addVariant('test_module', 'Rephrased content.', 'rephrase');
    expect(variant.id).toBeTruthy();
    expect(variant.mutationType).toBe('rephrase');
    expect(variant.metrics.exposures).toBe(0);

    await registry.setActiveVariant('test_module', variant.id);
    expect(registry.getActiveContent('test_module')).toBe('Rephrased content.');
  });

  it('records exposure and outcome, updating metrics', async () => {
    await registry.register({
      name: 'metric_module',
      category: 'tool-description',
      content: 'Some description.',
    });

    await registry.recordExposure('metric_module');
    await registry.recordOutcome('metric_module', true, 0.8);

    const metrics = registry.getMetrics('metric_module');
    expect(metrics).not.toBeNull();
    expect(metrics!.totalExposures).toBe(1);
    expect(metrics!.successRate).toBe(1);
    expect(metrics!.avgReward).toBe(0.8);
  });

  it('hot-swaps content, increments version, and creates a new variant', async () => {
    const mod = await registry.register({
      name: 'swap_module',
      category: 'behavior',
      content: 'Version 1 content.',
    });

    expect(mod.version).toBe(1);

    await registry.hotSwap('swap_module', 'Version 2 content.');

    const content = registry.getActiveContent('swap_module');
    expect(content).toBe('Version 2 content.');

    const modules = registry.listModules();
    const updated = modules.find((m) => m.name === 'swap_module')!;
    expect(updated.version).toBe(2);
    expect(updated.variants).toHaveLength(1);
    expect(updated.activeVariantId).toBe(updated.variants[0].id);
  });

  it('lists modules and filters by category', async () => {
    await registry.register({ name: 'tool_a', category: 'tool-description', content: 'A' });
    await registry.register({ name: 'behavior_b', category: 'behavior', content: 'B' });
    await registry.register({ name: 'fewshot_c', category: 'few-shot', content: 'C' });

    expect(registry.listModules()).toHaveLength(3);
    expect(registry.getByCategory('tool-description')).toHaveLength(1);
    expect(registry.getByCategory('behavior')).toHaveLength(1);
    expect(registry.getByCategory('few-shot')).toHaveLength(1);
  });

  it('persists and reloads from FileStore', async () => {
    await registry.register({
      name: 'persist_test',
      category: 'tool-description',
      content: 'Persisted content.',
    });

    await registry.addVariant('persist_test', 'Variant content.', 'simplify');
    await registry.persist();

    // Create a fresh registry from the same store
    const registry2 = new PromptModuleRegistry({ fileStore });
    await registry2.init();

    expect(registry2.listModules()).toHaveLength(1);
    const loaded = registry2.listModules()[0];
    expect(loaded.name).toBe('persist_test');
    expect(loaded.variants).toHaveLength(1);
    expect(loaded.content).toBe('Persisted content.');
  });

  it('gets dynamic description for a tool name', async () => {
    await registry.register({
      name: 'apex_recall_description',
      category: 'tool-description',
      content: 'Recall relevant memories for the current task.',
    });

    const desc = registry.getDynamicDescription('apex_recall');
    expect(desc).toBe('Recall relevant memories for the current task.');
    expect(registry.getDynamicDescription('nonexistent_tool')).toBeNull();
  });

  it('records outcome updating both module and variant metrics', async () => {
    await registry.register({
      name: 'dual_metrics',
      category: 'behavior',
      content: 'Base.',
    });

    const variant = await registry.addVariant('dual_metrics', 'V1', 'rephrase');
    await registry.setActiveVariant('dual_metrics', variant.id);

    await registry.recordExposure('dual_metrics');
    await registry.recordOutcome('dual_metrics', true, 1.0);
    await registry.recordExposure('dual_metrics');
    await registry.recordOutcome('dual_metrics', false, 0.0);

    const metrics = registry.getMetrics('dual_metrics');
    expect(metrics!.totalExposures).toBe(2);

    const modules = registry.listModules();
    const mod = modules.find((m) => m.name === 'dual_metrics')!;
    const v = mod.variants.find((vr) => vr.id === variant.id)!;
    expect(v.metrics.successes).toBe(1);
    expect(v.metrics.failures).toBe(1);
    expect(v.metrics.totalReward).toBe(1.0);
    expect(v.metrics.avgReward).toBe(0.5);
  });

  it('handles multiple variants with independent metrics', async () => {
    await registry.register({
      name: 'multi_variant',
      category: 'few-shot',
      content: 'Base example.',
    });

    const v1 = await registry.addVariant('multi_variant', 'Example A', 'add-example');
    const v2 = await registry.addVariant('multi_variant', 'Example B', 'elaborate');

    // Activate v1, record outcomes
    await registry.setActiveVariant('multi_variant', v1.id);
    await registry.recordExposure('multi_variant');
    await registry.recordOutcome('multi_variant', true, 0.9);

    // Switch to v2, record outcomes
    await registry.setActiveVariant('multi_variant', v2.id);
    await registry.recordExposure('multi_variant');
    await registry.recordOutcome('multi_variant', false, 0.1);

    const mod = registry.listModules().find((m) => m.name === 'multi_variant')!;
    const variant1 = mod.variants.find((v) => v.id === v1.id)!;
    const variant2 = mod.variants.find((v) => v.id === v2.id)!;

    expect(variant1.metrics.successes).toBe(1);
    expect(variant1.metrics.failures).toBe(0);
    expect(variant1.metrics.avgReward).toBe(0.9);

    expect(variant2.metrics.successes).toBe(0);
    expect(variant2.metrics.failures).toBe(1);
    expect(variant2.metrics.avgReward).toBe(0.1);
  });
});
