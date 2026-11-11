import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import type { AuthedRequest } from './auth.decorators';

/**
 * Two named throttlers: `ip` applies to anonymous requests, `user` to authenticated ones (tracked by user id).
 * Runs after the auth guard so req.user is known.
 */
@Injectable()
export class TouchlineThrottlerGuard extends ThrottlerGuard {
  protected override async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const req = props.context.switchToHttp().getRequest<AuthedRequest>();
    const authed = Boolean(req.user);
    if (props.throttler.name === 'user' && !authed) return true;
    if (props.throttler.name === 'ip' && authed) return true;
    return super.handleRequest(props);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as AuthedRequest;
    return r.user ? `user:${r.user.id}` : `ip:${r.ip ?? 'unknown'}`;
  }
}
