import {
  errorEnvelopeSchema,
  livenessSchema,
  readinessSchema,
  successEnvelope,
} from '@lumio/validation';
import { z } from 'zod';
import { describeApiRoutes } from './route-table.js';

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

/** Request schemas are described as clients send them, before any transforms apply. */
function requestJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
}

const readinessResponses = {
  200: { description: 'All dependencies are up', schema: successEnvelope(readinessSchema) },
  503: { description: 'A dependency is down', schema: successEnvelope(readinessSchema) },
};

/** Health routes sit outside the API router. Everything else is generated from the real routes. */
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

function businessOperations(paths: Record<string, Record<string, unknown>>): void {
  const errors = {
    description: 'An error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  };
  const parameters = (location: 'query' | 'path', schema: z.ZodType | undefined) => {
    if (!schema) return [];
    const json = requestJsonSchema(schema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return Object.entries(json.properties ?? {}).map(([name, property]) => ({
      name,
      in: location,
      required: location === 'path' || (json.required ?? []).includes(name),
      schema: property,
    }));
  };
  for (const route of describeApiRoutes()) {
    const pathKey = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const body = route.schemas.body;
    const permissions = route.permissions.length ? route.permissions.join(', ') : 'none';
    paths[pathKey] = {
      ...paths[pathKey],
      [route.method]: {
        tags: [route.path.split('/')[3] ?? 'api'],
        summary: `${route.method.toUpperCase()} ${route.path.replace('/api/v1', '')}`,
        description: `Authentication: ${route.authenticated ? 'bearer token' : 'none'}. Permissions: ${permissions}.`,
        parameters: [
          ...parameters('path', route.schemas.params),
          ...parameters('query', route.schemas.query),
        ],
        ...(body
          ? {
              requestBody: { content: { 'application/json': { schema: requestJsonSchema(body) } } },
            }
          : {}),
        responses: { '2XX': { description: 'Success' }, default: errors },
      },
    };
  }
}

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  businessOperations(paths);
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
