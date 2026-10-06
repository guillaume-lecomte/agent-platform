import type { AnyTool, Tool } from '@agent-platform/core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { EffectLog } from './effects.js';
import { containment } from './similarity.js';

export interface ExistingIssue {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
}

export const agentDir = fileURLToPath(new URL('..', import.meta.url));

let corpus: Promise<ExistingIssue[]> | undefined;
export function loadExistingIssues(): Promise<ExistingIssue[]> {
  corpus ??= readFile(`${agentDir}data/existing-issues.json`, 'utf8').then(
    (t) => JSON.parse(t) as ExistingIssue[],
  );
  return corpus;
}

export interface SimilarIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  similarity: number;
}

/** Ranks the issue corpus against a query. Exported for the mock model's tests. */
export async function findSimilar(query: string, limit = 3): Promise<SimilarIssue[]> {
  const issues = await loadExistingIssues();
  return issues
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      similarity: Math.round(containment(query, `${i.title} ${i.body}`) * 100) / 100,
    }))
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.number - b.number)
    .slice(0, limit);
}

/**
 * Simulated GitHub tools. They work on a local corpus and a local effect log, so the demo
 * needs no network and no credentials. Risk levels follow the platform convention: the two
 * tools with effects require human approval.
 */
export function createIssueTriageTools(effects: EffectLog): AnyTool[] {
  const search: Tool<{ query: string; limit?: number }> = {
    name: 'search_similar_issues',
    description:
      'Search existing issues similar to a text query. Returns candidates with a similarity score.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    risk: 'read',
    async execute({ query, limit }) {
      return { results: await findSimilar(query, limit ?? 3) };
    },
  };

  const addLabels: Tool<{ issue_number: number; labels: string[] }> = {
    name: 'add_labels',
    description: 'Add labels to an issue.',
    inputSchema: {
      type: 'object',
      required: ['issue_number', 'labels'],
      properties: {
        issue_number: { type: 'integer' },
        labels: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
    risk: 'reversible',
    async execute(input, ctx) {
      await effects.record({
        idempotencyKey: ctx.idempotencyKey,
        taskId: ctx.taskId,
        tool: 'add_labels',
        issueNumber: input.issue_number,
        payload: { labels: input.labels },
      });
      return { issue_number: input.issue_number, labels: input.labels };
    },
  };

  const postComment: Tool<{ issue_number: number; body: string }> = {
    name: 'post_comment',
    description: 'Post a comment on an issue. A posted comment cannot be unsent.',
    inputSchema: {
      type: 'object',
      required: ['issue_number', 'body'],
      properties: { issue_number: { type: 'integer' }, body: { type: 'string', minLength: 1 } },
    },
    risk: 'destructive',
    async execute(input, ctx) {
      await effects.record({
        idempotencyKey: ctx.idempotencyKey,
        taskId: ctx.taskId,
        tool: 'post_comment',
        issueNumber: input.issue_number,
        payload: { body: input.body },
      });
      return { issue_number: input.issue_number, posted: true };
    },
  };

  return [search, addLabels, postComment];
}
