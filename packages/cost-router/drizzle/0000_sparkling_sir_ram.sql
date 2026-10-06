CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text,
	"agent_id" text,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"rule" text NOT NULL,
	"complexity" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"saved_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" double precision NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"fallback_from" text,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "llm_calls_at_idx" ON "llm_calls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "llm_calls_model_idx" ON "llm_calls" USING btree ("model");