import { type CallHandler, type ExecutionContext, HttpException, Injectable, type NestInterceptor, SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { catchError, type Observable, from, switchMap, throwError } from 'rxjs';
import type { AuthedRequest } from '../../common/auth.decorators';
import { Errors } from '../../common/errors';
import { EntitlementsService, type Subject } from './entitlements.service';

export interface EntitlementRequirement {
  featureKey: string;
  /** How the metered subject is derived from the request; one unit per subject per period. */
  subject: (req: AuthedRequest) => Subject;
}

const ENTITLEMENT_KEY = 'touchline:entitlement';

@Injectable()
export class EntitlementInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const requirement = this.reflector.get<EntitlementRequirement>(ENTITLEMENT_KEY, ctx.getHandler());
    if (!requirement) return next.handle();
    const user = req.user;
    if (!user) throw Errors.unauthenticated('Sign in to use this feature');
    const subject = requirement.subject(req);

    // Charge before running the handler, so a denied request never does the work.
    return from(this.entitlements.consume(user.id, requirement.featureKey, subject)).pipe(
      switchMap((result) => {
        const res = ctx.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>();
        if (result.entitlement.remaining !== null) res.setHeader('x-entitlement-remaining', String(result.entitlement.remaining));
        return next.handle().pipe(
          catchError((err: unknown) => {
            const serverError = !(err instanceof HttpException) || err.getStatus() >= 500;
            if (result.charged && serverError && result.entitlement.periodKey) {
              return from(this.entitlements.refund(user.id, requirement.featureKey, subject, result.entitlement.periodKey)).pipe(switchMap(() => throwError(() => err)));
            }
            return throwError(() => err);
          }),
        );
      }),
    );
  }
}

/** Server-side enforcement (PDF section 5): hiding a button in the app is not access control. */
export function RequiresEntitlement(featureKey: string, subject: EntitlementRequirement['subject']) {
  return applyDecorators(
    SetMetadata(ENTITLEMENT_KEY, { featureKey, subject } satisfies EntitlementRequirement),
    UseInterceptors(EntitlementInterceptor),
    ApiForbiddenResponse({ description: `ENTITLEMENT_EXCEEDED / ENTITLEMENT_REQUIRED for feature ${featureKey}` }),
  );
}

export const matchSubject = (param = 'matchId') => (req: AuthedRequest) => ({ type: 'match', id: String(req.params[param]) });
