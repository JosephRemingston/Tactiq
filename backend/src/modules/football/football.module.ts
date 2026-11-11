import { Global, Module } from '@nestjs/common';
import { FootballController } from './football.controller';
import { FootballService } from './football.service';

@Global()
@Module({ controllers: [FootballController], providers: [FootballService], exports: [FootballService] })
export class FootballModule {}
