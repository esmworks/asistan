-- The app was renamed, and with it its own MCP server, so its tools are now `mcp__leafbot__*`
-- instead of `mcp__yumakbot__*`. Everything that keeps a tool's name is rewritten, so ask rules keep
-- asking, allow rules keep allowing, a bot keeps the tools it was limited to, routines and taught
-- skills keep their steps, alarms and actions keep their labels and old tool calls in chat history
-- keep theirs.
UPDATE "permission_rules" SET "pattern" = replace("pattern", 'mcp__yumakbot', 'mcp__leafbot')
WHERE "pattern" LIKE '%mcp\_\_yumakbot%';--> statement-breakpoint
UPDATE "approvals" SET "tool_name" = replace("tool_name", 'mcp__yumakbot__', 'mcp__leafbot__')
WHERE "tool_name" LIKE 'mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "bot_actions" SET "tool_name" = replace("tool_name", 'mcp__yumakbot__', 'mcp__leafbot__')
WHERE "tool_name" LIKE 'mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "canary_alarms" SET "tool" = replace("tool", 'mcp__yumakbot__', 'mcp__leafbot__')
WHERE "tool" LIKE 'mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "bots" SET "tool_selection" = replace("tool_selection"::text, 'mcp__yumakbot', 'mcp__leafbot')::jsonb
WHERE "tool_selection"::text LIKE '%mcp\_\_yumakbot%';--> statement-breakpoint
UPDATE "routines" SET "steps" = replace("steps"::text, 'mcp__yumakbot__', 'mcp__leafbot__')::jsonb
WHERE "steps"::text LIKE '%mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "routine_runs" SET "steps_snapshot" = replace("steps_snapshot"::text, 'mcp__yumakbot__', 'mcp__leafbot__')::jsonb
WHERE "steps_snapshot"::text LIKE '%mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "skills" SET "steps" = replace("steps"::text, 'mcp__yumakbot__', 'mcp__leafbot__')::jsonb
WHERE "steps"::text LIKE '%mcp\_\_yumakbot\_\_%';--> statement-breakpoint
UPDATE "messages" SET "props" = replace("props"::text, 'mcp__yumakbot__', 'mcp__leafbot__')::jsonb
WHERE "props"::text LIKE '%mcp\_\_yumakbot\_\_%';
