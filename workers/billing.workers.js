import { JOB_TYPES, QUEUES } from "../queues/constants.js";

/** Daily: re-reads store purchases that may have changed without a notification (PDF section 8). */
export class BillingReconcileHandler {
  constructor(registry, billing) {
    this.registry = registry;
    this.billing = billing;
    this.queue = QUEUES.billingReconciliation;
    this.jobType = JOB_TYPES.billingReconcile;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  async handle() {
    const result = await this.billing.reconcile();
    return { status: result.skipped ? "skipped" : "completed", result };
  }
}

/** Daily: marks grants past their end date as expired (resolution already ignores them). */
export class EntitlementsExpireHandler {
  constructor(registry, entitlements) {
    this.registry = registry;
    this.entitlements = entitlements;
    this.queue = QUEUES.billingReconciliation;
    this.jobType = JOB_TYPES.entitlementsExpire;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  async handle() {
    return { status: "completed", result: { expired: await this.entitlements.expireDue() } };
  }
}
