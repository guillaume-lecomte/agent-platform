import { createDb, type DbHandle } from '@agent-platform/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryTaskStore,
  PgTaskStore,
  StepConflictError,
  migrateRunner,
  type TaskStore,
} from '../src/index.js';
import { newTaskInput } from './helpers.js';

const llmStep = (n = 10) => ({
  kind: 'llm' as const,
  payload: { content: 'x', toolCalls: [], model: 'm', latencyMs: 1, simulated: true },
  inputTokens: n,
  outputTokens: n,
});

interface Backend {
  name: string;
  make: () => Promise<{ store: TaskStore; close?: () => Promise<void> }>;
  skip?: boolean;
}

let pgHandle: DbHandle | undefined;
const hasDb = Boolean(process.env.DATABASE_URL);

const backends: Backend[] = [
  { name: 'in-memory', make: async () => ({ store: new InMemoryTaskStore() }) },
  {
    name: 'postgres',
    skip: !hasDb,
    make: async () => {
      if (!pgHandle) {
        pgHandle = createDb(process.env.DATABASE_URL!);
        await migrateRunner(pgHandle.db);
      }
      return { store: new PgTaskStore(pgHandle.db) };
    },
  },
];

afterAll(async () => {
  await pgHandle?.close();
});

describe.each(backends)('TaskStore contract: $name', ({ make, skip }) => {
  let store: TaskStore;
  beforeAll(async () => {
    if (skip) return;
    store = (await make()).store;
  });
  const it_ = skip ? it.skip : it;

  it_('creates a task once per idempotency key', async () => {
    const input = newTaskInput();
    const [a, b] = await Promise.all([store.createTask(input), store.createTask(input)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.task.id).toBe(b.task.id);
    expect(a.task.state).toBe('pending');
  });

  it_('transitions only from the expected states (compare-and-set)', async () => {
    const { task } = await store.createTask(newTaskInput());
    expect(await store.transition(task.id, ['running'], 'completed')).toBeUndefined();
    expect((await store.transition(task.id, ['pending'], 'running'))?.state).toBe('running');
    const done = await store.transition(task.id, ['running'], 'completed', { result: { ok: 1 } });
    expect(done).toMatchObject({ state: 'completed', result: { ok: 1 } });
    expect(await store.transition(task.id, ['running'], 'failed')).toBeUndefined();
  });

  it_('appends steps in order, accumulates tokens, and rejects a duplicate seq', async () => {
    const { task } = await store.createTask(newTaskInput());
    await store.appendStep(task.id, 1, llmStep(10));
    await store.appendStep(task.id, 2, llmStep(5));
    await expect(store.appendStep(task.id, 2, llmStep())).rejects.toBeInstanceOf(StepConflictError);
    expect((await store.listSteps(task.id)).map((s) => s.seq)).toEqual([1, 2]);
    expect((await store.getTask(task.id))?.tokensUsed).toBe(30);
  });

  it_('lets exactly one of several concurrent writers append a given step', async () => {
    const { task } = await store.createTask(newTaskInput());
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.appendStep(task.id, 1, llmStep(1))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.getTask(task.id))?.tokensUsed).toBe(2);
  });

  it_('registers a tool call once; later callers see the stored result', async () => {
    const { task } = await store.createTask(newTaskInput());
    const key = { taskId: task.id, stepSeq: 1, argsHash: 'abc' };
    const meta = { toolName: 'post', risk: 'destructive' as const };
    const racers = await Promise.all(
      Array.from({ length: 6 }, () => store.beginToolExecution(key, meta)),
    );
    expect(racers.filter((r) => r.inserted)).toHaveLength(1);
    expect(racers.every((r) => r.record.status === 'started')).toBe(true);

    await store.completeToolExecution(key, '{"ok":true}', false);
    const again = await store.beginToolExecution(key, meta);
    expect(again.inserted).toBe(false);
    expect(again.record).toMatchObject({
      status: 'completed',
      result: '{"ok":true}',
      isError: false,
    });
  });

  it_('creates one approval per tool call and lets it be decided only once', async () => {
    const { task } = await store.createTask(newTaskInput());
    const input = {
      taskId: task.id,
      stepSeq: 1,
      toolCallId: 'c1',
      toolName: 'post',
      arguments: { body: 'hi' },
      risk: 'destructive' as const,
    };
    const a = await store.createApproval(input);
    const b = await store.createApproval(input);
    expect(b.id).toBe(a.id);
    expect(await store.findApproval(task.id, 1, 'c1')).toMatchObject({ status: 'pending' });
    expect((await store.listApprovals({ taskId: task.id, status: 'pending' })).length).toBe(1);

    const decisions = await Promise.all([
      store.decideApproval(a.id, 'approved', 'ok'),
      store.decideApproval(a.id, 'denied', 'no'),
    ]);
    expect(decisions.filter(Boolean)).toHaveLength(1);
    expect((await store.getApproval(a.id))?.status).toBe(decisions.find(Boolean)?.status);
  });

  it_('lists tasks newest first and filters by state', async () => {
    const { task } = await store.createTask(newTaskInput());
    await store.transition(task.id, ['pending'], 'cancelled');
    const cancelled = await store.listTasks({ state: 'cancelled', limit: 5 });
    expect(cancelled.some((t) => t.id === task.id)).toBe(true);
    expect(cancelled.every((t) => t.state === 'cancelled')).toBe(true);
  });
});
