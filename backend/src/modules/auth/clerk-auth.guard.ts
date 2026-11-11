import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthedRequest, IS_PUBLIC } from '../../common/auth.decorators';
import { Errors } from '../../common/errors';
import { UsersService } from '../users/users.service';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider';

function bearer(req: AuthedRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Global guard. Private routes need a valid Clerk session JWT; public routes accept anonymous requests
 * but still attach the user when a valid token is sent. An invalid token is always a 401, so clients refresh it.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const token = bearer(req);
    if (!token) {
      if (isPublic) return true;
      throw Errors.unauthenticated();
    }
    let session;
    try {
      session = await this.identity.verifySessionToken(token);
    } catch (err) {
      this.logger.debug(`token verification error: ${(err as Error).message}`);
      session = null;
    }
    if (!session) throw Errors.unauthenticated('Invalid or expired session token');
    req.user = await this.users.resolveSession(session);
    return true;
  }
}
