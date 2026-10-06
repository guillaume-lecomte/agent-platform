import { MockProvider, validateJsonSchema, type Message } from '@agent-platform/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryEffectLog,
  containment,
  createIssueTriageTools,
  findSimilar,
  issueTriageResponder,
  parseIssueInput,
  renderIssue,
  resolveIssueTriage,
  tokenize,
  triageOutputSchema,
} from '../src/index.js';

describe('similarity', () => {
  it('tokenizes without stopwords or accents, and stems plurals', () => {
    expect(tokenize('The Café menus are failing!')).toEqual(['cafe', 'menu', 'fail']);
  });

  it('containment is the share of query tokens found, damped below three matches', () => {
    expect(containment('login page fails', 'Login page fails after reset')).toBe(1);
    expect(containment('login fails', 'Login page fails after reset')).toBeCloseTo(2 / 3);
    expect(containment('sync problem', 'tl sync hangs')).toBeCloseTo(1 / 6);
    expect(containment('login fails', 'something unrelated')).toBe(0);
    expect(containment('', 'x')).toBe(0);
  });

  it('finds the original issue of a paraphrased duplicate', async () => {
    const [top] = await findSimilar('HTTP 500 on the login page right after I reset my password');
    expect(top?.number).toBe(101);
    expect(top?.similarity).toBeGreaterThanOrEqual(0.5);
  });
});

describe('input', () => {
  it('derives a stable issue number when none is given', () => {
    const a = parseIssueInput({ title: 'Same title' });
    expect(a.number).toBe(parseIssueInput({ title: 'Same title', body: 'x' }).number);
    expect(a.number).toBeGreaterThanOrEqual(1000);
    expect(a.body).toBe('');
  });

  it('rejects an empty title', () => {
    expect(() => parseIssueInput({ title: '  ' })).toThrow();
  });

  it('renders the format the model (and the mock) read', () => {
    expect(renderIssue({ number: 7, title: 'T', body: 'B' })).toBe('Issue #7\nTitle: T\n\nB');
  });
});

describe('tools', () => {
  it('exposes the platform risk convention: only search is free of approval', () => {
    const tools = createIssueTriageTools(new InMemoryEffectLog());
    expect(Object.fromEntries(tools.map((t) => [t.name, t.risk]))).toEqual({
      search_similar_issues: 'read',
      add_labels: 'reversible',
      post_comment: 'destructive',
    });
  });

  it('records effects with the idempotency key of the call', async () => {
    const log = new InMemoryEffectLog();
    const [, addLabels, postComment] = createIssueTriageTools(log);
    await addLabels!.execute(
      { issue_number: 5, labels: ['bug'] },
      { taskId: 't1', idempotencyKey: 'k1' },
    );
    await postComment!.execute(
      { issue_number: 5, body: 'hi' },
      { taskId: 't1', idempotencyKey: 'k2' },
    );
    expect(log.effects.map((e) => [e.tool, e.idempotencyKey, e.taskId])).toEqual([
      ['add_labels', 'k1', 't1'],
      ['post_comment', 'k2', 't1'],
    ]);
  });
});

async function triage(
  version: string,
  model: string,
  issue: { number: number; title: string; body: string },
) {
  const runtime = await resolveIssueTriage(version);
  const provider = new MockProvider({ responder: issueTriageResponder });
  const messages: Message[] = [
    { role: 'system', content: runtime.definition.systemPrompt },
    { role: 'user', content: renderIssue(issue) },
  ];
  const tools: string[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await provider.complete({ model, messages });
    messages.push({
      role: 'assistant',
      content: res.content,
      ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}),
    });
    if (res.toolCalls.length === 0)
      return { answer: JSON.parse(res.content) as Record<string, unknown>, tools };
    for (const call of res.toolCalls) {
      tools.push(call.name);
      const tool = runtime.tools.find((t) => t.name === call.name)!;
      const out = await tool.execute(call.arguments, { idempotencyKey: `${i}` });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(out),
      });
    }
  }
  throw new Error('agent did not finish');
}

describe('mock model (a test double, see responder.ts)', () => {
  const dup = {
    number: 900,
    title: 'HTTP 500 on the login page right after I reset my password',
    body: 'Reset link used, now login answers 500.',
  };
  const crash = {
    number: 901,
    title: 'Server crashes on startup after upgrading',
    body: 'Nobody can log in. All users are locked out.',
  };

  it('follows v1: searches first, detects duplicates, applies the rubric, answers with valid JSON', async () => {
    const d = await triage('v1', 'mock-large', dup);
    expect(d.tools).toEqual(['search_similar_issues', 'add_labels', 'post_comment']);
    expect(d.answer).toMatchObject({ category: 'duplicate', duplicate_of: 101 });
    expect(validateJsonSchema(triageOutputSchema, d.answer).valid).toBe(true);

    const c = await triage('v1', 'mock-large', crash);
    expect(c.answer).toMatchObject({ category: 'bug', priority: 'P0' });
  });

  it('follows v2: no search, so duplicates are missed, and every priority is P2', async () => {
    const d = await triage('v2', 'mock-large', dup);
    expect(d.tools).toEqual(['add_labels', 'post_comment']);
    expect(d.answer.category).not.toBe('duplicate');
    expect((await triage('v2', 'mock-large', crash)).answer.priority).toBe('P2');
  });

  it('the small model reads less of the issue than the large one', async () => {
    const longBody = {
      number: 902,
      title: 'Sync problem',
      body: `${'Some context. '.repeat(20)}The sync fails and tasks are permanently lost. This is data loss.`,
    };
    expect((await triage('v1', 'mock-large', longBody)).answer.priority).toBe('P0');
    expect((await triage('v1', 'mock-small', longBody)).answer.priority).not.toBe('P0');
  });

  it('is deterministic', async () => {
    expect(await triage('v1', 'mock-large', crash)).toEqual(
      await triage('v1', 'mock-large', crash),
    );
  });
});
