CREATE TABLE "ai_turn_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_no" integer NOT NULL,
	"model_used" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"raw_prompt" text,
	"raw_completion" text,
	"error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battle_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_instance_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"active_events" jsonb DEFAULT '[]'::jsonb,
	"npc_relations" jsonb DEFAULT '{}'::jsonb,
	"faction_reputation" jsonb DEFAULT '{}'::jsonb,
	"unlocked_locations" text[] DEFAULT '{}',
	"rumor_pool" jsonb DEFAULT '[]'::jsonb,
	"available_runs" jsonb DEFAULT '[]'::jsonb,
	"political_tension_level" integer DEFAULT 1 NOT NULL,
	"growth_points" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hub_states_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "node_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_index" integer NOT NULL,
	"node_type" text NOT NULL,
	"node_state" jsonb,
	"node_meta" jsonb,
	"environment_tags" text[],
	"status" text DEFAULT 'NODE_ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"node_instance_id" uuid NOT NULL,
	"node_facts" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"permanent_stats" jsonb NOT NULL,
	"unlocked_traits" text[] DEFAULT '{}',
	"magic_access_flags" text[] DEFAULT '{}',
	"story_progress" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "player_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "recent_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_no" integer NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"theme" jsonb NOT NULL,
	"story_summary" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_memories_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "run_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'RUN_ACTIVE' NOT NULL,
	"run_type" text NOT NULL,
	"act_level" integer DEFAULT 1 NOT NULL,
	"chapter_index" integer DEFAULT 0 NOT NULL,
	"current_node_index" integer DEFAULT 0 NOT NULL,
	"current_turn_no" integer DEFAULT 0 NOT NULL,
	"seed" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_no" integer NOT NULL,
	"node_instance_id" uuid NOT NULL,
	"node_type" text NOT NULL,
	"input_type" text NOT NULL,
	"raw_input" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"parsed_by" text,
	"confidence" real,
	"parsed_intent" jsonb,
	"policy_result" text,
	"transformed_intent" jsonb,
	"action_plan" jsonb,
	"server_result" jsonb NOT NULL,
	"llm_status" text DEFAULT 'PENDING' NOT NULL,
	"llm_output" text,
	"llm_error" jsonb,
	"llm_attempts" integer DEFAULT 0 NOT NULL,
	"llm_locked_at" timestamp,
	"llm_lock_owner" text,
	"llm_model_used" text,
	"llm_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_turn_logs" ADD CONSTRAINT "ai_turn_logs_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battle_states" ADD CONSTRAINT "battle_states_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_states" ADD CONSTRAINT "hub_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_instances" ADD CONSTRAINT "node_instances_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_memories" ADD CONSTRAINT "node_memories_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_summaries" ADD CONSTRAINT "recent_summaries_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memories" ADD CONSTRAINT "run_memories_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sessions" ADD CONSTRAINT "run_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_run_id_run_sessions_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "battle_states_run_node_idx" ON "battle_states" USING btree ("run_id","node_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_instances_run_index_idx" ON "node_instances" USING btree ("run_id","node_index");--> statement-breakpoint
CREATE INDEX "recent_summaries_run_turn_idx" ON "recent_summaries" USING btree ("run_id","turn_no");--> statement-breakpoint
CREATE INDEX "run_sessions_user_status_idx" ON "run_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_run_turn_no_idx" ON "turns" USING btree ("run_id","turn_no");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_run_idempotency_idx" ON "turns" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "turns_llm_status_idx" ON "turns" USING btree ("llm_status");--> statement-breakpoint
CREATE INDEX "turns_run_created_at_idx" ON "turns" USING btree ("run_id","created_at");