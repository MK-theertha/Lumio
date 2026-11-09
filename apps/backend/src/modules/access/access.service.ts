import mongoose, { Types } from 'mongoose';
import { RoleAssignmentModel, RoleModel } from './access.models.js';

export interface EffectiveAccess {
  permissions: string[];
  branchScope: 'ALL' | string[];
}

/** Permissions are the union of a user's roles; a company-wide assignment widens the branch scope. */
export async function loadAccess(
  userId: Types.ObjectId | string,
  companyId: Types.ObjectId,
): Promise<EffectiveAccess> {
  const assignments = await RoleAssignmentModel.find({
    companyId,
    userId: new Types.ObjectId(userId),
  }).lean();
  if (assignments.length === 0) return { permissions: [], branchScope: [] };

  const roles = await RoleModel.find({
    companyId,
    _id: mongoose.trusted({ $in: assignments.map((a) => a.roleId) }),
  }).lean();

  const permissions = [...new Set(roles.flatMap((role) => role.permissions))];
  const branchScope = assignments.some((a) => a.branchIds.length === 0)
    ? ('ALL' as const)
    : [...new Set(assignments.flatMap((a) => a.branchIds.map(String)))];
  return { permissions, branchScope };
}
