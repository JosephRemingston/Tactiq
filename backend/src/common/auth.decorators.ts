import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Depth } from '../db/schema';
import { Errors } from './errors';

export interface AuthUser {
  id: string;
  clerkUserId: string;
  depthPreference: Depth;
}
export type AuthedRequest = Request & { user?: AuthUser; id?: string };

export const IS_PUBLIC = 'touchline:isPublic';
/** Route is reachable without a session. If a valid token is sent anyway, req.user is still populated. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The authenticated user, derived only from the verified token (never from client-supplied ids). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw Errors.unauthenticated();
  return user;
});

export const OptionalUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => ctx.switchToHttp().getRequest<AuthedRequest>().user);
