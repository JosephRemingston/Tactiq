import { sql } from "drizzle-orm";
import licences from "../data/data_licences.json" with { type: "json" };
import metrics from "../data/metric_definitions.json" with { type: "json" };
import concepts from "../data/tactical_concepts.json" with { type: "json" };
import PLANS from "../data/plans.json" with { type: "json" };
import { dataLicences, metricDefinitions, planDefinitions, tacticalConcepts } from "../models/index.js";
/** Idempotent: every seed is an upsert keyed by its natural key. */
export async function seed(db) {
  const plans = PLANS.plans;
  const ex = (col) => sql.raw(`excluded.${col}`);
  await db.transaction(async (tx) => {
    await tx
      .insert(dataLicences)
      .values(licences)
      .onConflictDoUpdate({
        target: dataLicences.id,
        set: {
          name: ex("name"),
          url: ex("url"),
          termsSummary: ex("terms_summary"),
          attributionText: ex("attribution_text"),
          commercialUseAllowed: ex("commercial_use_allowed"),
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(metricDefinitions)
      .values(metrics)
      .onConflictDoUpdate({
        target: [metricDefinitions.key, metricDefinitions.version],
        set: {
          name: ex("name"),
          family: ex("family"),
          unit: ex("unit"),
          direction: ex("direction"),
          descriptionQuick: ex("description_quick"),
          descriptionExplore: ex("description_explore"),
          descriptionAdvanced: ex("description_advanced"),
          formula: ex("formula"),
          requires: ex("requires"),
          coverageLabel: ex("coverage_label"),
          providerCaveats: ex("provider_caveats"),
          conceptKeys: ex("concept_keys"),
          status: ex("status"),
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(tacticalConcepts)
      .values(concepts)
      .onConflictDoUpdate({
        target: tacticalConcepts.key,
        set: {
          name: ex("name"),
          category: ex("category"),
          simpleText: ex("simple_text"),
          exploreText: ex("explore_text"),
          advancedText: ex("advanced_text"),
          misconceptions: ex("misconceptions"),
          relatedKeys: ex("related_keys"),
          linkedMetricKeys: ex("linked_metric_keys"),
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(planDefinitions)
      .values(plans)
      .onConflictDoUpdate({ target: planDefinitions.planKey, set: { name: ex("name"), features: ex("features"), updatedAt: new Date() } });
  });
  return { licences: licences.length, metricDefinitions: metrics.length, concepts: concepts.length, plans: plans.length };
}
