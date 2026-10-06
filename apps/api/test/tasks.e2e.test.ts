import 'reflect-metadata';
import {
  InMemoryEffectLog,
  issueTriageResponder,
  resolveIssueTriage,
} from '@agent-platform/agent-issue-triage';
import { MockProvider, createLogger } from '@agent-platform/core';
import {
  CostRouter,
  InMemoryCallTracker,
  InMemoryResponseCache,
  loadPolicy,
  loadPricing,
  mockLatencyFromPricing,
} from '@agent-platform/cost-router';
import { fileURLToPath } from 'node:url';
import {
  AgentRunner,
  InMemoryEventBus,
  InMemoryTaskStore,
  NotFoundError,
  TaskService,
  type TaskScheduler,
} from '@agent-platform/durable-runner';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainExceptionFilter } from '../src/http-exceptions.js';
import { AGENTS, BUS, COST_TRACKER, METRICS, PRICING, TASK_SERVICE } from '../src/infra/tokens.js';
import { CostsController } from '../src/costs/costs.controller.js';
import { MetricsService } from '../src/metrics/metrics.service.js';
import { AgentsController } from '../src/tasks/agents.controller.js';
import { EventsController } from '../src/tasks/events.controller.js';
import { MetricsController } from '../src/metrics/metrics.controller.js';
import { TasksController } from '../src/tasks/tasks.controller.js';

/** Untyped JSON body of a response; tests assert on the shapes they care about. */
type Json = ReturnType<typeof JSON.parse>;

const logger = createLogger({ level: 'silent' });

async function startApp() {
  const store = new InMemoryTaskStore();
  const bus = new InMemoryEventBus();
  const effects = new InMemoryEffectLog();
  const metrics = new MetricsService(store);
  const catalog = {
    ids: ['issue-triage'],
    effects,
    resolver: async (id: string, version: string) => {
      if (id !== 'issue-triage') throw new NotFoundError('agent', id);
      return resolveIssueTriage(version, effects);
    },
    activeVersion: async () => 'v1',
  };
  const config = (file: string) =>
    fileURLToPath(new URL(`../../../config/${file}`, import.meta.url));
  const pricing = await loadPricing(config('pricing.yaml'));
  const tracker = new InMemoryCallTracker();
  const router = new CostRouter({
    providers: {
      mock: new MockProvider({
        responder: issueTriageResponder,
        simulatedLatencyMs: mockLatencyFromPricing(pricing),
      }),
    },
    pricing,
    policy: await loadPolicy(config('routing.yaml')),
    cache: new InMemoryResponseCache(),
    tracker,
  });
  const runner = new AgentRunner({
    store,
    bus,
    logger,
    resolver: catalog.resolver,
    provider: router,
    hooks: metrics.hooks,
  });
  // Runs jobs inline, in the background, like a worker would.
  const scheduler: TaskScheduler = {
    async enqueue(taskId) {
      void runner.advance(taskId);
    },
  };
  const service = new TaskService({
    store,
    scheduler,
    bus,
    resolver: catalog.resolver,
    activeVersion: catalog.activeVersion,
    logger,
    runner,
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [
      TasksController,
      EventsController,
      AgentsController,
      MetricsController,
      CostsController,
    ],
    providers: [
      { provide: TASK_SERVICE, useValue: service },
      { provide: BUS, useValue: bus },
      { provide: AGENTS, useValue: catalog },
      { provide: METRICS, useValue: metrics },
      { provide: COST_TRACKER, useValue: tracker },
      { provide: PRICING, useValue: pricing },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return { app, url: await app.getUrl(), effects, tracker };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

const issue = {
  title: 'Server crashes on startup after upgrading to 2.4.0',
  body: 'All users are locked out.',
};

describe('REST API', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
  });

  const call = async (
    url: string,
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined,
      raw: text,
    };
  };

  it('runs the demo agent end to end, pausing for two approvals', async () => {
    const started = await startApp();
    app = started.app;
    const created = await call(started.url, '/tasks', 'POST', { input: issue });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agentId: 'issue-triage', agentVersion: 'v1' });
    const id = created.body.id as string;

    // 1st approval: add_labels. Nothing has happened in the "GitHub" sandbox yet.
    const first = await waitFor(
      async () => (await call(started.url, '/approvals?status=pending', 'GET')).body[0],
    );
    expect(first).toMatchObject({ toolName: 'add_labels', risk: 'reversible', taskId: id });
    expect(started.effects.effects).toHaveLength(0);
    expect((await call(started.url, `/tasks/${id}`)).body.state).toBe('awaiting_approval');
    expect(
      (await call(started.url, `/approvals/${first.id}/approve`, 'POST', { reason: 'ok' })).status,
    ).toBe(200);

    // 2nd approval: post_comment.
    const second = await waitFor(async () =>
      ((await call(started.url, '/approvals?status=pending')).body as Json[]).find(
        (a) => a.toolName === 'post_comment',
      ),
    );
    expect(second.risk).toBe('destructive');
    await call(started.url, `/approvals/${second.id}/approve`, 'POST', {});

    const done = await waitFor(async () => {
      const t = (await call(started.url, `/tasks/${id}`)).body;
      return t.state === 'completed' ? t : undefined;
    });
    expect(done.result.json).toMatchObject({ category: 'bug', priority: 'P0' });
    expect(started.effects.effects.map((e) => e.tool)).toEqual(['add_labels', 'post_comment']);
    const steps = (await call(started.url, `/tasks/${id}/steps`)).body as Json[];
    expect(steps.map((s) => s.kind)).toEqual(['llm', 'tool', 'llm', 'tool', 'llm', 'tool', 'llm']);

    const metrics = (await call(started.url, '/metrics')).raw;
    expect(metrics).toContain(
      'agent_tasks_finished_total{agent="issue-triage",state="completed"} 1',
    );
    expect(metrics).toContain('agent_tool_calls_total{tool="add_labels",outcome="executed"} 1');
  });

  it('returns a denial to the agent, which then does not run the tool', async () => {
    const started = await startApp();
    app = started.app;
    const { body: task } = await call(started.url, '/tasks', 'POST', { input: issue });
    const approval = await waitFor(
      async () => (await call(started.url, '/approvals?status=pending')).body[0],
    );
    expect((await call(started.url, `/approvals/${approval.id}/deny`, 'POST', {})).status).toBe(
      400,
    ); // reason required
    await call(started.url, `/approvals/${approval.id}/deny`, 'POST', {
      reason: 'labels are managed by hand',
    });
    const next = await waitFor(
      async () => (await call(started.url, '/approvals?status=pending')).body[0],
    );
    expect(next.toolName).toBe('post_comment');
    const steps = (await call(started.url, `/tasks/${task.id}/steps`)).body as Json[];
    const denied = steps.find((s) => s.kind === 'tool' && s.payload.name === 'add_labels');
    expect(denied.payload).toMatchObject({ outcome: 'denied', isError: true });
    expect(denied.payload.content).toContain('labels are managed by hand');
    expect(started.effects.effects).toHaveLength(0);
  });

  it('deduplicates creation with an Idempotency-Key', async () => {
    const started = await startApp();
    app = started.app;
    const h = { 'idempotency-key': 'issue-4242' };
    const a = await call(started.url, '/tasks', 'POST', { input: issue }, h);
    const b = await call(started.url, '/tasks', 'POST', { input: issue }, h);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect((await call(started.url, '/tasks')).body).toHaveLength(1);
  });

  it('maps errors to HTTP statuses', async () => {
    const started = await startApp();
    app = started.app;
    expect((await call(started.url, '/tasks/00000000-0000-0000-0000-000000000000')).status).toBe(
      404,
    );
    expect(
      (await call(started.url, '/tasks', 'POST', { input: { body: 'no title' } })).status,
    ).toBe(400);
    expect(
      (await call(started.url, '/tasks', 'POST', { agentId: 'nope', input: issue })).status,
    ).toBe(404);
    expect((await call(started.url, '/approvals?status=weird')).status).toBe(400);
    expect(
      (
        await call(
          started.url,
          '/approvals/00000000-0000-0000-0000-000000000000/approve',
          'POST',
          {},
        )
      ).status,
    ).toBe(404);
  });

  it('cancels a task that is waiting for approval', async () => {
    const started = await startApp();
    app = started.app;
    const { body: task } = await call(started.url, '/tasks', 'POST', { input: issue });
    await waitFor(async () => (await call(started.url, '/approvals?status=pending')).body[0]);
    expect((await call(started.url, `/tasks/${task.id}/cancel`, 'POST')).body.state).toBe(
      'cancelled',
    );
    expect((await call(started.url, `/tasks/${task.id}/cancel`, 'POST')).status).toBe(409);
  });

  it('streams lifecycle events over SSE', async () => {
    const started = await startApp();
    app = started.app;
    const controller = new AbortController();
    const res = await fetch(`${started.url}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await call(started.url, '/tasks', 'POST', { input: issue });
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('task.awaiting_approval')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain('task.created');
    expect(text).toContain('task.started');
    expect(text).toContain('task.awaiting_approval');
  });

  it('routes by input size and reports cost and latency per model, flagged as simulated', async () => {
    const started = await startApp();
    app = started.app;
    const short = { title: 'Typo in settings', body: 'Notifcations is missing an i.' };
    const long = {
      title: 'Sync fails after upgrade',
      body: 'We upgraded last week. '.repeat(20) + 'Now sync fails every time. Version 2.4.1.',
    };
    for (const input of [short, long]) {
      const { body: task } = await call(started.url, '/tasks', 'POST', { input });
      for (let i = 0; i < 2; i++) {
        const a = await waitFor(
          async () =>
            (
              (await call(started.url, `/approvals?status=pending&taskId=${task.id}`))
                .body as Json[]
            )[0],
        );
        await call(started.url, `/approvals/${a.id}/approve`, 'POST', {});
      }
      await waitFor(async () =>
        (await call(started.url, `/tasks/${task.id}`)).body.state === 'completed'
          ? true
          : undefined,
      );
    }
    const costs = (await call(started.url, '/costs')).body;
    expect(costs.simulated).toBe(true);
    expect(costs.byModel.map((m: Json) => m.model).sort()).toEqual(['mock-large', 'mock-small']);
    expect(costs.totals.calls).toBe(8); // 4 model calls per task
    expect(costs.totals.costUsd).toBeGreaterThan(0);
    expect(costs.byModel[0].p50LatencyMs).toBeGreaterThan(0);
    expect(costs.pricing.models.find((m: Json) => m.model === 'mock-large')).toMatchObject({
      simulated: true,
      retrieved: '2026-10-06',
    });
    const calls = (await call(started.url, '/costs/calls?limit=10')).body as Json[];
    expect(calls.some((c) => c.rule === 'simple-triage-on-small-model')).toBe(true);
    expect(calls.every((c) => c.taskId)).toBe(true);
  });
});
