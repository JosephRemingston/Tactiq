CREATE UNIQUE INDEX "entitlements_subscription_feature_uq" ON "entitlements" USING btree ("source_subscription_id","feature_key") WHERE source_subscription_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_uq" ON "subscriptions" USING btree ("source","provider_subscription_id") WHERE provider_subscription_id is not null;--> statement-breakpoint
CREATE INDEX "purchases_order_idx" ON "purchases" USING btree ("store","order_id");--> statement-breakpoint
CREATE INDEX "purchases_linked_idx" ON "purchases" USING btree ("linked_purchase_token");--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_status_ck" CHECK (status in ('active','revoked','expired'));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status_ck" CHECK (status in ('pending','active','grace','on_hold','paused','cancelled','expired','revoked'));--> statement-breakpoint
ALTER TABLE "billing_notifications" ADD CONSTRAINT "billing_notifications_status_ck" CHECK (status in ('received','processed','ignored','failed'));--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_state_ck" CHECK (state in ('pending','active','grace','on_hold','paused','cancelled','expired','revoked'));