import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { metrics, type Attributes } from '@opentelemetry/api';
import type { RequestHandler } from 'express';

/** Serves /metrics on its own port, which no proxy forwards. Without a port, recording is a no-op. */
export function startMetrics(port: number | undefined): void {
  if (!port) return;
  const provider = new MeterProvider({ readers: [new PrometheusExporter({ port })] });
  metrics.setGlobalMeterProvider(provider);
}

const meter = () => metrics.getMeter('lumio');

export function httpMetrics(): RequestHandler {
  const requests = meter().createCounter('http_requests', { description: 'Completed requests' });
  const duration = meter().createHistogram('http_request_duration_seconds', {
    description: 'Request duration',
    unit: 's',
  });
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      // The route pattern, not the URL, so that ids cannot create unbounded series.
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      const attributes = { method: req.method, route, status: res.statusCode };
      requests.add(1, attributes);
      duration.record(Number(process.hrtime.bigint() - start) / 1e9, attributes);
    });
    next();
  };
}

export function countJob(outcome: 'completed' | 'failed', attributes: Attributes): void {
  meter()
    .createCounter('jobs')
    .add(1, { outcome, ...attributes });
}

export function observeGauge(name: string, read: () => Promise<number>): void {
  meter()
    .createObservableGauge(name)
    .addCallback(async (result) => {
      result.observe(await read().catch(() => -1));
    });
}
