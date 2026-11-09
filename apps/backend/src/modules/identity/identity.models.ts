import mongoose, { Schema } from 'mongoose';

const options = { versionKey: false, strict: 'throw' } as const;

const userSchema = new Schema(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    passwordHash: String,
    status: { type: String, enum: ['INVITED', 'ACTIVE', 'DISABLED'], required: true },
    isPlatformAdmin: { type: Boolean, default: false },
    emailVerifiedAt: Date,
    failedLogins: { type: Number, default: 0 },
    lockedUntil: Date,
    mfaSecret: String,
    mfaPendingSecret: String,
    mfaEnabled: { type: Boolean, default: false },
    mfaRecoveryHashes: { type: [String], default: [] },
    permissionVersion: { type: Number, default: 1 },
    activeCompanyId: Schema.Types.ObjectId,
  },
  { ...options, collection: 'users', timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });
export const UserModel = mongoose.model('User', userSchema);

const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    refreshHash: { type: String, required: true },
    previousHash: String,
    rotatedAt: Date,
    device: String,
    ip: String,
    createdAt: { type: Date, required: true },
    lastUsedAt: Date,
    revokedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { ...options, collection: 'sessions' },
);
sessionSchema.index({ refreshHash: 1 }, { unique: true });
sessionSchema.index({ previousHash: 1 });
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SessionModel = mongoose.model('Session', sessionSchema);

const authTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: ['INVITE', 'RESET', 'VERIFY'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { ...options, collection: 'authTokens' },
);
authTokenSchema.index({ tokenHash: 1 }, { unique: true });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AuthTokenModel = mongoose.model('AuthToken', authTokenSchema);

const loginHistorySchema = new Schema(
  {
    userId: Schema.Types.ObjectId,
    email: { type: String, required: true },
    outcome: { type: String, required: true },
    ip: String,
    device: String,
    at: { type: Date, required: true },
  },
  { ...options, collection: 'loginHistory' },
);
loginHistorySchema.index({ userId: 1, at: -1 });
export const LoginHistoryModel = mongoose.model('LoginHistory', loginHistorySchema);
