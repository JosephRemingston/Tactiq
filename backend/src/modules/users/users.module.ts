import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { UsersService } from './users.service';

@Module({ controllers: [MeController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
