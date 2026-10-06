import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

const tracer = trace.getTracer('agent-platform');

/**
 * Runs `fn` inside an OpenTelemetry span. Without an SDK registered (the default) the API returns
 * no-op spans, so this costs nothing; `apps/api` registers an exporter when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. Errors are recorded on the span and rethrown.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
