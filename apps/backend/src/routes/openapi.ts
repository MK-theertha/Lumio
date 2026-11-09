import {
  errorEnvelopeSchema,
  livenessSchema,
  readinessSchema,
  successEnvelope,
} from '@lumio/validation';
import { z } from 'zod';

interface OperationSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  responses: Record<number, { description: string; schema: z.ZodType }>;
}

function toJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
}

const readinessResponses = {
  200: { description: 'All dependencies are up', schema: successEnvelope(readinessSchema) },
  503: { description: 'A dependency is down', schema: successEnvelope(readinessSchema) },
};

/** Every route is declared here against the same Zod schemas that validate it at runtime. */
const operations: OperationSpec[] = [
  {
    method: 'get',
    path: '/healthz/live',
    tag: 'Health',
    summary: 'Liveness: the process is running',
    responses: { 200: { description: 'Alive', schema: successEnvelope(livenessSchema) } },
  },
  {
    method: 'get',
    path: '/healthz/ready',
    tag: 'Health',
    summary: 'Readiness: dependencies are reachable',
    responses: readinessResponses,
  },
  {
    method: 'get',
    path: '/healthz/startup',
    tag: 'Health',
    summary: 'Startup: dependencies are reachable',
    responses: readinessResponses,
  },
];

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { method, path, tag, summary, responses } of operations) {
    paths[path] = {
      ...paths[path],
      [method]: {
        tags: [tag],
        summary,
        responses: Object.fromEntries(
          Object.entries(responses).map(([status, { description, schema }]) => [
            status,
            { description, content: { 'application/json': { schema: toJsonSchema(schema) } } },
          ]),
        ),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Lumio Gold Trading ERP API', version: '1.0.0' },
    servers: [{ url: '/' }],
    paths,
    components: { schemas: { ErrorEnvelope: toJsonSchema(errorEnvelopeSchema) } },
  };
}
