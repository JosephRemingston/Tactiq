import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { type AuthUser, CurrentUser, OptionalUser, Public } from '../../common/auth.decorators';
import { zp } from '../../common/zod';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiBearerAuth()
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** Queue (re)analysis of a match. Returns 202 with a job to poll; existing work is returned instead of duplicated. */
  @Post('matches/:matchId/analysis-jobs')
  @HttpCode(202)
  @Throttle({ user: { limit: 10, ttl: 60_000 } })
  async request(@Param('matchId', zp(z.uuid())) matchId: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const job = await this.jobs.requestAnalysis(matchId, user.id);
    res.setHeader('retry-after', '2');
    return job;
  }

  /** Poll for status (SSE is planned; workers already publish job events on Redis). */
  @Public()
  @Get('jobs/:jobId')
  get(@Param('jobId', zp(z.string().regex(/^[\w.-]{3,200}$/))) jobId: string, @OptionalUser() user?: AuthUser) {
    return this.jobs.get(jobId, user?.id);
  }
}
