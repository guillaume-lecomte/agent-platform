import { Queue, Worker, type Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Logger } from '@agent-platform/core';
import type { AgentRunner } from './runner.js';

export const QUEUE_NAME = 'agent-tasks';

export interface TaskJob {
  taskId: string;
}

/** The ability to schedule work on a task; faked in tests that do not need Redis. */
export interface TaskScheduler {
  enqueue(taskId: string): Promise<void>;
}

export interface QueueOptions {
  redisUrl: string;
  queueName?: string;
}

/** Producer side: adds "advance this task" jobs to BullMQ. */
export class TaskQueue implements TaskScheduler {
  private readonly connection: Redis;
  readonly queue: Queue<TaskJob>;

  constructor(options: QueueOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<TaskJob>(options.queueName ?? QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        // Infrastructure failures (database down...) are retried by BullMQ. Agent-level
        // failures never throw out of the runner: they become task states.
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
  }

  /**
   * Every call creates a distinct job: a wake-up must never be swallowed because a
   * previous job for the same task is still finishing. Duplicates are harmless, since
   * `advance` is idempotent and writers of the same step collide on its primary key.
   */
  async enqueue(taskId: string): Promise<void> {
    await this.queue.add('advance', { taskId }, { jobId: `${taskId}__${randomUUID()}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

export interface WorkerOptions extends QueueOptions {
  runner: AgentRunner;
  logger: Logger;
  concurrency?: number;
  /**
   * How long a worker may go without renewing its lock before its job is considered
   * lost. Together with `stalledIntervalMs` this bounds how fast a crashed worker's
   * task is picked up by another one.
   */
  lockDurationMs?: number;
  stalledIntervalMs?: number;
}

/** Consumer side: runs `AgentRunner.advance` for each job. */
export class TaskWorker {
  private readonly connection: Redis;
  readonly worker: Worker<TaskJob>;

  constructor(private readonly options: WorkerOptions) {
    this.connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<TaskJob>(
      options.queueName ?? QUEUE_NAME,
      async (job: Job<TaskJob>) => {
        const { state } = await options.runner.advance(job.data.taskId);
        return { state };
      },
      {
        connection: this.connection,
        concurrency: options.concurrency ?? 4,
        lockDuration: options.lockDurationMs ?? 30_000,
        stalledInterval: options.stalledIntervalMs ?? 30_000,
        // A crash loop must not park the job in `failed`; resuming is cheap and safe.
        maxStalledCount: 20,
      },
    );
    this.worker.on('failed', (job, err) => {
      options.logger.error({ jobId: job?.id, err: err.message }, 'job failed');
    });
    this.worker.on('stalled', (jobId) => {
      options.logger.warn({ jobId }, 'job stalled (worker lost its lock); it will be re-queued');
    });
    this.worker.on('error', (err) => {
      options.logger.error({ err: err.message }, 'worker error');
    });
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
  }
}
