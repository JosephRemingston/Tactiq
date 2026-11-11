import { Global, Module } from '@nestjs/common';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { EntitlementInterceptor } from './requires-entitlement';

@Global()
@Module({ controllers: [EntitlementsController], providers: [EntitlementsService, EntitlementInterceptor], exports: [EntitlementsService, EntitlementInterceptor] })
export class EntitlementsModule {}
