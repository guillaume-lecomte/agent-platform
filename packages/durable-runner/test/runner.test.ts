import { LLMError } from '@agent-platform/core';
import { describe, expect, it } from 'vitest';
import { InMemoryTaskStore, type TaskStep, type ToolStepPayload } from '../src/index.js';
import { countingTools, newTaskInput, scripted, setup } from './helpers.js';

const toolSteps = (steps: TaskStep[]): ToolStepPayload[] =>
  steps.filter((s) => s.kind === 'tool').map((s) => s.payload as ToolStepPayload);

describe('AgentRunner: normal execution', () => {
  it('runs a read tool then finishes with the final answer', async () => {
    const env = setup({
      provider: scripted([
        { toolCalls: [{ name: 'lookup', arguments: { q: 'crash' } }] },
        { content: '{"category":"bug"}' },
      ]),
    });
    const { task } = await env.store.createTask(newTaskInput());
    const { state } = await env.runner.advance(task.id);
    expect(state).toBe('completed');
    const done = await env.store.getTask(task.id);
    expect(done?.result).toEqual({ text: '{"category":"bug"}', json: { category: 'bug' } });
    expect(done?.tokensUsed).toBeGreaterThan(0);
    expect(env.tools.counts.lookup).toBe(1);
    expect((await env.store.listSteps(task.id)).map((s) => s.kind)).toEqual(['llm', 'tool', 'llm']);
    expect(env.events.map((e) => e.type)).toEqual([
      'task.started',
      'task.step',
      'task.step',
      'task.step',
      'task.completed',
    ]);
  });

  it('tells the model when it calls an unknown tool or passes bad arguments', async () => {
    const env = setup({
      provider: scripted([
        {
          toolCalls: [
            { name: 'nope', arguments: {} },
            { name: 'lookup', arguments: { wrong: 1 } },
          ],
        },
        { content: 'ok' },
      ]),
    });
    const { task } = await env.store.createTask(newTaskInput());
    await env.runner.advance(task.id);
    const results = toolSteps(await env.store.listSteps(task.id));
    expect(results.map((r) => r.outcome)).toEqual(['rejected', 'rejected']);
    expect(results[0]?.content).toContain('Unknown tool');
    expect(results[1]?.content).toContain('Invalid arguments');
    expect(env.tools.counts.lookup).toBe(0);
  });

  it('fails the task when the agent loops past maxSteps', async () => {
    const env = setup({
      provider: scripted([{ toolCalls: [{ name: 'lookup', arguments: { q: 'x' } }] }]),
      def: { maxSteps: 3 },
    });
    const { task } = await env.store.createTask(newTaskInput());
    expect((await env.runner.advance(task.id)).state).toBe('failed');
    expect((await env.store.getTask(task.id))?.error).toContain('maxSteps');
  });
});

describe('AgentRunner: human approval', () => {
  const effectful = scripted([
    { toolCalls: [{ name: 'post', arguments: { body: 'thanks' } }] },
    { content: 'posted' },
  ]);

  it('suspends before an effectful tool and runs it exactly once after approval', async () => {
    const env = setup({ provider: effectful });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    expect((await env.runner.advance(task.id)).state).toBe('awaiting_approval');
    expect(env.tools.counts.post).toBe(0);

    const [approval] = await env.service.listApprovals({ status: 'pending' });
    expect(approval).toMatchObject({ toolName: 'post', risk: 'destructive', status: 'pending' });

    await env.service.approve(approval!.id, 'looks fine');
    expect(env.queued.at(-1)).toBe(task.id);
    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.post).toBe(1);
    expect(toolSteps(await env.store.listSteps(task.id))[0]?.outcome).toBe('executed');
  });

  it('returns a refusal to the agent as the tool result, with the reason', async () => {
    const env = setup({ provider: effectful });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const [approval] = await env.service.listApprovals({ status: 'pending' });
    await env.service.deny(approval!.id, 'tone is wrong');
    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.post).toBe(0);
    const [result] = toolSteps(await env.store.listSteps(task.id));
    expect(result).toMatchObject({ outcome: 'denied', isError: true });
    expect(result?.content).toContain('tone is wrong');
  });

  it('rejects a second decision on the same approval', async () => {
    const env = setup({ provider: effectful });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const [approval] = await env.service.listApprovals({ status: 'pending' });
    await env.service.approve(approval!.id);
    await expect(env.service.deny(approval!.id, 'too late')).rejects.toThrow(/already approved/);
    expect(env.queued.filter((id) => id === task.id)).toHaveLength(2); // create + one approve
  });

  it('does nothing when advanced while still awaiting approval', async () => {
    const env = setup({ provider: effectful });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const stepsBefore = (await env.store.listSteps(task.id)).length;
    expect((await env.runner.advance(task.id)).state).toBe('awaiting_approval');
    expect(await env.store.listSteps(task.id)).toHaveLength(stepsBefore);
  });
});

describe('AgentRunner: crash recovery', () => {
  it('resumes from the last checkpoint without replaying finished steps', async () => {
    const provider = scripted([
      { toolCalls: [{ name: 'lookup', arguments: { q: 'a' } }] },
      { toolCalls: [{ name: 'lookup', arguments: { q: 'b' } }] },
      { content: 'finished' },
    ]);
    // The "process" dies (non-LLM error) on the 3rd model call.
    const real = provider.complete.bind(provider);
    let calls = 0;
    provider.complete = async (req) => {
      calls += 1;
      if (calls === 3) throw new Error('worker killed');
      return real(req);
    };
    const env = setup({ provider });
    const { task } = await env.store.createTask(newTaskInput());

    await expect(env.runner.advance(task.id)).rejects.toThrow('worker killed');
    expect((await env.store.getTask(task.id))?.state).toBe('running');
    expect((await env.store.listSteps(task.id)).map((s) => s.kind)).toEqual([
      'llm',
      'tool',
      'llm',
      'tool',
    ]);

    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.lookup).toBe(2); // not 4: finished tools were not re-run
    expect(calls).toBe(4); // 2 finished model calls were not repeated; the 3rd was retried once
    expect(env.events.map((e) => e.type)).toContain('task.resumed');
  });

  it('never runs an effectful tool twice, even if the crash hits between the effect and its checkpoint', async () => {
    class CrashAfterEffect extends InMemoryTaskStore {
      armed = true;
      override async appendStep(...args: Parameters<InMemoryTaskStore['appendStep']>) {
        if (this.armed && args[2].kind === 'tool') {
          this.armed = false;
          throw new Error('crash after tool ran, before checkpoint');
        }
        return super.appendStep(...args);
      }
    }
    const env = setup({
      store: new CrashAfterEffect(),
      provider: scripted([
        { toolCalls: [{ name: 'post', arguments: { body: 'hi' } }] },
        { content: 'ok' },
      ]),
    });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const [approval] = await env.service.listApprovals({ status: 'pending' });
    await env.service.approve(approval!.id);

    await expect(env.runner.advance(task.id)).rejects.toThrow('crash after tool ran');
    expect(env.tools.counts.post).toBe(1);

    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.post).toBe(1); // the registry supplied the stored result
    expect(toolSteps(await env.store.listSteps(task.id))[0]?.outcome).toBe('replayed');
    expect(env.tools.keys).toHaveLength(1);
  });

  it('does not re-run an effectful tool whose outcome is unknown, and tells the agent', async () => {
    const env = setup({
      provider: scripted([
        { toolCalls: [{ name: 'post', arguments: { body: 'hi' } }] },
        { content: 'ok' },
      ]),
    });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const [approval] = await env.service.listApprovals({ status: 'pending' });
    await env.service.approve(approval!.id);

    // Simulate a previous run that began the call and died before recording a result.
    const { canonicalJson, sha256 } = await import('@agent-platform/core');
    await env.store.beginToolExecution(
      {
        taskId: task.id,
        stepSeq: 1,
        argsHash: sha256(canonicalJson({ name: 'post', arguments: { body: 'hi' } })),
      },
      { toolName: 'post', risk: 'destructive' },
    );

    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.post).toBe(0);
    const [result] = toolSteps(await env.store.listSteps(task.id));
    expect(result).toMatchObject({ outcome: 'unknown', isError: true });
  });

  it('re-runs a read tool that was interrupted (safe to repeat)', async () => {
    const env = setup({
      provider: scripted([
        { toolCalls: [{ name: 'lookup', arguments: { q: 'a' } }] },
        { content: 'ok' },
      ]),
    });
    const { task } = await env.store.createTask(newTaskInput());
    const { canonicalJson, sha256 } = await import('@agent-platform/core');
    // First run: model call recorded, tool call started but never completed.
    await env.store.appendStep(task.id, 1, {
      kind: 'llm',
      payload: {
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'a' } }],
        model: 'm',
        latencyMs: 1,
        simulated: true,
      },
      inputTokens: 5,
      outputTokens: 5,
    });
    await env.store.beginToolExecution(
      {
        taskId: task.id,
        stepSeq: 1,
        argsHash: sha256(canonicalJson({ name: 'lookup', arguments: { q: 'a' } })),
      },
      { toolName: 'lookup', risk: 'read' },
    );
    expect((await env.runner.advance(task.id)).state).toBe('completed');
    expect(env.tools.counts.lookup).toBe(1);
  });

  it('stops quietly when another worker already wrote the step', async () => {
    class RacingStore extends InMemoryTaskStore {
      override async appendStep(...args: Parameters<InMemoryTaskStore['appendStep']>) {
        // The other worker wins the race for this seq.
        await super.appendStep(args[0], args[1], {
          kind: 'llm',
          payload: { content: 'other', toolCalls: [], model: 'm', latencyMs: 0, simulated: true },
        });
        return super.appendStep(...args);
      }
    }
    const env = setup({ store: new RacingStore() });
    const { task } = await env.store.createTask(newTaskInput());
    await expect(env.runner.advance(task.id)).resolves.toBeDefined();
    expect((await env.store.listSteps(task.id)).filter((s) => s.seq === 1)).toHaveLength(1);
  });
});

describe('AgentRunner: retries', () => {
  it('retries transient errors with exponential backoff and then succeeds', async () => {
    const delays: number[] = [];
    const provider = scripted([{ content: 'ok' }]);
    provider.failNext(new LLMError('rate_limit', '429'), new LLMError('overloaded', '529'));
    const env = setup({ provider });
    // Rebuild the runner with a recording sleep so delays are observable.
    const { AgentRunner } = await import('../src/index.js');
    const runner = new AgentRunner({
      store: env.store,
      provider,
      resolver: async () => ({
        definition: {
          id: 't',
          version: 'v1',
          systemPrompt: 's',
          tools: [],
          tokenBudget: 1e6,
          maxSteps: 5,
        },
        tools: [],
      }),
      bus: env.bus,
      logger: (await import('./helpers.js')).logger,
      retry: {
        baseDelayMs: 100,
        factor: 2,
        jitter: false,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });
    const { task } = await env.store.createTask(newTaskInput());
    expect((await runner.advance(task.id)).state).toBe('completed');
    expect(delays).toEqual([100, 200]);
    expect(env.events.filter((e) => e.type === 'task.retry')).toHaveLength(2);
  });

  it('fails the task for good on a non-recoverable error, without retrying', async () => {
    const provider = scripted([{ content: 'ok' }]);
    provider.failNext(new LLMError('authentication', 'bad key'));
    const env = setup({ provider });
    const { task } = await env.store.createTask(newTaskInput());
    expect((await env.runner.advance(task.id)).state).toBe('failed');
    expect(provider.callCount).toBe(1);
    expect((await env.store.getTask(task.id))?.error).toContain('authentication');
  });

  it('fails the task once transient retries are exhausted', async () => {
    const provider = scripted([{ content: 'ok' }]);
    provider.failNext(...Array.from({ length: 10 }, () => new LLMError('timeout', 'slow')));
    const env = setup({ provider });
    const { task } = await env.store.createTask(newTaskInput());
    expect((await env.runner.advance(task.id)).state).toBe('failed');
    expect(provider.callCount).toBe(4); // default maxAttempts
    expect((await env.store.getTask(task.id))?.error).toContain('retries exhausted');
  });
});

describe('AgentRunner: token budget', () => {
  it('stops cleanly as budget_exceeded once the ceiling is reached, before any new work', async () => {
    const tools = countingTools();
    const env = setup({
      tools,
      provider: scripted([{ toolCalls: [{ name: 'lookup', arguments: { q: 'a' } }] }]),
    });
    // Big enough for the first call, too small for a second.
    const { task } = await env.store.createTask(newTaskInput({ tokenBudget: 150 }));
    expect((await env.runner.advance(task.id)).state).toBe('budget_exceeded');
    const done = await env.store.getTask(task.id);
    expect(done?.error).toMatch(/budget/i);
    expect(env.provider.callCount).toBeLessThanOrEqual(1);
    expect(tools.counts.post).toBe(0);
  });

  it('refuses a model call it knows cannot fit the remaining budget', async () => {
    const env = setup({});
    const { task } = await env.store.createTask(newTaskInput({ tokenBudget: 5 }));
    expect((await env.runner.advance(task.id)).state).toBe('budget_exceeded');
    expect(env.provider.callCount).toBe(0);
  });
});

describe('AgentRunner: cancellation and idempotent creation', () => {
  it('cancels a pending task immediately and a running one at its next checkpoint', async () => {
    const env = setup({
      provider: scripted([
        { toolCalls: [{ name: 'lookup', arguments: { q: 'a' } }] },
        { content: 'never' },
      ]),
    });
    const { task: pending } = await env.service.createTask({ ...newTaskInput(), input: {} });
    expect((await env.service.cancel(pending.id)).state).toBe('cancelled');
    expect((await env.runner.advance(pending.id)).state).toBe('cancelled');

    const { task: running } = await env.service.createTask({ ...newTaskInput(), input: {} });
    // Flag set while a worker would be mid-run (state=running).
    await env.store.transition(running.id, ['pending'], 'running');
    expect((await env.service.cancel(running.id)).cancelRequested).toBe(true);
    expect((await env.runner.advance(running.id)).state).toBe('cancelled');
    expect(env.provider.callCount).toBe(0);
  });

  it('cannot cancel a finished task', async () => {
    const env = setup({});
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    await expect(env.service.cancel(task.id)).rejects.toThrow(/already completed/);
  });

  it('returns the existing task for a repeated idempotency key and schedules it once', async () => {
    const env = setup({});
    const input = { ...newTaskInput(), input: { a: 1 } };
    const first = await env.service.createTask(input);
    const second = await env.service.createTask(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(env.queued).toHaveLength(1);
  });
});

describe('TaskService.reconcile', () => {
  it('wakes a task whose approval was decided but whose resume was never scheduled', async () => {
    const env = setup({
      provider: scripted([
        { toolCalls: [{ name: 'post', arguments: { body: 'x' } }] },
        { content: 'ok' },
      ]),
    });
    const { task } = await env.service.createTask({ ...newTaskInput(), input: {} });
    await env.runner.advance(task.id);
    const [approval] = await env.store.listApprovals({ status: 'pending' });
    // Crash between deciding and scheduling.
    await env.store.decideApproval(approval!.id, 'approved', null);
    env.queued.length = 0;
    expect(await env.service.reconcile()).toBe(1);
    expect(env.queued).toEqual([task.id]);
    expect((await env.runner.advance(task.id)).state).toBe('completed');
  });
});
