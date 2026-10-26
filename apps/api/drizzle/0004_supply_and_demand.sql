CREATE TYPE "public"."food_category" AS ENUM('COOKED_MEALS', 'BAKERY', 'PRODUCE', 'PACKAGED_FOOD', 'DAIRY', 'BEVERAGES', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."listing_event_action" AS ENUM('PUBLISHED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('DRAFT', 'AVAILABLE', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."packaging_type" AS ENUM('INDIVIDUAL_BOXES', 'BULK_CONTAINERS', 'WRAPPED', 'LOOSE', 'OTHER');--> statement-breakpoint
CREATE TABLE "food_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"food_category" "food_category" NOT NULL,
	"servings" integer NOT NULL,
	"estimated_kg" double precision,
	"prepared_at" timestamp with time zone NOT NULL,
	"pickup_start" timestamp with time zone NOT NULL,
	"pickup_deadline" timestamp with time zone NOT NULL,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"packaging" "packaging_type" NOT NULL,
	"dietary_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergen_notes" text,
	"transport_required" boolean NOT NULL,
	"image_key" text,
	"image_mime" text,
	"status" "listing_status" DEFAULT 'DRAFT' NOT NULL,
	"declaration_accepted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"expired_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_listings_servings_positive" CHECK ("food_listings"."servings" > 0),
	CONSTRAINT "food_listings_kg_positive" CHECK ("food_listings"."estimated_kg" IS NULL OR "food_listings"."estimated_kg" > 0),
	CONSTRAINT "food_listings_window_valid" CHECK ("food_listings"."pickup_start" < "food_listings"."pickup_deadline"),
	CONSTRAINT "food_listings_prepared_before_deadline" CHECK ("food_listings"."prepared_at" <= "food_listings"."pickup_deadline"),
	CONSTRAINT "food_listings_latitude_range" CHECK ("food_listings"."latitude" IS NULL OR "food_listings"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "food_listings_longitude_range" CHECK ("food_listings"."longitude" IS NULL OR "food_listings"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "food_listings_coordinates_pair" CHECK (("food_listings"."latitude" IS NULL) = ("food_listings"."longitude" IS NULL)),
	CONSTRAINT "food_listings_cancel_reason" CHECK ("food_listings"."status" <> 'CANCELLED' OR "food_listings"."cancellation_reason" IS NOT NULL),
	CONSTRAINT "food_listings_published" CHECK ("food_listings"."status" = 'DRAFT' OR "food_listings"."published_at" IS NOT NULL OR "food_listings"."status" = 'CANCELLED')
);
--> statement-breakpoint
CREATE TABLE "listing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"action" "listing_event_action" NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ngo_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ngo_org_id" uuid NOT NULL,
	"food_categories" "food_category"[] NOT NULL,
	"needed_servings" integer NOT NULL,
	"capacity_servings" integer NOT NULL,
	"service_radius_km" double precision NOT NULL,
	"available_from" timestamp with time zone NOT NULL,
	"available_to" timestamp with time zone NOT NULL,
	"intake_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ngo_requirements_categories_nonempty" CHECK (cardinality("ngo_requirements"."food_categories") >= 1),
	CONSTRAINT "ngo_requirements_needed_positive" CHECK ("ngo_requirements"."needed_servings" > 0),
	CONSTRAINT "ngo_requirements_capacity_covers_need" CHECK ("ngo_requirements"."capacity_servings" >= "ngo_requirements"."needed_servings"),
	CONSTRAINT "ngo_requirements_radius_range" CHECK ("ngo_requirements"."service_radius_km" > 0 AND "ngo_requirements"."service_radius_km" <= 100),
	CONSTRAINT "ngo_requirements_window_valid" CHECK ("ngo_requirements"."available_from" < "ngo_requirements"."available_to")
);
--> statement-breakpoint
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_provider_org_id_organizations_id_fk" FOREIGN KEY ("provider_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_listing_id_food_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."food_listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_events" ADD CONSTRAINT "listing_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ngo_requirements" ADD CONSTRAINT "ngo_requirements_ngo_org_id_organizations_id_fk" FOREIGN KEY ("ngo_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ngo_requirements" ADD CONSTRAINT "ngo_requirements_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_listings_status_deadline_idx" ON "food_listings" USING btree ("status","pickup_deadline");--> statement-breakpoint
CREATE INDEX "food_listings_provider_idx" ON "food_listings" USING btree ("provider_org_id","created_at");--> statement-breakpoint
CREATE INDEX "listing_events_listing_idx" ON "listing_events" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ngo_requirements_org_key" ON "ngo_requirements" USING btree ("ngo_org_id");