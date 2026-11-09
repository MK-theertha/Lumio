import { Router, type RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { createLogger } from '../shared/logger.js';
import { createApiRouter } from './index.js';

export interface RouteInfo {
  method: string;
  path: string;
  authenticated: boolean;
  permissions: string[];
  schemas: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };
}

interface Layer {
  handle: RequestHandler & {
    stack?: Layer[];
    requestSchemas?: RouteInfo['schemas'];
    requiredPermissions?: string[];
  };
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  mountPath?: string;
}

type Routing = { stack: Layer[]; use: (...args: unknown[]) => unknown };

function describeHandlers(handlers: Layer[]) {
  const permissions: string[] = [];
  let schemas: RouteInfo['schemas'] = {};
  for (const { handle } of handlers) {
    permissions.push(...(handle.requiredPermissions ?? []));
    schemas = { ...schemas, ...handle.requestSchemas };
  }
  return { permissions, schemas };
}

function walk(stack: Layer[], prefix: string, inherited: boolean, out: RouteInfo[]): void {
  let authenticated = inherited;
  for (const layer of stack) {
    if (layer.handle === authenticate) authenticated = true;
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method, path, authenticated, ...describeHandlers(layer.route.stack) });
      }
    } else if (layer.handle.stack) {
      const mount = layer.mountPath === '/' ? '' : (layer.mountPath ?? '');
      walk(layer.handle.stack, `${prefix}${mount}`, authenticated, out);
    }
  }
}

/** Express does not keep mount paths, so they are recorded while the router is built. */
export function describeApiRoutes(): RouteInfo[] {
  const proto = Router as unknown as { prototype: Routing };
  const originalUse = proto.prototype.use;
  proto.prototype.use = function patched(this: Routing, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const mountPath = typeof args[0] === 'string' ? args[0] : '/';
    for (const layer of this.stack.slice(before)) layer.mountPath = mountPath;
    return result;
  };
  try {
    const router = createApiRouter({
      // Nothing is called while describing routes, so no connection is needed.
      redis: {} as Redis,
      logger: createLogger('silent', 'route-table'),
      allowedOrigins: [],
    }) as unknown as Routing;
    const routes: RouteInfo[] = [];
    walk(router.stack, '/api/v1', false, routes);
    return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
  } finally {
    proto.prototype.use = originalUse;
  }
}
