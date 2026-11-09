import * as Sentry from '@sentry/node';
import { ErrorCode, type ApiFailure } from '@lumio/shared-types';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

function isBodyParserClientError(error: unknown): error is { status: number; message: string } {
  const status = (error as { status?: unknown }).status;
  return (
    typeof (error as { type?: unknown }).type === 'string' &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

export const notFoundHandler: RequestHandler = () => {
  throw new NotFoundError();
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    let status = 500;
    let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected error occurred.';
    let details;

    if (error instanceof AppError) {
      ({ status, code, message, details } = error);
    } else if (isBodyParserClientError(error)) {
      status = error.status;
      code = ErrorCode.MALFORMED_REQUEST;
      message = 'The request body could not be read.';
    }

    if (status >= 500) {
      logger.error({ err: error, correlationId: req.correlationId }, 'Request failed');
      Sentry.captureException(error, { tags: { correlationId: req.correlationId } });
    }

    const body: ApiFailure = {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        correlationId: req.correlationId,
      },
    };
    res.status(status).json(body);
  };
}
