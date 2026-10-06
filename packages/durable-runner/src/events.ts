import { Redis } from 'ioredis';
import type { TaskEvent } from './types.js';

export type EventHandler = (event: TaskEvent) => void;

export interface EventBus {
  publish(event: TaskEvent): Promise<void>;
  /** Returns an unsubscribe function. */
  subscribe(handler: EventHandler): () => void;
  close(): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<EventHandler>();

  publish(event: TaskEvent): Promise<void> {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        // A faulty subscriber must not break the publisher.
      }
    }
    return Promise.resolve();
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): Promise<void> {
    this.handlers.clear();
    return Promise.resolve();
  }
}

export const EVENTS_CHANNEL = 'agent-platform:events';

/**
 * Redis pub/sub bus. Workers and the API are separate processes (see the crash demo),
 * so lifecycle events travel through Redis rather than process memory.
 */
export class RedisEventBus implements EventBus {
  private readonly handlers = new Set<EventHandler>();
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private subscribed: Promise<unknown> | undefined;

  constructor(
    redisUrl: string,
    private readonly channel: string = EVENTS_CHANNEL,
  ) {
    this.publisher = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber.on('message', (_channel: string, message: string) => {
      let event: TaskEvent;
      try {
        event = JSON.parse(message) as TaskEvent;
      } catch {
        return;
      }
      for (const h of this.handlers) {
        try {
          h(event);
        } catch {
          // ignore subscriber errors
        }
      }
    });
  }

  async publish(event: TaskEvent): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(event));
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    this.subscribed ??= this.subscriber.subscribe(this.channel);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
