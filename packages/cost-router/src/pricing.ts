import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const modelPriceSchema = z.object({
  provider: z.string().min(1),
  /** Price per `per_tokens` input tokens. */
  input: z.number().nonnegative(),
  /** Price per `per_tokens` output tokens. */
  output: z.number().nonnegative(),
  /** Where the price comes from. Mandatory: a price without a source is a guess. */
  source: z.string().min(1),
  /** ISO date the price was read at the source. Mandatory. */
  retrieved: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)),
  /** True for the mock provider: prices are illustrative and costs are simulated. */
  simulated: z.boolean().default(false),
  simulation: z
    .object({
      latency_base_ms: z.number().nonnegative(),
      latency_ms_per_output_token: z.number().nonnegative(),
    })
    .optional(),
});

export const pricingSchema = z.object({
  version: z.number().int().positive(),
  updated: z.coerce.date().transform((d) => d.toISOString().slice(0, 10)),
  currency: z.string().default('USD'),
  per_tokens: z.number().int().positive().default(1_000_000),
  models: z.record(z.string(), modelPriceSchema),
});

export type PricingTable = z.infer<typeof pricingSchema>;
export type ModelPrice = PricingTable['models'][string];

export function parsePricing(yamlText: string): PricingTable {
  return pricingSchema.parse(parse(yamlText));
}

export async function loadPricing(path: string): Promise<PricingTable> {
  return parsePricing(await readFile(path, 'utf8'));
}

export function priceOf(pricing: PricingTable, model: string): ModelPrice | undefined {
  return pricing.models[model];
}

/** Cost in `currency`, or undefined when the model has no price (cost is then unknown, not zero). */
export function computeCost(
  pricing: PricingTable,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | undefined {
  const price = priceOf(pricing, model);
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / pricing.per_tokens;
}

/** Whole days between the price date of the oldest entry and `now`. */
export function pricingAgeDays(pricing: PricingTable, now = new Date()): number {
  const oldest = Object.values(pricing.models)
    .map((m) => Date.parse(m.retrieved))
    .reduce((a, b) => Math.min(a, b), Date.now());
  return Math.floor((now.getTime() - oldest) / 86_400_000);
}

/** Simulated latency of mock models, derived from `simulation` in the pricing file. */
export function mockLatencyFromPricing(
  pricing: PricingTable,
): (model: string, usage: { outputTokens: number }) => number {
  return (model, usage) => {
    const sim = priceOf(pricing, model)?.simulation;
    return sim
      ? Math.round(sim.latency_base_ms + sim.latency_ms_per_output_token * usage.outputTokens)
      : 0;
  };
}
