import type { Permission } from '@lumio/shared-types';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { loadAccess } from '../modules/access/index.js';
import { verifyAccessToken } from '../modules/identity/auth.service.js';
import { AppError } from '../shared/errors.js';

const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
const forbidden = () =>
  new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');

/** Builds the request context from verified credentials only. */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthenticated();
  let claims;
  try {
    claims = await verifyAccessToken(header.slice(7));
  } catch {
    throw unauthenticated();
  }
  req.auth = claims;
  if (claims.companyId) {
    const companyId = new Types.ObjectId(claims.companyId);
    const access = await loadAccess(claims.userId, companyId);
    req.ctx = {
      companyId,
      userId: claims.userId,
      branchScope:
        access.branchScope === 'ALL'
          ? 'ALL'
          : access.branchScope.map((id) => new Types.ObjectId(id)),
      permissions: new Set(access.permissions),
      correlationId: req.correlationId,
    };
  }
  next();
};

export function requirePermission(...required: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.ctx) throw forbidden();
    if (!required.every((permission) => req.ctx.permissions.has(permission))) throw forbidden();
    next();
  };
}
