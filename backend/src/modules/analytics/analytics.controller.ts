import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pageQuery } from '../../common/pagination';
import { ApiZod, zp } from '../../common/zod';
import { POSSESSION_END_TYPES, SCOPES } from '../../db/schema';
import { matchSubject, RequiresEntitlement } from '../entitlements/requires-entitlement';
import { AnalyticsService } from './analytics.service';

const id = zp(z.uuid());
const metricsQuery = z.object({
  scope: z.enum(SCOPES).optional(),
  teamId: z.uuid().optional(),
  playerId: z.union([z.uuid(), z.literal('none')]).optional().describe("Player id, or 'none' for team-level metrics only"),
  keys: z
    .string()
    .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z0-9_.]+$/)).max(50))
    .optional(),
  include: z.enum(['definitions']).optional(),
});
const shapeQuery = z.object({ scope: z.enum(['full', '1H', '2H']).default('full') });
const possessionsQuery = pageQuery(50, 200).extend({ teamId: z.uuid().optional(), endType: z.enum(POSSESSION_END_TYPES).optional() });
const compareQuery = z.object({ a: z.uuid(), b: z.uuid(), teamId: z.uuid().optional() });

/**
 * Explore / Advanced depth views. Metered under `analysis.matches_per_month`: opening any number of these views
 * for the same match costs one unit per month. Match summary, timeline, insights and story stay free.
 */
@ApiTags('analytics')
@ApiBearerAuth()
@Controller('matches')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('compare')
  @ApiZod({ query: compareQuery })
  @RequiresEntitlement('comparisons.per_month', (req) => {
    const ids = [String(req.query.a), String(req.query.b)].sort();
    return { type: 'match_pair', id: `${ids[0]}:${ids[1]}:${String(req.query.teamId ?? '')}` };
  })
  compare(@Query(zp(compareQuery)) q: z.infer<typeof compareQuery>) {
    return this.analytics.compare(q.a, q.b, q.teamId);
  }

  @Get(':matchId/metrics')
  @ApiZod({ query: metricsQuery })
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  metrics(@Param('matchId', id) matchId: string, @Query(zp(metricsQuery)) q: z.infer<typeof metricsQuery>) {
    return this.analytics.metrics(matchId, { scope: q.scope, teamId: q.teamId, playerId: q.playerId === 'none' ? null : q.playerId, keys: q.keys, includeDefinitions: q.include === 'definitions' });
  }

  @Get(':matchId/tactical-shape')
  @ApiZod({ query: shapeQuery })
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  shape(@Param('matchId', id) matchId: string, @Query(zp(shapeQuery)) q: z.infer<typeof shapeQuery>) {
    return this.analytics.tacticalShape(matchId, q.scope);
  }

  @Get(':matchId/pressing')
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  pressing(@Param('matchId', id) matchId: string) {
    return this.analytics.pressing(matchId);
  }

  @Get(':matchId/transitions')
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  transitions(@Param('matchId', id) matchId: string) {
    return this.analytics.transitions(matchId);
  }

  @Get(':matchId/possessions')
  @ApiZod({ query: possessionsQuery })
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  possessions(@Param('matchId', id) matchId: string, @Query(zp(possessionsQuery)) q: z.infer<typeof possessionsQuery>) {
    return this.analytics.possessions(matchId, q);
  }

  @Get(':matchId/players/:playerId')
  @RequiresEntitlement('analysis.matches_per_month', matchSubject())
  player(@Param('matchId', id) matchId: string, @Param('playerId', id) playerId: string) {
    return this.analytics.player(matchId, playerId);
  }
}
