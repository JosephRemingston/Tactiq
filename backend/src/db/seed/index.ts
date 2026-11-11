import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { databaseUrlFromEnv } from '../../config/env';
import { createDb, type Db } from '../client';
import { dataLicences, metricDefinitions, planDefinitions, tacticalConcepts, type PlanFeature } from '../schema';

export const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;

type MetricDefinitionSeed = typeof metricDefinitions.$inferInsert;
type ConceptSeed = typeof tacticalConcepts.$inferInsert;
type LicenceSeed = typeof dataLicences.$inferInsert;
interface PlansFile {
  plans: Array<{ planKey: string; name: string; features: Record<string, PlanFeature> }>;
}

/** Idempotent: every seed is an upsert keyed by its natural key. */
export async function seed(db: Db): Promise<Record<string, number>> {
  const licences = readJson<LicenceSeed[]>('data_licences.json');
  const metrics = readJson<MetricDefinitionSeed[]>('metric_definitions.json');
  const concepts = readJson<ConceptSeed[]>('tactical_concepts.json');
  const plans = readJson<PlansFile>('plans.json').plans;
  const ex = (col: string) => sql.raw(`excluded.${col}`);

  await db.transaction(async (tx) => {
    await tx
      .insert(dataLicences)
      .values(licences)
      .onConflictDoUpdate({
        target: dataLicences.id,
        set: { name: ex('name'), url: ex('url'), termsSummary: ex('terms_summary'), attributionText: ex('attribution_text'), commercialUseAllowed: ex('commercial_use_allowed'), updatedAt: new Date() },
      });
    await tx
      .insert(metricDefinitions)
      .values(metrics)
      .onConflictDoUpdate({
        target: [metricDefinitions.key, metricDefinitions.version],
        set: {
          name: ex('name'),
          family: ex('family'),
          unit: ex('unit'),
          direction: ex('direction'),
          descriptionQuick: ex('description_quick'),
          descriptionExplore: ex('description_explore'),
          descriptionAdvanced: ex('description_advanced'),
          formula: ex('formula'),
          requires: ex('requires'),
          coverageLabel: ex('coverage_label'),
          providerCaveats: ex('provider_caveats'),
          conceptKeys: ex('concept_keys'),
          status: ex('status'),
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(tacticalConcepts)
      .values(concepts)
      .onConflictDoUpdate({
        target: tacticalConcepts.key,
        set: {
          name: ex('name'),
          category: ex('category'),
          simpleText: ex('simple_text'),
          exploreText: ex('explore_text'),
          advancedText: ex('advanced_text'),
          misconceptions: ex('misconceptions'),
          relatedKeys: ex('related_keys'),
          linkedMetricKeys: ex('linked_metric_keys'),
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(planDefinitions)
      .values(plans)
      .onConflictDoUpdate({ target: planDefinitions.planKey, set: { name: ex('name'), features: ex('features'), updatedAt: new Date() } });
  });
  return { licences: licences.length, metricDefinitions: metrics.length, concepts: concepts.length, plans: plans.length };
}

if (require.main === module) {
  // Only DATABASE_URL is needed, so this can run in a build step without the full runtime configuration.
  const handle = createDb(databaseUrlFromEnv(), 2);
  seed(handle.db)
    .then((counts) => console.log('seeded', counts))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => handle.pool.end());
}
