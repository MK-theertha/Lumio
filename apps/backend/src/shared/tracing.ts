import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';
import type { RequestHandler } from 'express';

/** Without an endpoint no provider is registered, and spans cost nothing. */
export function startTracing(
  serviceName: string,
  endpoint: string | undefined,
  exporter?: SpanExporter,
): TracerProvider | undefined {
  if (!endpoint && !exporter) return undefined;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: exporter ?? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  return provider;
}

const tracer = () => trace.getTracer('lumio');

export function httpTracing(): RequestHandler {
  return (req, res, next) => {
    const span = tracer().startSpan(`${req.method} request`, {
      // The path is left out because ids and tokens can appear in it.
      attributes: { 'http.request.method': req.method, 'lumio.correlation_id': req.correlationId },
    });
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      span.updateName(`${req.method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    next();
  };
}

export async function traceJob<T>(type: string, correlationId: string, run: () => Promise<T>) {
  return tracer().startActiveSpan(`job ${type}`, async (span) => {
    span.setAttribute('lumio.correlation_id', correlationId);
    try {
      return await run();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
