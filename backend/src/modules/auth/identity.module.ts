import { Global, Module } from '@nestjs/common';
import { ClerkIdentityProvider, IDENTITY_PROVIDER } from './identity-provider';

@Global()
@Module({ providers: [{ provide: IDENTITY_PROVIDER, useClass: ClerkIdentityProvider }], exports: [IDENTITY_PROVIDER] })
export class IdentityModule {}
