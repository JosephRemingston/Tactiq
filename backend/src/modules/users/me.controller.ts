import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type AuthedRequest, type AuthUser, CurrentUser } from '../../common/auth.decorators';
import { Errors } from '../../common/errors';
import { ApiZod, zp } from '../../common/zod';
import { DEPTHS } from '../../db/schema';
import { SecurityEventsService } from '../audit/security-events.service';
import { IDENTITY_PROVIDER, type IdentityProvider } from '../auth/identity-provider';
import { UsersService } from './users.service';

const patchMe = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
    depthPreference: z.enum(DEPTHS).optional().describe('Default explanation depth; users can still switch per screen'),
    interests: z.array(z.enum(['match_explanations', 'tactics', 'players', 'learning', 'detailed_stats'])).max(5).optional(),
  })
  .strict();

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly security: SecurityEventsService,
  ) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.users.getMe(user.id);
  }

  @Patch()
  @ApiZod({ body: patchMe })
  update(@CurrentUser() user: AuthUser, @Body(zp(patchMe)) body: z.infer<typeof patchMe>) {
    return this.users.updateMe(user, body);
  }

  /** Deletes private data and the Clerk identity. Shared football data is untouched. */
  @Delete()
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Req() req: AuthedRequest) {
    await this.security.record('account_delete_requested', { userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    return this.users.deleteAccount({ userId: user.id, clerkUserId: user.clerkUserId, initiatedBy: 'user', ip: req.ip });
  }

  @Get('sessions')
  async sessions(@CurrentUser() user: AuthUser) {
    return { data: await this.identity.listSessions(user.clerkUserId) };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(200)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId', zp(z.string().min(1).max(64))) sessionId: string, @Req() req: AuthedRequest) {
    const ok = await this.identity.revokeSession(user.clerkUserId, sessionId);
    if (!ok) throw Errors.notFound('Session');
    await this.security.record('session_revoked', { userId: user.id, ip: req.ip, metadata: { sessionId } });
    return { revoked: true };
  }
}
