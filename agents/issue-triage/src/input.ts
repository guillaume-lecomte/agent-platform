import { createHash } from 'node:crypto';
import { z } from 'zod';

export const issueInputSchema = z.object({
  number: z.number().int().positive().optional(),
  title: z.string().trim().min(1, 'title is required').max(300),
  body: z.string().max(20_000).default(''),
});

export interface IssueInput {
  number: number;
  title: string;
  body: string;
}

/** Validates an incoming issue. A missing number is derived from the title, deterministically. */
export function parseIssueInput(raw: unknown): IssueInput {
  const parsed = issueInputSchema.parse(raw);
  const number =
    parsed.number ??
    1000 +
      (parseInt(createHash('sha256').update(parsed.title).digest('hex').slice(0, 6), 16) % 9000);
  return { number, title: parsed.title, body: parsed.body };
}

export function renderIssue(raw: unknown): string {
  const issue = parseIssueInput(raw);
  return `Issue #${issue.number}\nTitle: ${issue.title}\n\n${issue.body}`;
}

export const triageOutputSchema = {
  type: 'object',
  required: ['category', 'priority', 'labels', 'comment'],
  properties: {
    category: { enum: ['bug', 'feature', 'question', 'duplicate'] },
    priority: { enum: ['P0', 'P1', 'P2', 'P3'] },
    labels: { type: 'array', items: { type: 'string' } },
    duplicate_of: { type: ['integer', 'null'] },
    comment: { type: 'string', minLength: 1 },
  },
} as const;
