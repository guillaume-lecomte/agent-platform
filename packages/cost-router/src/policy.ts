import type { Complexity, LLMRequest } from '@agent-platform/core';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { PricingTable } from './pricing.js';

const levels = z.object({ medium: z.number().nonnegative(), high: z.number().nonnegative() });
const complexitySchema = z.enum(['low', 'medium', 'high']);

const ruleSchema = z.object({
  name: z.string().min(1),
  when: z.object({
    task_type: z.union([z.string(), z.array(z.string())]).optional(),
    complexity: z.array(complexitySchema).optional(),
  }),
  model: z.string().min(1),
  fallback: z.string().min(1).optional(),
});

export const policySchema = z.object({
  version: z.number().int().positive(),
  default: z.object({ model: z.string().min(1), fallback: z.string().min(1).optional() }),
  timeout_ms: z.number().int().positive().default(30_000),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      ttl_seconds: z.number().int().positive().default(3600),
    })
    .default({ enabled: true, ttl_seconds: 3600 }),
  complexity: z
    .object({ input_chars: levels.optional(), tool_count: levels.optional() })
    .default({}),
  rules: z.array(ruleSchema).default([]),
});

export type RoutingPolicy = z.infer<typeof policySchema>;

export function parsePolicy(yamlText: string): RoutingPolicy {
  return policySchema.parse(parse(yamlText));
}

export async function loadPolicy(path: string): Promise<RoutingPolicy> {
  return parsePolicy(await readFile(path, 'utf8'));
}

/** Every model a policy can pick must have a price, otherwise its cost would be unknown. */
export function modelsOf(policy: RoutingPolicy): string[] {
  const names = new Set<string>([policy.default.model]);
  if (policy.default.fallback) names.add(policy.default.fallback);
  for (const r of policy.rules) {
    names.add(r.model);
    if (r.fallback) names.add(r.fallback);
  }
  return [...names];
}

export function validatePolicy(policy: RoutingPolicy, pricing: PricingTable): void {
  const missing = modelsOf(policy).filter((m) => !pricing.models[m]);
  if (missing.length > 0) {
    throw new Error(
      `routing policy references models with no entry in the pricing file: ${missing.join(', ')}`,
    );
  }
}

const ORDER: Complexity[] = ['low', 'medium', 'high'];
const max = (a: Complexity, b: Complexity): Complexity =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

function level(
  value: number,
  thresholds: { medium: number; high: number } | undefined,
): Complexity {
  if (!thresholds) return 'low';
  if (value >= thresholds.high) return 'high';
  if (value >= thresholds.medium) return 'medium';
  return 'low';
}

export interface ComplexityEstimate {
  complexity: Complexity;
  /** `caller` when given by the request; otherwise the signals that were measured. */
  source: 'caller' | 'estimated';
  inputChars: number;
  toolCount: number;
}

/**
 * Complexity of a request. A caller-provided hint wins. Otherwise: the length of the first
 * user message (the task input) and the number of tools, each compared with the policy
 * thresholds, the highest level wins.
 */
export function estimateComplexity(policy: RoutingPolicy, request: LLMRequest): ComplexityEstimate {
  const first = request.messages.find((m) => m.role === 'user');
  const inputChars = first && 'content' in first ? first.content.length : 0;
  const toolCount = request.tools?.length ?? 0;
  const hint = request.hints?.complexity;
  if (hint) return { complexity: hint, source: 'caller', inputChars, toolCount };
  const complexity = max(
    level(inputChars, policy.complexity.input_chars),
    level(toolCount, policy.complexity.tool_count),
  );
  return { complexity, source: 'estimated', inputChars, toolCount };
}

export interface Route {
  model: string;
  fallback: string | undefined;
  /** Name of the rule that matched, `default`, or `explicit` when the request named a model. */
  rule: string;
  complexity: Complexity;
}

/** Decides which model should answer a request. Pure and deterministic. */
export function decideRoute(policy: RoutingPolicy, request: LLMRequest): Route {
  const { complexity } = estimateComplexity(policy, request);
  if (request.model) {
    const fallback =
      policy.default.fallback && policy.default.fallback !== request.model
        ? policy.default.fallback
        : undefined;
    return { model: request.model, fallback, rule: 'explicit', complexity };
  }
  const taskType = request.hints?.taskType;
  for (const rule of policy.rules) {
    const types = rule.when.task_type === undefined ? undefined : [rule.when.task_type].flat();
    if (types && (taskType === undefined || !types.includes(taskType))) continue;
    if (rule.when.complexity && !rule.when.complexity.includes(complexity)) continue;
    return { model: rule.model, fallback: rule.fallback, rule: rule.name, complexity };
  }
  return {
    model: policy.default.model,
    fallback: policy.default.fallback,
    rule: 'default',
    complexity,
  };
}
