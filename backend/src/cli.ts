import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { eq, or, sql } from 'drizzle-orm';
import { loadConfig } from './config/env';
import type { Db } from './db/client';
import { users } from './db/schema';
import { DB } from './infra/database/database.module';
import { QueueService } from './infra/queue/queue.service';
import { OBJECT_STORAGE, type ObjectStorage } from './infra/storage/object-storage';
import { WorkerRunner } from './infra/queue/worker-runner';
import { isUuid } from './common/ids';
import { EntitlementsService } from './modules/entitlements/entitlements.service';
import { IngestionService } from './modules/ingestion/ingestion.service';
import { InsightsService } from './modules/insights/insights.service';
import { ProviderRegistry } from './modules/providers/provider-registry';
import { WorkerModule } from './worker.module';

const HELP = `Touchline admin CLI

  sync:statsbomb  [--competition 43 --season 106] [--matches 3869685,8658] [--local <dir>]
                  [--no-ingest] [--force] [--inline] [--timeout 600]
      Sync competitions, matches and (by default) ingest + normalize + analyse played matches.
      --inline runs the workers inside this process and waits for the whole chain.

  jobs:replay     --job-id <id> | --dead-since <hours>  [--inline]
  jobs:status     --trace <traceId>

  analytics:styles
      Recomputes team season styles for every team-season with analysed matches.

  storage:check
      Writes, reads back and verifies a small object in the configured object storage (e.g. your Neon bucket).

  entitlements:grant   --user <email|clerkId|uuid> --plan pro_monthly [--until 2027-01-01] [--actor admin:name]
  entitlements:revoke  --user <email|clerkId|uuid> --plan pro_monthly [--actor admin:name]
  entitlements:expire
`;

async function resolveUser(app: INestApplicationContext, ref: string): Promise<string> {
  const db = app.get<Db>(DB);
  const cond = isUuid(ref) ? eq(users.id, ref) : or(eq(users.email, ref), eq(users.clerkUserId, ref));
  const [row] = await db.select({ id: users.id }).from(users).where(cond);
  if (!row) throw new Error(`user ${ref} not found`);
  return row.id;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      competition: { type: 'string' },
      season: { type: 'string' },
      matches: { type: 'string' },
      local: { type: 'string' },
      'no-ingest': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      inline: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '600' },
      'job-id': { type: 'string' },
      'dead-since': { type: 'string' },
      trace: { type: 'string' },
      user: { type: 'string' },
      plan: { type: 'string' },
      until: { type: 'string' },
      actor: { type: 'string', default: `admin:${process.env.USER ?? 'cli'}` },
    },
    strict: true,
  });
  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return 0;
  }

  const config = loadConfig({ LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' });
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config), { logger: ['error', 'warn'] });
  try {
    switch (command) {
      case 'sync:statsbomb': {
        if (values.local) app.get(ProviderRegistry).useStatsBombLocalDir(values.local);
        if (values.inline) await app.get(WorkerRunner).start();
        const ingestion = app.get(IngestionService);
        const started = await ingestion.startSync({
          provider: 'statsbomb',
          competitionId: values.competition,
          seasonId: values.season,
          matchIds: values.matches?.split(',').map((m) => m.trim()),
          ingestMatches: !values['no-ingest'],
          force: values.force,
        });
        console.log(`enqueued ${started.jobId} (trace ${started.traceId})`);
        if (!values.inline) {
          console.log('workers will process it; check progress with: pnpm cli jobs:status --trace', started.traceId);
          return 0;
        }
        let lastLine = '';
        const summary = await ingestion.waitForTrace(started.traceId, Number(values.timeout) * 1000, (s) => {
          const line = Object.entries(s.counts)
            .map(([t, c]) => `${t}: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}`)
            .join(' | ');
          if (line !== lastLine) console.log(line);
          lastLine = line;
        });
        console.log(JSON.stringify(summary, null, 2));
        return summary.done && summary.failures.every((f) => f.status !== 'dead') ? 0 : 1;
      }
      case 'jobs:status': {
        if (!values.trace) throw new Error('--trace is required');
        console.log(JSON.stringify(await app.get(IngestionService).traceSummary(values.trace), null, 2));
        return 0;
      }
      case 'jobs:replay': {
        const queues = app.get(QueueService);
        const ingestion = app.get(IngestionService);
        const ids = values['job-id'] ? [values['job-id']] : (await ingestion.deadJobs(Number(values['dead-since'] ?? 24))).map((j) => j.jobId);
        if (!ids.length) {
          console.log('nothing to replay');
          return 0;
        }
        if (values.inline) await app.get(WorkerRunner).start();
        const traces = new Set<string>();
        for (const id of ids) {
          const res = await queues.replay(id);
          console.log('replayed', res.jobId);
          if (res.traceId) traces.add(res.traceId);
        }
        if (values.inline) for (const t of traces) console.log(JSON.stringify(await ingestion.waitForTrace(t, Number(values.timeout) * 1000), null, 2));
        return 0;
      }
      case 'entitlements:grant': {
        if (!values.user || !values.plan) throw new Error('--user and --plan are required');
        const userId = await resolveUser(app, values.user);
        const sub = await app.get(EntitlementsService).grantPlan({ userId, planKey: values.plan, until: values.until ? new Date(values.until) : null, actor: values.actor! });
        console.log(`granted ${values.plan} to ${userId} (subscription ${sub.id})`);
        return 0;
      }
      case 'entitlements:revoke': {
        if (!values.user || !values.plan) throw new Error('--user and --plan are required');
        const userId = await resolveUser(app, values.user);
        console.log(`revoked ${await app.get(EntitlementsService).revokePlan({ userId, planKey: values.plan, actor: values.actor! })} entitlement rows`);
        return 0;
      }
      case 'analytics:styles': {
        const db = app.get<Db>(DB);
        const pairs = await db.execute<{ team_id: string; season_id: string; competition_id: string }>(sql`
          select distinct t.team_id, m.season_id, m.competition_id
          from matches m cross join lateral (values (m.home_team_id), (m.away_team_id)) as t(team_id)
          where m.analysis_status = 'complete'`);
        const insights = app.get(InsightsService);
        let labelled = 0;
        for (const p of pairs.rows) labelled += (await insights.computeTeamStyle(p.team_id, p.season_id, p.competition_id)).labels > 0 ? 1 : 0;
        console.log(`recomputed ${pairs.rows.length} team-season styles (${labelled} with labels)`);
        return 0;
      }
      case 'storage:check': {
        const storage = app.get<ObjectStorage>(OBJECT_STORAGE);
        const key = `healthchecks/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const body = Buffer.from(JSON.stringify({ ok: true, at: new Date().toISOString() }));
        await storage.ensureBucket();
        await storage.put(key, body, 'application/json');
        const back = await storage.get(key);
        if (!back.equals(body)) throw new Error('read-back mismatch');
        console.log(`storage ok: driver=${config.STORAGE_DRIVER} bucket=${storage.bucket} wrote and read ${key}`);
        return 0;
      }
      case 'entitlements:expire': {
        console.log(`expired ${await app.get(EntitlementsService).expireDue()} entitlement rows`);
        return 0;
      }
      default:
        console.error(`unknown command ${command}\n\n${HELP}`);
        return 2;
    }
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
