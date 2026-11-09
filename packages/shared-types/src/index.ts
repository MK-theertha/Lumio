/** Stable, documented error codes returned in the API error envelope. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  CREDIT_LIMIT_EXCEEDED: 'CREDIT_LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiMeta {
  correlationId: string;
}

export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorDetail {
  path: string;
  issue: string;
}

export interface ApiFailure {
  error: {
    code: ErrorCode;
    message: string;
    details?: ApiErrorDetail[];
    correlationId: string;
  };
}

export type HealthStatus = 'up' | 'down';

export interface ReadinessReport {
  status: HealthStatus;
  checks: Record<string, HealthStatus>;
}

export { PERMISSIONS, SYSTEM_ROLES, type Permission } from './permissions.js';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  isDemo: boolean;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
  permissions: string[];
  branchScope: 'ALL' | string[];
}

export interface AuthResult {
  accessToken: string;
  user: AuthUser;
}
