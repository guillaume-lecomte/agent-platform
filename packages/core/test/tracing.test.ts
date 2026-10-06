import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSpan } from '../src/index.js';

describe('withSpan', () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });

  it('records a span with attributes and nests child spans', async () => {
    const result = await withSpan('outer', { 'task.id': 't1' }, () =>
      withSpan('inner', { tool: 'search' }, async () => 42),
    );
    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === 'outer');
    const inner = spans.find((s) => s.name === 'inner');
    expect(outer?.attributes['task.id']).toBe('t1');
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
  });

  it('marks the span as failed and rethrows', async () => {
    exporter.reset();
    await expect(withSpan('boom', {}, () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events[0]?.name).toBe('exception');
  });
});
