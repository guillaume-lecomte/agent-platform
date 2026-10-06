import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeCost,
  decideRoute,
  estimateComplexity,
  loadPolicy,
  loadPricing,
  mockLatencyFromPricing,
  modelsOf,
  parsePolicy,
  parsePricing,
  pricingAgeDays,
  validatePolicy,
} from '../src/index.js';
import { policy, pricing, user } from './helpers.js';

const repoConfig = (file: string): string =>
  fileURLToPath(new URL(`../../../config/${file}`, import.meta.url));

describe('pricing', () => {
  it('computes cost from per-million prices', () => {
    expect(computeCost(pricing, 'big', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(10);
    expect(computeCost(pricing, 'big', { inputTokens: 2000, outputTokens: 500 })).toBeCloseTo(
      0.045,
    );
  });

  it('returns undefined (unknown, not zero) for a model without a price', () => {
    expect(computeCost(pricing, 'mystery', { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });

  it('requires a source and a retrieval date for every model', () => {
    const base =
      'version: 1\nupdated: 2026-01-01\nmodels:\n  m: { provider: p, input: 1, output: 1';
    expect(() => parsePricing(`${base}, retrieved: 2026-01-01 }`)).toThrow(); // no source
    expect(() => parsePricing(`${base}, source: x }`)).toThrow(); // no date
    expect(() => parsePricing('version: 1\nmodels: {}')).toThrow(); // no file date
    expect(() => parsePricing(`${base}, source: x, retrieved: 2026-01-01 }`)).not.toThrow();
  });

  it('measures how old the oldest price is', () => {
    expect(pricingAgeDays(pricing, new Date('2026-10-11T00:00:00Z'))).toBe(10);
  });

  it('derives simulated latency from the pricing file, not from code', () => {
    const p = parsePricing(`
version: 1
updated: 2026-01-01
models:
  fast: { provider: mock, simulated: true, input: 1, output: 1, source: s, retrieved: 2026-01-01, simulation: { latency_base_ms: 100, latency_ms_per_output_token: 2 } }
  real: { provider: x, input: 1, output: 1, source: s, retrieved: 2026-01-01 }
`);
    const latency = mockLatencyFromPricing(p);
    expect(latency('fast', { outputTokens: 50 })).toBe(200);
    expect(latency('real', { outputTokens: 50 })).toBe(0);
  });

  it('the committed pricing file is valid, dated and sourced; mock entries are flagged simulated', async () => {
    const real = await loadPricing(repoConfig('pricing.yaml'));
    expect(real.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [name, m] of Object.entries(real.models)) {
      expect(m.source.length, name).toBeGreaterThan(5);
      expect(m.retrieved, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.simulated, name).toBe(m.provider === 'mock');
    }
  });
});

describe('routing policy', () => {
  it('every committed policy only references priced models', async () => {
    const real = await loadPricing(repoConfig('pricing.yaml'));
    for (const file of ['routing.yaml', 'routing.anthropic.yaml']) {
      const p = await loadPolicy(repoConfig(file));
      expect(() => validatePolicy(p, real), file).not.toThrow();
    }
  });

  it('rejects a policy that references an unpriced model', () => {
    const p = parsePolicy('version: 1\ndefault: { model: ghost }');
    expect(() => validatePolicy(p, pricing)).toThrow(/ghost/);
    expect(modelsOf(policy).sort()).toEqual(['big', 'other', 'small']);
  });

  describe('complexity estimation', () => {
    const req = (text: string, extra: object = {}) => ({ messages: user(text), ...extra });

    it('uses the length of the first user message', () => {
      expect(estimateComplexity(policy, req('x'.repeat(50))).complexity).toBe('low');
      expect(estimateComplexity(policy, req('x'.repeat(100))).complexity).toBe('medium');
      expect(estimateComplexity(policy, req('x'.repeat(500))).complexity).toBe('high');
    });

    it('uses the number of tools, and the highest signal wins', () => {
      const tools = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ name: `t${i}`, description: '', inputSchema: {} }));
      expect(estimateComplexity(policy, req('short', { tools: tools(3) })).complexity).toBe(
        'medium',
      );
      expect(estimateComplexity(policy, req('x'.repeat(600), { tools: tools(1) })).complexity).toBe(
        'high',
      );
      expect(estimateComplexity(policy, req('x'.repeat(120), { tools: tools(6) })).complexity).toBe(
        'high',
      );
    });

    it('a complexity given by the caller overrides the estimate', () => {
      const est = estimateComplexity(
        policy,
        req('x'.repeat(900), { hints: { complexity: 'low' } }),
      );
      expect(est).toMatchObject({ complexity: 'low', source: 'caller', inputChars: 900 });
    });
  });

  describe('decideRoute', () => {
    const req = (text: string, hints = {}, model?: string) => ({
      messages: user(text),
      hints,
      ...(model ? { model } : {}),
    });

    it('matches on task type and complexity, in order', () => {
      expect(decideRoute(policy, req('short', { taskType: 'triage' }))).toMatchObject({
        model: 'small',
        fallback: 'big',
        rule: 'easy-triage',
        complexity: 'low',
      });
      expect(decideRoute(policy, req('x'.repeat(200), { taskType: 'triage' }))).toMatchObject({
        model: 'big',
        rule: 'default',
        complexity: 'medium',
      });
    });

    it('accepts a list of task types and no complexity condition', () => {
      expect(decideRoute(policy, req('x'.repeat(900), { taskType: 'b' })).model).toBe('other');
    });

    it('falls back to the default when the task type is missing or unknown', () => {
      expect(decideRoute(policy, req('short')).rule).toBe('default');
      expect(decideRoute(policy, req('short', { taskType: 'zzz' })).rule).toBe('default');
    });

    it('honours an explicit model, keeping the default fallback unless it is the same model', () => {
      expect(decideRoute(policy, req('s', { taskType: 'triage' }, 'other'))).toMatchObject({
        model: 'other',
        rule: 'explicit',
        fallback: 'small',
      });
      expect(decideRoute(policy, req('s', {}, 'small')).fallback).toBeUndefined();
    });
  });
});
