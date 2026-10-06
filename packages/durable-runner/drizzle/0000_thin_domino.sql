CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"token_budget" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tasks_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_seq" integer NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"risk" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approvals_call_unique" UNIQUE("task_id","step_seq","tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "task_steps" (
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_steps_task_id_seq_pk" PRIMARY KEY("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"task_id" uuid NOT NULL,
	"step_seq" integer NOT NULL,
	"args_hash" text NOT NULL,
	"tool_name" text NOT NULL,
	"risk" text NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_executions_task_id_step_seq_args_hash_pk" PRIMARY KEY("task_id","step_seq","args_hash")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_state_idx" ON "agent_tasks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "agent_tasks_created_idx" ON "agent_tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");