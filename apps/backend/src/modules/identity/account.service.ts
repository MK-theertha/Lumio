import argon2 from 'argon2';
import mongoose, { Types } from 'mongoose';
import { runtime } from '../../config/runtime.js';
import { runInTransaction } from '../../database/transaction.js';
import type { RequestContext, TransactionalContext } from '../../shared/context.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { AppError, BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { RoleAssignmentModel, RoleModel } from '../access/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { hashPassword, normaliseEmail } from './auth.service.js';
import { enqueueEmail } from './email.js';
import { AuthTokenModel, SessionModel, UserModel } from './identity.models.js';

const TOKEN_LIFETIME_MS = { INVITE: 7 * 86_400_000, RESET: 3_600_000, VERIFY: 86_400_000 };

export interface Assignment {
  roleId: string;
  branchIds: string[];
}

async function createToken(
  tx: TransactionalContext,
  userId: Types.ObjectId,
  purpose: keyof typeof TOKEN_LIFETIME_MS,
): Promise<string> {
  const token = randomToken();
  await AuthTokenModel.create(
    [
      {
        userId,
        purpose,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS[purpose]),
      },
    ],
    { session: tx.session },
  );
  return token;
}

async function replaceAssignments(
  tx: TransactionalContext,
  userId: Types.ObjectId,
  assignments: Assignment[],
): Promise<void> {
  const roleIds = assignments.map((a) => a.roleId);
  const found = await RoleModel.countDocuments({
    companyId: tx.companyId,
    _id: mongoose.trusted({ $in: roleIds }),
  }).session(tx.session);
  if (found !== new Set(roleIds).size) throw new BusinessRuleError('Unknown role.');

  await RoleAssignmentModel.deleteMany({ companyId: tx.companyId, userId }).session(tx.session);
  await RoleAssignmentModel.create(
    assignments.map((a) => ({
      companyId: tx.companyId,
      userId,
      roleId: a.roleId,
      branchIds: a.branchIds,
    })),
    { session: tx.session, ordered: true },
  );
}

export function inviteUser(
  ctx: RequestContext,
  input: { email: string; name: string; assignments: Assignment[] },
) {
  return runInTransaction(ctx, async (tx) => {
    const email = normaliseEmail(input.email);
    const existing = await UserModel.findOne({ email }).session(tx.session).lean();
    let userId = existing?._id;
    if (!userId) {
      const [created] = await UserModel.create(
        [{ email, name: input.name, status: 'INVITED', activeCompanyId: tx.companyId }],
        { session: tx.session },
      );
      userId = (created as { _id: Types.ObjectId })._id;
      const token = await createToken(tx, userId, 'INVITE');
      await enqueueEmail(tx, {
        to: email,
        subject: 'You have been invited to Lumio',
        text: `Set your password to get started: ${runtime().APP_URL}/accept-invite?token=${token}`,
      });
    } else if (existing?.activeCompanyId && !existing.activeCompanyId.equals(tx.companyId)) {
      throw new ConflictError('This email already belongs to a user of another company.');
    }
    await replaceAssignments(tx, userId, input.assignments);
    await recordAudit(tx, {
      action: 'user.invite',
      entityType: 'user',
      entityId: userId.toString(),
      after: { email, name: input.name, assignments: input.assignments },
    });
    return {
      id: userId.toString(),
      email,
      name: input.name,
      status: existing?.status ?? 'INVITED',
    };
  });
}

const targetUser = async (tx: TransactionalContext, userId: string) => {
  const assigned = await RoleAssignmentModel.findOne({ companyId: tx.companyId, userId })
    .session(tx.session)
    .lean();
  if (!assigned) throw new NotFoundError();
};

export function updateUser(
  ctx: RequestContext,
  userId: string,
  input: { name?: string; status?: 'ACTIVE' | 'DISABLED'; assignments?: Assignment[] },
) {
  return runInTransaction(ctx, async (tx) => {
    await targetUser(tx, userId);
    if (input.status === 'DISABLED' && userId === tx.userId) {
      throw new BusinessRuleError('You cannot deactivate your own account.');
    }
    const objectId = new Types.ObjectId(userId);
    await UserModel.updateOne(
      { _id: objectId },
      {
        $set: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        $inc: { permissionVersion: 1 },
      },
    ).session(tx.session);
    if (input.assignments) await replaceAssignments(tx, objectId, input.assignments);
    if (input.status === 'DISABLED') {
      await SessionModel.updateMany(
        { userId: objectId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      ).session(tx.session);
    }
    await recordAudit(tx, {
      action: 'user.update',
      entityType: 'user',
      entityId: userId,
      after: input,
    });
  });
}

export async function requestPasswordReset(email: string, ctx: RequestContext): Promise<void> {
  const user = await UserModel.findOne({ email: normaliseEmail(email) }).lean();
  if (!user || user.status !== 'ACTIVE') return;
  await runInTransaction(ctx, async (tx) => {
    const token = await createToken(tx, user._id, 'RESET');
    await enqueueEmail(tx, {
      to: user.email,
      subject: 'Reset your Lumio password',
      text: `Reset your password within an hour: ${runtime().APP_URL}/reset-password?token=${token}`,
    });
  });
}

async function consumeToken(token: string, purposes: ('INVITE' | 'RESET')[]) {
  const row = await AuthTokenModel.findOneAndDelete({
    tokenHash: sha256(token),
    purpose: mongoose.trusted({ $in: purposes }),
    expiresAt: mongoose.trusted({ $gt: new Date() }),
  }).lean();
  if (!row) throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'This link is invalid or expired.');
  return row;
}

/** Completes an invitation or password reset. Existing sessions are revoked. */
export async function setPasswordWithToken(token: string, password: string): Promise<void> {
  const row = await consumeToken(token, ['INVITE', 'RESET']);
  const now = new Date();
  await UserModel.updateOne(
    { _id: row.userId, status: mongoose.trusted({ $ne: 'DISABLED' }) },
    {
      $set: {
        passwordHash: await hashPassword(password),
        status: 'ACTIVE',
        emailVerifiedAt: now,
        failedLogins: 0,
      },
      $unset: { lockedUntil: 1 },
    },
  );
  await SessionModel.updateMany(
    { userId: row.userId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
}

export async function changePassword(
  userId: string,
  sessionId: string,
  current: string,
  next: string,
): Promise<void> {
  const user = await UserModel.findById(userId).lean();
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, current))) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'The current password is incorrect.');
  }
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(next) } },
  );
  await SessionModel.updateMany(
    { userId: user._id, revokedAt: null, _id: mongoose.trusted({ $ne: sessionId }) },
    { $set: { revokedAt: new Date() } },
  );
}

export function listSessions(userId: string) {
  return SessionModel.find({
    userId,
    revokedAt: null,
    expiresAt: mongoose.trusted({ $gt: new Date() }),
  })
    .select({ refreshHash: 0, previousHash: 0 })
    .sort({ lastUsedAt: -1 })
    .lean();
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const result = await SessionModel.updateOne(
    { _id: sessionId, userId },
    { $set: { revokedAt: new Date() } },
  );
  if (result.matchedCount === 0) throw new NotFoundError();
}

export async function listCompanyUsers(ctx: RequestContext) {
  const assignments = await RoleAssignmentModel.find({ companyId: ctx.companyId }).lean();
  const ids = [...new Set(assignments.map((a) => a.userId.toString()))];
  const users = await UserModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select({ email: 1, name: 1, status: 1, mfaEnabled: 1 })
    .sort({ name: 1 })
    .lean();
  return users.map((user) => ({
    ...user,
    assignments: assignments
      .filter((a) => a.userId.equals(user._id))
      .map((a) => ({ roleId: a.roleId, branchIds: a.branchIds })),
  }));
}

/** One-time bootstrap, run from the command line. Every later company is created through the API. */
export async function createFirstPlatformAdmin(input: {
  email: string;
  name: string;
  password: string;
}): Promise<{ id: string }> {
  if (await UserModel.exists({ isPlatformAdmin: true })) {
    throw new ConflictError('A platform administrator already exists.');
  }
  const email = normaliseEmail(input.email);
  if (await UserModel.exists({ email })) throw new ConflictError('This email is already in use.');
  const user = await UserModel.create({
    email,
    name: input.name,
    status: 'ACTIVE',
    isPlatformAdmin: true,
    passwordHash: await hashPassword(input.password),
    emailVerifiedAt: new Date(),
  });
  return { id: user._id.toString() };
}
