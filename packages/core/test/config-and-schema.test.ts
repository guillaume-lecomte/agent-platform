import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  MockProvider,
  createProvider,
  listAgentVersions,
  loadActiveAgentDefinition,
  loadAgentDefinition,
  loadConfig,
  validateJsonSchema,
} from '../src/index.js';

describe('loadConfig', () => {
  it('defaults to the mock provider with no keys', () => {
    const cfg = loadConfig({});
    expect(cfg.LLM_PROVIDER).toBe('mock');
    expect(createProvider(cfg)).toBeInstanceOf(MockProvider);
  });

  it('does not switch to a real provider just because a key exists', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(cfg.LLM_PROVIDER).toBe('mock');
  });

  it('rejects a real provider without its key', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: '  ' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('coerces numbers and validates enums', () => {
    expect(loadConfig({ PORT: '4000' }).PORT).toBe(4000);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });
});

describe('validateJsonSchema', () => {
  const schema = {
    type: 'object',
    required: ['category'],
    properties: { category: { enum: ['bug', 'feature'] } },
    additionalProperties: false,
  };
  it('accepts and rejects with readable errors', () => {
    expect(validateJsonSchema(schema, { category: 'bug' }).valid).toBe(true);
    const bad = validateJsonSchema(schema, { category: 'nope', extra: 1 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe('agent definitions', () => {
  it('loads versions and the active pointer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    const def = (v: string) =>
      `id: demo\nversion: ${v}\nsystemPrompt: hi\ntools: [a]\ntokenBudget: 1000\n`;
    await writeFile(join(dir, 'v1.yaml'), def('v1'));
    await writeFile(join(dir, 'v2.yaml'), def('v2'));
    await writeFile(
      join(dir, 'active.json'),
      JSON.stringify({
        active: 'v2',
        history: [{ action: 'initial', version: 'v2', previous: null, at: '2026-01-01T00:00:00Z' }],
      }),
    );
    expect(await listAgentVersions(dir)).toEqual(['v1', 'v2']);
    expect((await loadAgentDefinition(dir, 'v1')).maxSteps).toBe(10);
    expect((await loadActiveAgentDefinition(dir)).version).toBe('v2');
  });

  it('rejects a file whose declared version does not match its name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-'));
    await writeFile(
      join(dir, 'v1.yaml'),
      'id: d\nversion: v2\nsystemPrompt: x\ntools: []\ntokenBudget: 1\n',
    );
    await expect(loadAgentDefinition(dir, 'v1')).rejects.toThrow(/declares version v2/);
  });
});
