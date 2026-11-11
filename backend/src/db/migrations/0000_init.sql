CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_name" text,
	"gender" text,
	"is_youth" boolean DEFAULT false NOT NULL,
	"is_international" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"terms_summary" text NOT NULL,
	"attribution_text" text NOT NULL,
	"commercial_use_allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lineups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"jersey_number" integer,
	"position_name" text,
	"position_group" text,
	"is_starter" boolean DEFAULT false NOT NULL,
	"minute_on" integer,
	"minute_off" integer,
	"cards" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineups_match_team_player_uq" UNIQUE("match_id","team_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "match_coverage" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"has_lineups" boolean DEFAULT false NOT NULL,
	"has_events" boolean DEFAULT false NOT NULL,
	"has_freeze_frames" boolean DEFAULT false NOT NULL,
	"has_tracking" boolean DEFAULT false NOT NULL,
	"has_video" boolean DEFAULT false NOT NULL,
	"event_provider" text,
	"event_schema_version" text,
	"taxonomy_version" integer,
	"events_count" integer DEFAULT 0 NOT NULL,
	"freeze_frame_count" integer DEFAULT 0 NOT NULL,
	"provider_last_updated_at" timestamp with time zone,
	"provider_last_updated360_at" timestamp with time zone,
	"provider360_status" text,
	"licence_id" text,
	"retrieved_at" timestamp with time zone,
	"data_quality" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"match_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"side" text NOT NULL,
	"starting_formation" text,
	"manager_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_participants_match_id_team_id_pk" PRIMARY KEY("match_id","team_id"),
	CONSTRAINT "match_participants_side_uq" UNIQUE("match_id","side")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"competition_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"match_date" date NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"match_week" integer,
	"stage" text,
	"stadium_name" text,
	"referee_name" text,
	"pitch_length_m" double precision DEFAULT 105 NOT NULL,
	"pitch_width_m" double precision DEFAULT 68 NOT NULL,
	"analysis_status" text DEFAULT 'none' NOT NULL,
	"analysis_run_id" uuid,
	"analytics_version" integer,
	"analysed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_natural_uq" UNIQUE("competition_id","season_id","home_team_id","away_team_id","match_date")
);
--> statement-breakpoint
CREATE TABLE "player_team_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"jersey_number" integer,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pta_player_team_season_uq" UNIQUE("player_id","team_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"known_name" text,
	"birth_date" date,
	"country_name" text,
	"primary_position" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_entity_maps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"provider_entity_id" text NOT NULL,
	"canonical_id" uuid NOT NULL,
	"provider_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_entity_maps_uq" UNIQUE("provider","entity_type","provider_entity_id")
);
--> statement-breakpoint
CREATE TABLE "provider_sync_state" (
	"provider" text NOT NULL,
	"scope_key" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_seen_sha256" text,
	"last_provider_updated_at" timestamp with time zone,
	CONSTRAINT "provider_sync_state_provider_scope_key_pk" PRIMARY KEY("provider","scope_key")
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"payload_kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"etag" text,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"schema_version" text NOT NULL,
	"licence_id" text,
	"is_latest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_payloads_sha_uq" UNIQUE("provider","payload_kind","scope_key","sha256")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"competition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_competition_name_uq" UNIQUE("competition_id","name")
);
--> statement-breakpoint
CREATE TABLE "tactical_concepts" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"simple_text" text NOT NULL,
	"explore_text" text NOT NULL,
	"advanced_text" text NOT NULL,
	"misconceptions" text,
	"related_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"linked_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"country_name" text,
	"gender" text,
	"is_national_team" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_freeze_frames" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"visible_area" jsonb,
	"frame" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"sequence_index" integer NOT NULL,
	"period" smallint NOT NULL,
	"clock_seconds" double precision NOT NULL,
	"minute" integer NOT NULL,
	"second" integer NOT NULL,
	"type_key" text NOT NULL,
	"provider_type_name" text NOT NULL,
	"team_id" uuid,
	"player_id" uuid,
	"position_name" text,
	"possession_id" integer NOT NULL,
	"possession_team_id" uuid,
	"play_pattern" text,
	"x" double precision,
	"y" double precision,
	"end_x" double precision,
	"end_y" double precision,
	"raw_x" double precision,
	"raw_y" double precision,
	"raw_end_x" double precision,
	"raw_end_y" double precision,
	"outcome" text,
	"under_pressure" boolean DEFAULT false NOT NULL,
	"counterpress" boolean DEFAULT false NOT NULL,
	"duration" double precision,
	"related_event_ids" uuid[],
	"detail" jsonb,
	"raw" jsonb,
	"taxonomy_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_provider_event_uq" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"analytics_version" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"calculators" jsonb NOT NULL,
	"coverage_snapshot" jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"team_id" uuid,
	"player_id" uuid,
	"kind" text NOT NULL,
	"family" text NOT NULL,
	"rank" integer,
	"score" double precision NOT NULL,
	"headline" text NOT NULL,
	"what_happened" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" text NOT NULL,
	"coverage_label" text NOT NULL,
	"completeness" double precision NOT NULL,
	"explore_link" jsonb NOT NULL,
	"depth" jsonb NOT NULL,
	"template_key" text NOT NULL,
	"template_version" integer NOT NULL,
	"generator_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insights_run_kind_uq" UNIQUE NULLS NOT DISTINCT("analysis_run_id","kind","team_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "match_possessions" (
	"match_id" uuid NOT NULL,
	"possession_id" integer NOT NULL,
	"team_id" uuid,
	"period" integer NOT NULL,
	"start_event_id" uuid NOT NULL,
	"end_event_id" uuid NOT NULL,
	"start_clock" double precision NOT NULL,
	"end_clock" double precision NOT NULL,
	"start_x" double precision,
	"start_y" double precision,
	"end_type" text NOT NULL,
	"n_events" integer NOT NULL,
	"n_passes" integer NOT NULL,
	"reached_final_third" boolean NOT NULL,
	"reached_box" boolean NOT NULL,
	"xt_net" double precision NOT NULL,
	"xg_total" double precision NOT NULL,
	"play_pattern" text,
	CONSTRAINT "match_possessions_match_id_possession_id_pk" PRIMARY KEY("match_id","possession_id")
);
--> statement-breakpoint
CREATE TABLE "match_stories" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"analysis_run_id" uuid,
	"kind" text NOT NULL,
	"short_version" text NOT NULL,
	"team_approaches" jsonb NOT NULL,
	"key_pattern_insight_ids" uuid[] NOT NULL,
	"what_changed" jsonb NOT NULL,
	"key_players" jsonb NOT NULL,
	"evidence_links" jsonb NOT NULL,
	"coverage_statement" text NOT NULL,
	"generator_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"unit" text NOT NULL,
	"direction" text NOT NULL,
	"description_quick" text NOT NULL,
	"description_explore" text NOT NULL,
	"description_advanced" text NOT NULL,
	"formula" text NOT NULL,
	"requires" jsonb NOT NULL,
	"coverage_label" text NOT NULL,
	"provider_caveats" jsonb NOT NULL,
	"concept_keys" text[],
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_definitions_key_version_pk" PRIMARY KEY("key","version")
);
--> statement-breakpoint
CREATE TABLE "tactical_metrics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tactical_metrics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"analysis_run_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"team_id" uuid,
	"player_id" uuid,
	"metric_key" text NOT NULL,
	"metric_version" integer NOT NULL,
	"scope" text NOT NULL,
	"value" double precision,
	"value_json" jsonb,
	"sample_size" integer NOT NULL,
	"minutes" double precision,
	"coverage_label" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tactical_metrics_uq" UNIQUE NULLS NOT DISTINCT("match_id","metric_key","metric_version","scope","team_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "team_season_styles" (
	"team_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"matches_analysed" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"labels" jsonb NOT NULL,
	"analytics_version" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_season_styles_team_id_season_id_pk" PRIMARY KEY("team_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"progress" jsonb,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"requested_by_user_id" uuid,
	"scope" text NOT NULL,
	"provider" text,
	"provider_match_id" text,
	"match_id" uuid,
	"schema_version" integer NOT NULL,
	"trace_id" text NOT NULL,
	"parent_job_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followed_competitions" (
	"user_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followed_competitions_user_id_competition_id_pk" PRIMARY KEY("user_id","competition_id")
);
--> statement-breakpoint
CREATE TABLE "followed_players" (
	"user_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followed_players_user_id_player_id_pk" PRIMARY KEY("user_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "followed_teams" (
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "followed_teams_user_id_team_id_pk" PRIMARY KEY("user_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "learning_progress" (
	"owner_user_id" uuid NOT NULL,
	"concept_key" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_progress_owner_user_id_concept_key_pk" PRIMARY KEY("owner_user_id","concept_key")
);
--> statement-breakpoint
CREATE TABLE "saved_insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_insights_owner_insight_uq" UNIQUE("owner_user_id","insight_id")
);
--> statement-breakpoint
CREATE TABLE "saved_matches" (
	"user_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_matches_user_id_match_id_pk" PRIMARY KEY("user_id","match_id")
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_collection_items" (
	"collection_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_collection_items_collection_id_item_type_item_id_pk" PRIMARY KEY("collection_id","item_type","item_id")
);
--> statement-breakpoint
CREATE TABLE "user_collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_subject_uq" UNIQUE("provider","provider_subject")
);
--> statement-breakpoint
CREATE TABLE "user_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"body" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"depth_preference" text DEFAULT 'quick' NOT NULL,
	"interests" text[],
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_uq" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "entitlement_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"feature_key" text,
	"before" jsonb,
	"after" jsonb,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage" (
	"user_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"period_key" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_usage_user_id_feature_key_period_key_pk" PRIMARY KEY("user_id","feature_key","period_key")
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"period_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_usage_events_uq" UNIQUE("user_id","feature_key","period_key","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"limit_value" integer,
	"usage_period" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"source_plan" text NOT NULL,
	"source_subscription_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_definitions" (
	"plan_key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"features" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_key" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"provider_subscription_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_coverage" ADD CONSTRAINT "match_coverage_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_coverage" ADD CONSTRAINT "match_coverage_licence_id_data_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."data_licences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_assignments" ADD CONSTRAINT "player_team_assignments_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_assignments" ADD CONSTRAINT "player_team_assignments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_team_assignments" ADD CONSTRAINT "player_team_assignments_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_payloads" ADD CONSTRAINT "raw_payloads_licence_id_data_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."data_licences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_freeze_frames" ADD CONSTRAINT "event_freeze_frames_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_freeze_frames" ADD CONSTRAINT "event_freeze_frames_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_possessions" ADD CONSTRAINT "match_possessions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_stories" ADD CONSTRAINT "match_stories_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tactical_metrics" ADD CONSTRAINT "tactical_metrics_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tactical_metrics" ADD CONSTRAINT "tactical_metrics_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_season_styles" ADD CONSTRAINT "team_season_styles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_season_styles" ADD CONSTRAINT "team_season_styles_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_season_styles" ADD CONSTRAINT "team_season_styles_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_competitions" ADD CONSTRAINT "followed_competitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_competitions" ADD CONSTRAINT "followed_competitions_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_players" ADD CONSTRAINT "followed_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_players" ADD CONSTRAINT "followed_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_teams" ADD CONSTRAINT "followed_teams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followed_teams" ADD CONSTRAINT "followed_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_progress" ADD CONSTRAINT "learning_progress_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_insights" ADD CONSTRAINT "saved_insights_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_insights" ADD CONSTRAINT "saved_insights_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."insights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_insights" ADD CONSTRAINT "saved_insights_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_matches" ADD CONSTRAINT "saved_matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_matches" ADD CONSTRAINT "saved_matches_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_collection_items" ADD CONSTRAINT "user_collection_items_collection_id_user_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."user_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_collections" ADD CONSTRAINT "user_collections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_audit" ADD CONSTRAINT "entitlement_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage" ADD CONSTRAINT "entitlement_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_events" ADD CONSTRAINT "entitlement_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_key_plan_definitions_plan_key_fk" FOREIGN KEY ("plan_key") REFERENCES "public"."plan_definitions"("plan_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitions_name_trgm" ON "competitions" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "lineups_match_idx" ON "lineups" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "matches_comp_season_kickoff_idx" ON "matches" USING btree ("competition_id","season_id","kickoff_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "matches_home_kickoff_idx" ON "matches" USING btree ("home_team_id","kickoff_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "matches_away_kickoff_idx" ON "matches" USING btree ("away_team_id","kickoff_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "matches_kickoff_idx" ON "matches" USING btree ("kickoff_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pta_team_season_idx" ON "player_team_assignments" USING btree ("team_id","season_id");--> statement-breakpoint
CREATE INDEX "players_full_name_trgm" ON "players" USING gin ("full_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "players_known_name_trgm" ON "players" USING gin ("known_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "provider_entity_maps_canonical_idx" ON "provider_entity_maps" USING btree ("entity_type","canonical_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_payloads_latest_uq" ON "raw_payloads" USING btree ("provider","payload_kind","scope_key") WHERE is_latest = true;--> statement-breakpoint
CREATE INDEX "teams_name_trgm" ON "teams" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "event_freeze_frames_match_idx" ON "event_freeze_frames" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "events_match_seq_idx" ON "events" USING btree ("match_id","sequence_index");--> statement-breakpoint
CREATE INDEX "events_match_team_type_idx" ON "events" USING btree ("match_id","team_id","type_key");--> statement-breakpoint
CREATE INDEX "events_match_player_idx" ON "events" USING btree ("match_id","player_id");--> statement-breakpoint
CREATE INDEX "events_match_possession_idx" ON "events" USING btree ("match_id","possession_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_match_idx" ON "analysis_runs" USING btree ("match_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "insights_match_rank_idx" ON "insights" USING btree ("match_id","rank");--> statement-breakpoint
CREATE INDEX "match_possessions_team_idx" ON "match_possessions" USING btree ("match_id","team_id");--> statement-breakpoint
CREATE INDEX "tactical_metrics_match_key_idx" ON "tactical_metrics" USING btree ("match_id","metric_key");--> statement-breakpoint
CREATE INDEX "tactical_metrics_team_key_idx" ON "tactical_metrics" USING btree ("team_id","metric_key","metric_version","scope");--> statement-breakpoint
CREATE INDEX "tactical_metrics_player_key_idx" ON "tactical_metrics" USING btree ("player_id","metric_key");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_match_idx" ON "ingestion_jobs" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_user_idx" ON "ingestion_jobs" USING btree ("requested_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "followed_competitions_comp_idx" ON "followed_competitions" USING btree ("competition_id");--> statement-breakpoint
CREATE INDEX "followed_players_player_idx" ON "followed_players" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "followed_teams_team_idx" ON "followed_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "saved_insights_owner_idx" ON "saved_insights" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_events_kind_idx" ON "security_events" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_collections_owner_idx" ON "user_collections" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_notes_owner_subject_idx" ON "user_notes" USING btree ("owner_user_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "user_notes_owner_created_idx" ON "user_notes" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entitlement_audit_user_idx" ON "entitlement_audit" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "entitlements_user_feature_idx" ON "entitlements" USING btree ("user_id","feature_key","status");--> statement-breakpoint
CREATE INDEX "subscriptions_user_status_idx" ON "subscriptions" USING btree ("user_id","status");