import type { EventBus } from '@agent-platform/durable-runner';
import { Controller, Inject, Sse, type MessageEvent } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { BUS } from '../infra/tokens.js';

@Controller()
export class EventsController {
  constructor(@Inject(BUS) private readonly bus: EventBus) {}

  /** Server-sent events: one message per task lifecycle event, plus a keep-alive ping. */
  @Sse('events')
  events(): Observable<MessageEvent> {
    const lifecycle = new Observable<MessageEvent>((subscriber) =>
      this.bus.subscribe((event) => subscriber.next({ data: event })),
    );
    const keepAlive = interval(15_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: 'ping' })),
    );
    return merge(lifecycle, keepAlive);
  }
}
