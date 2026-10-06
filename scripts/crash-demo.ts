/**
 * Kills a worker (SIGKILL) halfway through a task, starts another one, and checks in the database
 * that the task resumed from its last step with no step replayed and no effect repeated.
 *
 * Needs PostgreSQL and Redis (docker compose up -d postgres redis). Exit code 0 means every check passed.
 */
import { PgEffectLog, resolveIssueTriage } from '@agent-platform/agent-issue-triage';
import { createDb, createLogger } from '@agent-platform/core';
import {
  PgTaskStore,
  RedisEventBus,
  TaskQueue,
  TaskService,
  migrateRunner,
  type TaskEvent,
} from '@agent-platform/durable-runner';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://agent:agent@localhost:5432/agent_platform';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const queueName = `crash-demo-${randomUUID().slice(0, 8)}`;
const t0 = Date.now();
const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const say = (msg: string): void => console.log(`${stamp()}  ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function startWorker(label: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./worker-process.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        DATABASE_URL,
        REDIS_URL,
        QUEUE_NAME: queueName,
        MOCK_DELAY_MS: '900', // every model call takes ~0.9 s, so the task lasts several seconds
        LOCK_MS: '3000', // a worker silent for 3 s is considered dead...
        STALLED_MS: '1000', // ...and this is how often BullMQ looks for such jobs
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const relay = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line) as { msg?: string; level?: number };
        if (j.msg) say(`   [${label} pid ${child.pid}] ${j.msg}`);
      } catch {
        say(`   [${label}] ${line}`);
      }
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);
  return child;
}

const { db, pool, close } = createDb(DATABASE_URL);
await migrateRunner(db);
const store = new PgTaskStore(db);
const effects = new PgEffectLog(pool);
const bus = new RedisEventBus(REDIS_URL);
const queue = new TaskQueue({ redisUrl: REDIS_URL, queueName });
const logger = createLogger({ level: 'silent' });
const service = new TaskService({
  store,
  scheduler: queue,
  bus,
  logger,
  resolver: (_id, version) => resolveIssueTriage(version, effects),
  activeVersion: async () => 'v1',
});

const events: TaskEvent[] = [];
bus.subscribe((e) => {
  events.push(e);
  if (e.type !== 'task.step') say(`   event ${e.type}`);
});
await sleep(300); // let the subscription settle

let ok = true;
const check = (label: string, pass: boolean, detail = ''): void => {
  say(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!pass) ok = false;
};

say(`queue ${queueName}; starting worker A`);
const workerA = startWorker('worker A');
await sleep(2500);

const { task } = await service.createTask({
  agentId: 'issue-triage',
  input: {
    number: 4242,
    title: 'Server crashes on startup after upgrading to 2.4.0',
    body: 'After the upgrade the process exits immediately. Steps to reproduce: start the 2.4.0 image. Version 2.4.0.',
  },
});
say(`task ${task.id} created`);

/** Plays the human: approves whatever the agent asks for. */
let approved = 0;
const approver = setInterval(() => {
  void (async () => {
    for (const a of await store.listApprovals({ taskId: task.id, status: 'pending' })) {
      say(`human: approving ${a.toolName} (${a.risk}) ${JSON.stringify(a.arguments).slice(0, 70)}`);
      await service.approve(a.id, 'demo');
      approved++;
    }
  })().catch(() => undefined);
}, 400);

// Wait until the first effect (add_labels) has really happened, then kill the worker while
// the agent is already busy with its next model call.
for (;;) {
  const done = (await effects.list({ taskId: task.id })).filter((e) => e.tool === 'add_labels');
  const t = await store.getTask(task.id);
  if (done.length === 1 && t?.state === 'running') break;
  if (t && ['completed', 'failed'].includes(t.state))
    throw new Error(`task finished too early: ${t.state}`);
  await sleep(50);
}
const stepsAtKill = await store.listSteps(task.id);
say(`add_labels has been applied once; task has ${stepsAtKill.length} checkpointed steps`);
say('SIGKILL worker A (no chance to clean up)');
workerA.kill('SIGKILL');

await sleep(500);
say('starting worker B; it will pick the job up once BullMQ notices worker A is gone');
const workerB = startWorker('worker B');

for (;;) {
  const t = await store.getTask(task.id);
  if (t && ['completed', 'failed', 'budget_exceeded', 'cancelled'].includes(t.state)) break;
  await sleep(200);
}
clearInterval(approver);

const final = (await store.getTask(task.id))!;
const steps = await store.listSteps(task.id);
const recorded = await effects.list({ taskId: task.id });

console.log('\n--- verification -------------------------------------------------');
check('task completed', final.state === 'completed', final.state);
check(
  'a resume event was emitted',
  events.some((e) => e.type === 'task.resumed'),
);
check(
  'steps are contiguous and none was duplicated',
  steps.every((s, i) => s.seq === i + 1),
  `${steps.length} steps`,
);
check(
  'steps finished before the crash were kept as they were',
  stepsAtKill.every((s, i) => JSON.stringify(steps[i]?.payload) === JSON.stringify(s.payload)),
);
const count = (tool: string): number => recorded.filter((e) => e.tool === tool).length;
check(
  'add_labels executed exactly once',
  count('add_labels') === 1,
  `${count('add_labels')} execution(s)`,
);
check(
  'post_comment executed exactly once',
  count('post_comment') === 1,
  `${count('post_comment')} execution(s)`,
);
check(
  'every effect has a distinct idempotency key',
  new Set(recorded.map((e) => e.idempotencyKey)).size === recorded.length,
);
check('the human was asked for both effectful tools', approved === 2, `${approved} approvals`);

console.log('\nstep log:');
for (const s of steps) {
  const p = s.payload as { toolCalls?: Array<{ name: string }>; name?: string; outcome?: string };
  const what =
    s.kind === 'llm'
      ? `model call, ${p.toolCalls?.length ? p.toolCalls.map((c) => c.name).join(', ') : 'final answer'}`
      : `tool ${p.name} (${p.outcome})`;
  console.log(`  ${String(s.seq).padStart(2)}  ${what}`);
}

workerB.kill('SIGTERM');
await sleep(500);
await queue.queue.obliterate({ force: true }); // leave no demo jobs behind in Redis
await queue.close();
await bus.close();
await close();
console.log(
  ok ? '\nPASS: resumed from the checkpoint, no step replayed, no effect repeated.' : '\nFAIL',
);
process.exit(ok ? 0 : 1);
