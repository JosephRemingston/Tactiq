import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'ENTITLEMENT_REQUIRED'
  | 'ENTITLEMENT_EXCEEDED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: HttpStatus,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', HttpStatus.NOT_FOUND, `${what} not found`),
  validation: (details: unknown) => new AppError('VALIDATION_FAILED', HttpStatus.BAD_REQUEST, 'Request validation failed', details),
  unauthenticated: (message = 'Authentication required') => new AppError('UNAUTHENTICATED', HttpStatus.UNAUTHORIZED, message),
  conflict: (message: string) => new AppError('CONFLICT', HttpStatus.CONFLICT, message),
  entitlementRequired: (details: unknown) => new AppError('ENTITLEMENT_REQUIRED', HttpStatus.FORBIDDEN, 'This feature is not included in your plan', details),
  entitlementExceeded: (details: unknown) => new AppError('ENTITLEMENT_EXCEEDED', HttpStatus.FORBIDDEN, 'Usage limit reached for this period', details),
  providerUnavailable: (message: string) => new AppError('PROVIDER_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE, message),
};

/** Ownership helper: a missing row and a row owned by someone else are indistinguishable (404). */
export function assertFound<T>(row: T | null | undefined, what = 'Resource'): T {
  if (row === null || row === undefined) throw Errors.notFound(what);
  return row;
}

export async function assertOwned<T>(lookup: () => Promise<T | null | undefined>, what = 'Resource'): Promise<T> {
  return assertFound(await lookup(), what);
}
