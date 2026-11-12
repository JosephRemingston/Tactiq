CREATE TABLE "billing_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store" text NOT NULL,
	"message_id" text NOT NULL,
	"notification_type" text,
	"purchase_token" text,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_notifications_message_uq" UNIQUE("store","message_id")
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"store" text NOT NULL,
	"product_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"purchase_token" text NOT NULL,
	"linked_purchase_token" text,
	"order_id" text,
	"state" text NOT NULL,
	"auto_renewing" boolean DEFAULT false NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_store_token_uq" UNIQUE("store","purchase_token")
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_notifications_token_idx" ON "billing_notifications" USING btree ("purchase_token");--> statement-breakpoint
CREATE INDEX "purchases_user_idx" ON "purchases" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purchases_state_idx" ON "purchases" USING btree ("state","expires_at");