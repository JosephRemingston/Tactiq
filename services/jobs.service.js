import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import ApiError from "../utils/ApiError.js";
import { ingestionJobs, matchCoverage, matches } from "../models/index.js";
import { JOB_TYPES, jobIds, QUEUES } from "../queues/constants.js";
import { PRIORITY } from "../queues/queue.js";
import { ANALYTICS_VERSION } from "./analytics/version.js";
const PUBLIC_JOB_TYPES = new Set([JOB_TYPES.analyseMatch, JOB_TYPES.generateInsights]);
export class JobsService {
  constructor(db, queues, entitlements) {
    this.db = db;
    this.queues = queues;
    this.entitlements = entitlements;
  }
  shape(row) {
    return {
      jobId: row.jobId,
      type: row.jobType,
      status: row.status,
      progress: row.progress ?? null,
      matchId: row.matchId,
      attempts: row.attempts,
      error:
        row.status === "dead" || row.status === "failed"
          ? "The job failed. It will be retried automatically or reviewed by the team."
          : null,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }
  /**
   * Requests analysis of a match. Charges `analysis.rerun_per_month` only when new work is actually scheduled;
   * an already analysed or in-progress match returns the existing job.
   */
  async requestAnalysis(matchId, userId) {
    const [m] = await this.db
      .select({
        status: matches.analysisStatus,
        version: matches.analyticsVersion,
        hasEvents: matchCoverage.hasEvents,
        eventsCount: matchCoverage.eventsCount,
        retrievedAt: matchCoverage.retrievedAt,
        taxonomy: matchCoverage.taxonomyVersion,
      })
      .from(matches)
      .leftJoin(matchCoverage, eq(matchCoverage.matchId, matches.id))
      .where(eq(matches.id, matchId));
    if (!m) throw ApiError.notFound("Match");
    if (!m.hasEvents) throw ApiError.conflict("This match has no event data, so it cannot be analysed");
    const [latest] = await this.db
      .select()
      .from(ingestionJobs)
      .where(and(eq(ingestionJobs.matchId, matchId), eq(ingestionJobs.jobType, JOB_TYPES.analyseMatch)))
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(1);
    const upToDate = m.status === "complete" && m.version === ANALYTICS_VERSION;
    if (latest && (upToDate || latest.status === "queued" || latest.status === "active")) {
      return { ...this.shape(latest), existing: true };
    }
    // Analysed with the current version but the job row is gone (e.g. cleaned up): nothing to do, nothing to charge.
    if (upToDate) {
      return { jobId: null, type: JOB_TYPES.analyseMatch, status: "completed", progress: null, matchId, attempts: 0, error: null, existing: true };
    }
    const inputVersion = createHash("sha256")
      .update(`${m.eventsCount}|${m.retrievedAt?.toISOString() ?? ""}|t${m.taxonomy ?? 0}`)
      .digest("hex");
    const jobId = jobIds.analyseMatch(matchId, ANALYTICS_VERSION, inputVersion);
    const charge = await this.entitlements.consume(userId, "analysis.rerun_per_month", { type: "match", id: matchId });
    const refund = () =>
      charge.charged && charge.entitlement.periodKey
        ? this.entitlements.refund(userId, "analysis.rerun_per_month", { type: "match", id: matchId }, charge.entitlement.periodKey).catch(() => undefined)
        : undefined;
    let res;
    try {
      res = await this.queues.enqueue({
        queue: QUEUES.tacticalAnalytics,
        jobType: JOB_TYPES.analyseMatch,
        jobId,
        payload: { matchId, reason: "user_request" },
        matchId,
        requestedByUserId: userId,
        priority: PRIORITY.user,
      });
    } catch (err) {
      await refund(); // nothing was queued, so nothing is owed
      throw err;
    }
    // The same job already exists and is not failed: no new work was scheduled, so no charge either.
    if (!res.created && res.status !== "dead" && res.status !== "failed") await refund();
    if (!res.created && (res.status === "dead" || res.status === "failed")) await this.queues.replay(jobId);
    if (res.created) await this.db.update(matches).set({ analysisStatus: "queued" }).where(eq(matches.id, matchId));
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    return { ...this.shape(row), existing: !res.created };
  }
  /** Job status. Visible to its requester, or to anyone for public match-analysis jobs; otherwise 404. */
  async get(jobId, userId) {
    const [row] = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.jobId, jobId));
    if (!row) throw ApiError.notFound("Job");
    const visible =
      (row.requestedByUserId !== null && row.requestedByUserId === userId) || (PUBLIC_JOB_TYPES.has(row.jobType) && row.matchId !== null);
    if (!visible) throw ApiError.notFound("Job");
    return this.shape(row);
  }
}
