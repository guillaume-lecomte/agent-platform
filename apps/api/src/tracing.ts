/**
 * Optional OpenTelemetry export. Tracing is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set;
 * the SDK is then loaded lazily so a default run pays nothing for it.
 * Spans: `llm.complete` and `tool.execute` (see durable-runner), nested under HTTP spans when
 * instrumentation is available.
 */
export async function startTracing(
  endpoint: string | undefined,
  serviceName = 'agent-platform-api',
): Promise<(() => Promise<void>) | undefined> {
  if (!endpoint) return undefined;
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
  });
  sdk.start();
  return () => sdk.shutdown();
}
