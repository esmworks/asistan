-- OpenAPI documents bots may call operations of, through a saved API key.
CREATE TABLE "api_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"spec_url" text,
	"base_url" text NOT NULL,
	"credential" text,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bot_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_sources_name_uq" ON "api_sources" USING btree ("name");