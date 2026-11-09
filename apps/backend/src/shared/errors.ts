import { ErrorCode, type ApiErrorDetail } from '@lumio/shared-types';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: ApiErrorDetail[]) {
    super(400, ErrorCode.VALIDATION_FAILED, 'The request is invalid.', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(404, ErrorCode.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, ErrorCode.CONFLICT, message);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.BUSINESS_RULE_VIOLATION) {
    super(422, code, message);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, ErrorCode.RATE_LIMITED, 'Too many requests. Please try again later.');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable.') {
    super(503, ErrorCode.SERVICE_UNAVAILABLE, message);
  }
}

/** A programming error: data access attempted without tenant scope. Always surfaces as a 500. */
export class TenantGuardError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant guard: ${operation} on ${model} is missing a concrete companyId`);
    this.name = 'TenantGuardError';
  }
}
