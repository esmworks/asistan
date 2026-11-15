CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"engine_session_id" text,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"responders" text DEFAULT 'everyone' NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"rounds_left" integer DEFAULT 0 NOT NULL,
	"round_spoke" boolean DEFAULT false NOT NULL,
	"bot_turns_left" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_id_threads_id_fk" FOREIGN KEY ("id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_uq" ON "room_members" USING btree ("room_id","bot_id");