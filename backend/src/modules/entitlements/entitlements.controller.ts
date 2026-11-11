import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth.decorators';
import { EntitlementsService } from './entitlements.service';

@ApiTags('entitlements')
@ApiBearerAuth()
@Controller()
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  /** Effective limits and current usage for every feature key. */
  @Get('entitlements')
  async list(@CurrentUser() user: AuthUser) {
    const [plan, data] = await Promise.all([this.entitlements.currentPlan(user.id), this.entitlements.resolveAll(user.id)]);
    return { plan, data };
  }

  /** Read-only in the MVP; Google Play Billing arrives with Milestone 6. */
  @Get('billing/subscription')
  async subscription(@CurrentUser() user: AuthUser) {
    return { plan: await this.entitlements.currentPlan(user.id), billingProvider: null, manageUrl: null };
  }
}
