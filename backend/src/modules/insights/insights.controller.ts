import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../../common/auth.decorators';
import { ApiZod, zp } from '../../common/zod';
import { DEPTHS } from '../../db/schema';
import { InsightsService } from './insights.service';

const id = zp(z.uuid());
const depthQuery = z.object({ depth: z.enum(DEPTHS).default('quick').describe('Explanation depth: quick, explore or advanced') });

/** Fan-first layer: free and public (PDF: never paywall the match explanation). */
@ApiTags('insights')
@Public()
@Controller()
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('matches/:matchId/insights')
  @ApiZod({ query: depthQuery })
  list(@Param('matchId', id) matchId: string, @Query(zp(depthQuery)) q: z.infer<typeof depthQuery>) {
    return this.insights.listInsights(matchId, q.depth);
  }

  @Get('matches/:matchId/story')
  @ApiZod({ query: depthQuery })
  story(@Param('matchId', id) matchId: string, @Query(zp(depthQuery)) q: z.infer<typeof depthQuery>) {
    return this.insights.getStory(matchId, q.depth);
  }

  @Get('teams/:teamId/style')
  @ApiZod({ query: z.object({ seasonId: z.uuid().optional() }) })
  style(@Param('teamId', id) teamId: string, @Query(zp(z.object({ seasonId: z.uuid().optional() }))) q: { seasonId?: string }) {
    return this.insights.getTeamStyle(teamId, q.seasonId);
  }
}
