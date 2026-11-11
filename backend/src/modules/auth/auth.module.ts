import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { ClerkAuthGuard } from './clerk-auth.guard';

@Global()
@Module({ imports: [UsersModule], controllers: [ClerkWebhookController], providers: [ClerkAuthGuard], exports: [ClerkAuthGuard, UsersModule] })
export class AuthModule {}
