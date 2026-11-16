-- A small model may look at a routine run before the bot starts on it; what it said and cost stays with the run.
-- A watched page keeps its text, so the next change can be shown as what changed instead of the whole page.
ALTER TABLE "routine_runs" ADD COLUMN "gate_decision" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_reason" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "gate_cost_usd" real;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "watch_text" text;