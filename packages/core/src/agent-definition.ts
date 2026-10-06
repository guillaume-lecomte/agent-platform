import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(/^v\d+$/, 'version must look like v1, v2, ...'),
  description: z.string().optional(),
  systemPrompt: z.string().min(1),
  /** Explicit model. Mutually optional with `routing`; neither means "provider default". */
  model: z.string().optional(),
  /** Routing hints consumed by the cost router. */
  routing: z
    .object({
      taskType: z.string(),
      complexity: z.enum(['low', 'medium', 'high']).optional(),
    })
    .optional(),
  tools: z.array(z.string()),
  tokenBudget: z.number().int().positive(),
  maxSteps: z.number().int().positive().default(10),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const activeFileSchema = z.object({
  active: z.string(),
  history: z.array(
    z.object({
      action: z.enum(['initial', 'promote', 'rollback']),
      version: z.string(),
      previous: z.string().nullable(),
      at: z.string(),
      note: z.string().optional(),
    }),
  ),
});

export type ActiveFile = z.infer<typeof activeFileSchema>;

export async function loadAgentDefinition(
  agentDir: string,
  version: string,
): Promise<AgentDefinition> {
  const text = await readFile(join(agentDir, `${version}.yaml`), 'utf8');
  const def = agentDefinitionSchema.parse(parse(text));
  if (def.version !== version) {
    throw new Error(`${version}.yaml declares version ${def.version}`);
  }
  return def;
}

export async function listAgentVersions(agentDir: string): Promise<string[]> {
  const files = await readdir(agentDir);
  return files
    .map((f) => /^(v\d+)\.yaml$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export async function readActiveFile(agentDir: string): Promise<ActiveFile> {
  return activeFileSchema.parse(JSON.parse(await readFile(join(agentDir, 'active.json'), 'utf8')));
}

export async function loadActiveAgentDefinition(agentDir: string): Promise<AgentDefinition> {
  const { active } = await readActiveFile(agentDir);
  return loadAgentDefinition(agentDir, active);
}
