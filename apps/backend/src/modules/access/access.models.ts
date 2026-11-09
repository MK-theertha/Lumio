import mongoose, { Schema } from 'mongoose';
import { tenantGuardPlugin } from '../../database/plugins/tenant-guard.js';

const options = { versionKey: false, strict: 'throw' } as const;

const roleSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    permissions: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    archivedAt: Date,
  },
  { ...options, collection: 'roles', timestamps: true },
);
roleSchema.index({ companyId: 1, name: 1 }, { unique: true });
roleSchema.plugin(tenantGuardPlugin);
export const RoleModel = mongoose.model('Role', roleSchema);

const roleAssignmentSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    roleId: { type: Schema.Types.ObjectId, required: true },
    // Empty means the whole company.
    branchIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { ...options, collection: 'roleAssignments' },
);
roleAssignmentSchema.index({ companyId: 1, userId: 1, roleId: 1 }, { unique: true });
roleAssignmentSchema.plugin(tenantGuardPlugin);
export const RoleAssignmentModel = mongoose.model('RoleAssignment', roleAssignmentSchema);
