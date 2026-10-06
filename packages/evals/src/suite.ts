import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const weight = z.number().positive().default(1);

export const graderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exact'),
    path: z.string().optional(),
    expected: z.unknown(),
    weight,
  }),
  z.object({
    type: z.literal('one_of'),
    path: z.string().optional(),
    expected: z.array(z.unknown()),
    weight,
  }),
  z.object({ type: z.literal('array_includes'), path: z.string(), value: z.unknown(), weight }),
  z.object({
    type: z.literal('regex'),
    path: z.string().optional(),
    pattern: z.string(),
    flags: z.string().optional(),
    negate: z.boolean().default(false),
    weight,
  }),
  /** Validates the agent's JSON answer. Defaults to the suite's `output_schema`. */
  z.object({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.unknown()).optional(),
    weight,
  }),
  z.object({
    type: z.literal('tool_called'),
    tool: z.string(),
    min: z.number().int().min(1).default(1),
    max: z.number().int().optional(),
    weight,
  }),
  z.object({ type: z.literal('tool_not_called'), tool: z.string(), weight }),
  /** Asks a model to grade the answer against a rubric. Skipped (and flagged) in mock mode. */
  z.object({
    type: z.literal('llm_judge'),
    rubric: z.string(),
    path: z.string().optional(),
    weight,
  }),
]);

export type Grader = z.infer<typeof graderSchema>;

export const caseSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  weight: z.number().positive().default(1),
  input: z.unknown(),
  graders: z.array(graderSchema).min(1),
});

export type EvalCase = z.infer<typeof caseSchema>;

export const gateSchema = z.object({
  /** Largest tolerated absolute drop of the overall score versus the baseline. */
  max_overall_drop: z.number().min(0).default(0.03),
  /** Largest tolerated absolute drop of any category score. */
  max_category_drop: z.number().min(0).default(0.08),
});

export type GateConfig = z.infer<typeof gateSchema>;

export const suiteSchema = z
  .object({
    name: z.string(),
    suite_version: z.number().int().positive(),
    description: z.string().optional(),
    agent: z.string(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    gate: gateSchema.default({ max_overall_drop: 0.03, max_category_drop: 0.08 }),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    for (const c of suite.cases) {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate case id ${c.id}` });
      seen.add(c.id);
    }
  });

export type EvalSuite = z.infer<typeof suiteSchema>;

export function parseSuite(yamlText: string): EvalSuite {
  return suiteSchema.parse(parse(yamlText));
}

export async function loadSuite(path: string): Promise<EvalSuite> {
  return parseSuite(await readFile(path, 'utf8'));
}
