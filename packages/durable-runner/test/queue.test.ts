import { createDb, type DbHandle } from '@agent-platform/core';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentRunner,
  InMemoryEventBus,
  PgTaskStore,
  TaskQueue,
  TaskService,
  TaskWorker,
  migrateRunner,
  type AgentResolver,
} from '../src/index.js';
import { countingTools, definition, logger, scripted } from './helpers.js';

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(redisUrl && databaseUrl);

describe.skipIf(!enabled)('BullMQ + PostgreSQL end to end', () => {
  const queueName = `test-${randomUUID()}`;
  let handle: DbHandle;
  let queue: TaskQueue;
  let worker: TaskWorker;
  const tools = countingTools();
  const bus = new InMemoryEventBus();

  beforeAll(async () => {
    handle = createDb(databaseUrl!);
    await migrateRunner(handle.db);
    const store = new PgTaskStore(handle.db);
    const resolver: AgentResolver = async () => ({
      definition,
      tools: [tools.lookup, tools.post],
    });
    const runner = new AgentRunner({
      store,
      resolver,
      bus,
      logger,
      provider: scripted([
        { toolCalls: [{ name: 'post', arguments: { body: 'hello' } }] },
        { content: '{"done":true}' },
      ]),
    });
    queue = new TaskQueue({ redisUrl: redisUrl!, queueName });
    worker = new TaskWorker({ redisUrl: redisUrl!, queueName, runner, logger, concurrency: 2 });
    service = new TaskService({
      store,
      scheduler: queue,
      bus,
      resolver,
      logger,
      activeVersion: async () => 'v1',
      runner,
    });
  });

  let service: TaskService;

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await handle?.close();
  });

  async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out');
  }

  it('processes a task through the queue, pauses for approval, and resumes on approve', async () => {
    const { task } = await service.createTask({
      agentId: 't',
      agentVersion: 'v1',
      input: {},
    });
    await waitFor(async () => (await service.getTask(task.id)).state === 'awaiting_approval');
    expect(tools.counts.post).toBe(0);

    const [approval] = await service.listApprovals({ taskId: task.id, status: 'pending' });
    await service.approve(approval!.id, 'ok');
    await waitFor(async () => (await service.getTask(task.id)).state === 'completed');
    expect(tools.counts.post).toBe(1);
  });
});
