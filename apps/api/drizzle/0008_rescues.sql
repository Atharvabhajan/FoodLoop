CREATE TYPE "public"."rescue_status" AS ENUM('RESERVED', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED', 'RECIPIENT_CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED');--> statement-breakpoint
ALTER TYPE "public"."listing_status" ADD VALUE 'RESERVED';--> statement-breakpoint
ALTER TYPE "public"."listing_status" ADD VALUE 'COLLECTED';--> statement-breakpoint
CREATE TABLE "rescue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rescue_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" "rescue_status",
	"to_status" "rescue_status",
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"ngo_org_id" uuid NOT NULL,
	"accepted_by" uuid NOT NULL,
	"status" "rescue_status" DEFAULT 'RESERVED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"servings_offered" integer NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_confirm_by" timestamp with time zone NOT NULL,
	"provider_confirmed_at" timestamp with time zone,
	"pickup_by" timestamp with time zone NOT NULL,
	"pickup_code_hash" text,
	"pickup_code_attempts" integer DEFAULT 0 NOT NULL,
	"pickup_code_issued_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"collected_servings" integer,
	"delivery_confirm_by" timestamp with time zone,
	"delivered_servings" integer,
	"recipient_confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"outcome_code" text,
	"outcome_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rescues_collected_range" CHECK ("rescues"."collected_servings" IS NULL OR ("rescues"."collected_servings" > 0 AND "rescues"."collected_servings" <= "rescues"."servings_offered")),
	CONSTRAINT "rescues_delivered_range" CHECK ("rescues"."delivered_servings" IS NULL OR ("rescues"."delivered_servings" >= 0 AND "rescues"."collected_servings" IS NOT NULL AND "rescues"."delivered_servings" <= "rescues"."collected_servings")),
	CONSTRAINT "rescues_parties_differ" CHECK ("rescues"."provider_org_id" <> "rescues"."ngo_org_id")
);
--> statement-breakpoint
ALTER TABLE "rescue_events" ADD CONSTRAINT "rescue_events_rescue_id_rescues_id_fk" FOREIGN KEY ("rescue_id") REFERENCES "public"."rescues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescue_events" ADD CONSTRAINT "rescue_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescues" ADD CONSTRAINT "rescues_listing_id_food_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."food_listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescues" ADD CONSTRAINT "rescues_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescues" ADD CONSTRAINT "rescues_ngo_org_id_organizations_id_fk" FOREIGN KEY ("ngo_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescues" ADD CONSTRAINT "rescues_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rescue_events_rescue_idx" ON "rescue_events" USING btree ("rescue_id","created_at");--> statement-breakpoint
CREATE INDEX "rescues_listing_idx" ON "rescues" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "rescues_ngo_idx" ON "rescues" USING btree ("ngo_org_id","status");--> statement-breakpoint
CREATE INDEX "rescues_provider_idx" ON "rescues" USING btree ("provider_org_id","status");--> statement-breakpoint
CREATE INDEX "rescues_due_idx" ON "rescues" USING btree ("status","provider_confirm_by","pickup_by","delivery_confirm_by");