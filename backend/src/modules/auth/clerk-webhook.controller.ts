import { Controller, Headers, HttpCode, Logger, Post, Req, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import { Public } from '../../common/auth.decorators';
import { Errors } from '../../common/errors';
import { SecurityEventsService } from '../audit/security-events.service';
import { UsersService } from '../users/users.service';
import { IDENTITY_PROVIDER, type IdentityProvider, toProfile } from './identity-provider';

/** Clerk user lifecycle webhooks (Svix-signed). Replays with an already-processed delivery id are no-ops. */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller({ path: 'webhooks/clerk', version: ['1', VERSION_NEUTRAL] })
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly users: UsersService,
    private readonly security: SecurityEventsService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string>) {
    if (!req.rawBody) throw Errors.validation([{ path: 'body', message: 'raw body required' }]);
    let event;
    try {
      event = await this.identity.verifyWebhook(req.rawBody, headers);
    } catch (err) {
      await this.security.record('webhook_rejected', { ip: req.ip, metadata: { reason: (err as Error).message } });
      throw Errors.unauthenticated('Invalid webhook signature');
    }
    if (event.id && (await this.security.webhookSeen(event.id))) return { received: true, duplicate: true };

    const clerkUserId = typeof event.data.id === 'string' ? event.data.id : null;
    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        if (clerkUserId) {
          await this.users.upsert(toProfile(event.data), 'webhook');
          await this.users.invalidate(clerkUserId);
        }
        break;
      case 'user.deleted':
        if (clerkUserId) await this.users.deleteAccount({ clerkUserId, initiatedBy: 'clerk_webhook' });
        break;
      default:
        this.logger.debug(`ignoring Clerk webhook ${event.type}`);
    }
    await this.security.record('webhook_received', { ip: req.ip, metadata: { deliveryId: event.id, type: event.type, clerkUserId } });
    return { received: true };
  }
}
