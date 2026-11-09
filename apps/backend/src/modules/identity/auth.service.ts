import type { AuthResult, AuthUser } from '@lumio/shared-types';
import argon2 from 'argon2';
import { jwtVerify, SignJWT } from 'jose';
import mongoose, { Types } from 'mongoose';
import { runtime } from '../../config/runtime.js';
import { AppError, ConflictError } from '../../shared/errors.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { decrypt, encrypt } from '../../shared/crypto.js';
import { loadAccess, RoleAssignmentModel } from '../access/index.js';
import { CompanyModel } from '../organisation/index.js';
import { LoginHistoryModel, SessionModel, UserModel } from './identity.models.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

const ACCESS_TTL_SECONDS = 600;
const MFA_TTL_SECONDS = 300;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 10_000;
const LOCK_AFTER = 5;
const MAX_LOCK_MINUTES = 60;

const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};
// Compared against when the account is unknown, so response time does not reveal which emails exist.
const dummyHash = argon2.hash('dummy-password-for-constant-time', ARGON2_OPTIONS);

export interface ClientInfo {
  ip?: string;
  device?: string;
}

export interface LoginOutcome {
  auth?: AuthResult;
  refreshToken?: string;
  mfaToken?: string;
}

const invalidCredentials = () =>
  new AppError(401, 'UNAUTHENTICATED', 'The email or password is incorrect.');
const secret = () => new TextEncoder().encode(runtime().JWT_ACCESS_SECRET);
export const normaliseEmail = (email: string) => email.trim().toLowerCase();
export const hashPassword = (password: string) => argon2.hash(password, ARGON2_OPTIONS);

type UserDoc = NonNullable<Awaited<ReturnType<typeof findUser>>>;
const findUser = (email: string) => UserModel.findOne({ email: normaliseEmail(email) }).lean();

function history(user: UserDoc | null, email: string, outcome: string, client: ClientInfo) {
  return LoginHistoryModel.create({
    userId: user?._id,
    email: normaliseEmail(email),
    outcome,
    ip: client.ip,
    device: client.device,
    at: new Date(),
  });
}

export async function describeUser(userId: Types.ObjectId | string): Promise<AuthUser> {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw invalidCredentials();
  const companyId = user.activeCompanyId ?? null;
  const company = companyId ? await CompanyModel.findById(companyId).lean() : null;
  const access = companyId
    ? await loadAccess(user._id, companyId)
    : { permissions: [], branchScope: [] as string[] };
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    companyId: company?._id.toString() ?? null,
    companyName: company?.legalName ?? null,
    isDemo: company?.isDemo ?? false,
    isPlatformAdmin: user.isPlatformAdmin ?? false,
    mfaEnabled: user.mfaEnabled ?? false,
    permissions: access.permissions,
    branchScope: access.branchScope,
  };
}

async function accessTokenFor(user: UserDoc, sessionId: Types.ObjectId): Promise<string> {
  const companyId = user.activeCompanyId;
  return new SignJWT({
    sid: sessionId.toString(),
    cid: companyId?.toString() ?? null,
    pv: user.permissionVersion,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user._id.toString())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(secret());
}

async function startSession(user: UserDoc, client: ClientInfo): Promise<LoginOutcome> {
  const refreshToken = randomToken();
  const now = new Date();
  const session = await SessionModel.create({
    userId: user._id,
    refreshHash: sha256(refreshToken),
    device: client.device,
    ip: client.ip,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } },
  );
  return {
    refreshToken,
    auth: {
      accessToken: await accessTokenFor(user, session._id),
      user: await describeUser(user._id),
    },
  };
}

async function registerFailure(user: UserDoc): Promise<void> {
  const failures = (user.failedLogins ?? 0) + 1;
  const minutes =
    failures >= LOCK_AFTER ? Math.min(2 ** (failures - LOCK_AFTER), MAX_LOCK_MINUTES) : 0;
  await UserModel.updateOne(
    { _id: user._id },
    {
      $inc: { failedLogins: 1 },
      ...(minutes ? { $set: { lockedUntil: new Date(Date.now() + minutes * 60_000) } } : {}),
    },
  );
}

export async function login(
  email: string,
  password: string,
  client: ClientInfo,
): Promise<LoginOutcome> {
  const user = await findUser(email);
  if (!user?.passwordHash) {
    await argon2.verify(await dummyHash, password);
    await history(user, email, 'UNKNOWN_ACCOUNT', client);
    throw invalidCredentials();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await history(user, email, 'LOCKED', client);
    throw invalidCredentials();
  }
  if (!(await argon2.verify(user.passwordHash, password))) {
    await registerFailure(user);
    await history(user, email, 'BAD_PASSWORD', client);
    throw invalidCredentials();
  }
  if (user.status !== 'ACTIVE') {
    await history(user, email, 'DISABLED', client);
    throw invalidCredentials();
  }
  if (user.mfaEnabled) {
    await history(user, email, 'MFA_CHALLENGED', client);
    const mfaToken = await new SignJWT({ typ: 'mfa' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user._id.toString())
      .setExpirationTime(`${MFA_TTL_SECONDS}s`)
      .sign(secret());
    return { mfaToken };
  }
  await history(user, email, 'SUCCESS', client);
  return startSession(user, client);
}

async function consumeRecoveryCode(user: UserDoc, code: string): Promise<boolean> {
  const result = await UserModel.updateOne(
    { _id: user._id, mfaRecoveryHashes: sha256(code) },
    { $pull: { mfaRecoveryHashes: sha256(code) } },
  );
  return result.modifiedCount === 1;
}

export async function completeMfa(
  mfaToken: string,
  code: string,
  client: ClientInfo,
): Promise<LoginOutcome> {
  let subject: string | undefined;
  try {
    const { payload } = await jwtVerify(mfaToken, secret(), { algorithms: ['HS256'] });
    if (payload.typ === 'mfa') subject = payload.sub;
  } catch {
    // An invalid or expired challenge is reported below as a failed login.
  }
  const user = subject ? await UserModel.findById(subject).lean() : null;
  if (!user?.mfaSecret || user.status !== 'ACTIVE') throw invalidCredentials();
  if (user.lockedUntil && user.lockedUntil > new Date()) throw invalidCredentials();

  const valid =
    verifyTotp(decrypt(user.mfaSecret), code) || (await consumeRecoveryCode(user, code));
  if (!valid) {
    await registerFailure(user);
    await history(user, user.email, 'BAD_MFA', client);
    throw new AppError(401, 'UNAUTHENTICATED', 'The verification code is incorrect.');
  }
  await history(user, user.email, 'SUCCESS', client);
  return startSession(user, client);
}

/** Single-use rotation. Replaying an already-rotated token revokes the whole session. */
export async function refresh(token: string, client: ClientInfo): Promise<LoginOutcome> {
  const hash = sha256(token);
  const now = new Date();
  const nextToken = randomToken();
  const session = await SessionModel.findOneAndUpdate(
    { refreshHash: hash, revokedAt: null, expiresAt: mongoose.trusted({ $gt: now }) },
    {
      $set: {
        refreshHash: sha256(nextToken),
        previousHash: hash,
        rotatedAt: now,
        lastUsedAt: now,
        ip: client.ip,
      },
    },
    { returnDocument: 'after' },
  ).lean();

  if (!session) {
    const replayed = await SessionModel.findOne({ previousHash: hash, revokedAt: null }).lean();
    if (replayed) {
      if (now.getTime() - (replayed.rotatedAt?.getTime() ?? 0) <= ROTATION_GRACE_MS) {
        throw new ConflictError('The session was just refreshed by another tab.');
      }
      await SessionModel.updateOne({ _id: replayed._id }, { $set: { revokedAt: now } });
      await history(null, 'session-reuse', 'REFRESH_REUSE', client);
    }
    throw new AppError(401, 'UNAUTHENTICATED', 'The session has expired.');
  }

  const user = await UserModel.findById(session.userId).lean();
  if (!user || user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHENTICATED', 'The session has expired.');
  }
  return {
    refreshToken: nextToken,
    auth: {
      accessToken: await accessTokenFor(user, session._id),
      user: await describeUser(user._id),
    },
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await SessionModel.updateOne({ refreshHash: sha256(token) }, { $set: { revokedAt: new Date() } });
}

export interface AccessClaims {
  userId: string;
  sessionId: string;
  companyId: string | null;
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  if (payload.typ !== 'access' || !payload.sub) throw new Error('Wrong token type');
  const session = await SessionModel.findById(payload.sid).lean();
  if (!session || session.revokedAt) throw new Error('Session revoked');
  return {
    userId: payload.sub,
    sessionId: String(payload.sid),
    companyId: (payload.cid as string) ?? null,
  };
}

/** The companies this person holds a role in. Spans tenants by design, so it skips the guard. */
export async function listUserCompanies(userId: string) {
  const ids = await RoleAssignmentModel.collection.distinct('companyId', {
    userId: new Types.ObjectId(userId),
  });
  const companies = await CompanyModel.find({
    _id: mongoose.trusted({ $in: ids }),
    status: 'ACTIVE',
  })
    .select({ legalName: 1 })
    .sort({ legalName: 1 })
    .lean();
  return companies.map((c) => ({ id: c._id.toString(), name: c.legalName }));
}

/** Changes which company this session works in. Access comes from the role held there. */
export async function switchCompany(claims: AccessClaims, companyId: string): Promise<AuthResult> {
  const allowed = await listUserCompanies(claims.userId);
  if (!allowed.some((company) => company.id === companyId)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to that company.');
  }
  await UserModel.updateOne(
    { _id: claims.userId },
    { $set: { activeCompanyId: new Types.ObjectId(companyId) } },
  );
  const user = await UserModel.findById(claims.userId).lean();
  if (!user) throw invalidCredentials();
  return {
    accessToken: await accessTokenFor(user, new Types.ObjectId(claims.sessionId)),
    user: await describeUser(user._id),
  };
}

export async function beginMfaEnrolment(userId: string) {
  const user = await UserModel.findById(userId).lean();
  if (!user) throw invalidCredentials();
  const totp = generateTotpSecret();
  await UserModel.updateOne({ _id: user._id }, { $set: { mfaPendingSecret: encrypt(totp) } });
  return { secret: totp, otpauthUrl: otpauthUrl(totp, user.email) };
}

export async function confirmMfaEnrolment(userId: string, code: string): Promise<string[]> {
  const user = await UserModel.findById(userId).lean();
  if (!user?.mfaPendingSecret || !verifyTotp(decrypt(user.mfaPendingSecret), code)) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'The verification code is incorrect.');
  }
  const codes = Array.from({ length: 8 }, () => randomToken(6));
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        mfaSecret: user.mfaPendingSecret,
        mfaEnabled: true,
        mfaRecoveryHashes: codes.map(sha256),
      },
      $unset: { mfaPendingSecret: 1 },
    },
  );
  return codes;
}

export async function disableMfa(userId: string, password: string): Promise<void> {
  const user = await UserModel.findById(userId).lean();
  if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, password))) {
    throw invalidCredentials();
  }
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { mfaEnabled: false, mfaRecoveryHashes: [] }, $unset: { mfaSecret: 1 } },
  );
}
