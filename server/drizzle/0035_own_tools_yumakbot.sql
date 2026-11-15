-- The app's own MCP server was renamed, so its tools are now `mcp__yumakbot__*` instead of
-- `mcp__asistan__*`. Saved permission rules, remembered approvals and the tool calls kept in chat
-- history still carry the old prefix; rewritten here so ask rules keep asking, allow rules keep
-- allowing and old tool calls keep their labels.
UPDATE "permission_rules" SET "pattern" = replace("pattern", 'mcp__asistan', 'mcp__yumakbot')
WHERE "pattern" LIKE '%mcp\_\_asistan%';--> statement-breakpoint
UPDATE "approvals" SET "tool_name" = replace("tool_name", 'mcp__asistan__', 'mcp__yumakbot__')
WHERE "tool_name" LIKE 'mcp\_\_asistan\_\_%';--> statement-breakpoint
UPDATE "messages" SET "props" = replace("props"::text, 'mcp__asistan__', 'mcp__yumakbot__')::jsonb
WHERE "props"::text LIKE '%mcp\_\_asistan\_\_%';
