ALTER TABLE "vault_logins" ADD COLUMN "totp" text;--> statement-breakpoint
ALTER TABLE "vault_logins" ADD COLUMN "bot_ids" jsonb;