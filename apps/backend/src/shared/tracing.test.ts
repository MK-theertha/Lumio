import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { expect, it } from 'vitest';
import { httpTracing, startTracing, traceJob } from './tracing.js';

it('names request spans by route, never by URL, and records job failures', async () => {
  const spans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export: (batch, done) => {
      spans.push(...batch);
      done({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
  };
  const provider = startTracing('test', undefined, exporter);
  const res = Object.assign(new EventEmitter(), { statusCode: 500 }) as unknown as Response;
  const req = {
    method: 'GET',
    correlationId: 'corr-1',
    baseUrl: '/api/v1/parties',
    route: { path: '/:id' },
  } as unknown as Request;
  httpTracing()(req, res, () => undefined);
  (res as unknown as EventEmitter).emit('finish');
  await expect(
    traceJob('sale.posted', 'corr-2', () => Promise.reject(new Error('boom'))),
  ).rejects.toThrow('boom');
  await provider?.forceFlush();
  expect(spans.map((s) => s.name)).toEqual(['GET /api/v1/parties/:id', 'job sale.posted']);
  expect(spans[0]?.attributes['http.response.status_code']).toBe(500);
  expect(spans[1]?.status.code).toBe(2);
});
