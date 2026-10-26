CREATE TYPE "public"."assignment_status" AS ENUM('ACTIVE', 'COMPLETED', 'RELEASED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."incident_category" AS ENUM('FOOD_SAFETY', 'QUANTITY_MISMATCH', 'PICKUP_PROBLEM', 'DELIVERY_PROBLEM', 'RUNNER_UNAVAILABLE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."transport_mode" AS ENUM('NGO_PICKUP', 'RUNNER');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('FOOT', 'BICYCLE', 'SCOOTER', 'CAR', 'VAN');--> statement-breakpoint
ALTER TYPE "public"."rescue_status" ADD VALUE 'AWAITING_RUNNER';--> statement-breakpoint
ALTER TYPE "public"."rescue_status" ADD VALUE 'IN_TRANSIT';--> statement-breakpoint
ALTER TYPE "public"."rescue_status" ADD VALUE 'DELIVERED';--> statement-breakpoint
CREATE TABLE "incident_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rescue_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reporter_role" text NOT NULL,
	"category" "incident_category" NOT NULL,
	"severity" "incident_severity" NOT NULL,
	"blocking" boolean NOT NULL,
	"description" text NOT NULL,
	"status" "incident_status" DEFAULT 'OPEN' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_code" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_resolved_fields" CHECK ("incident_reports"."status" = 'OPEN' OR ("incident_reports"."resolved_by" IS NOT NULL AND "incident_reports"."resolved_at" IS NOT NULL AND "incident_reports"."resolution_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rescue_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rescue_id" uuid NOT NULL,
	"runner_user_id" uuid NOT NULL,
	"status" "assignment_status" DEFAULT 'ACTIVE' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_locations" (
	"rescue_id" uuid PRIMARY KEY NOT NULL,
	"runner_user_id" uuid NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rescue_locations_lat" CHECK ("rescue_locations"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "rescue_locations_lng" CHECK ("rescue_locations"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "rescues" ADD COLUMN "transport_mode" "transport_mode" DEFAULT 'NGO_PICKUP' NOT NULL;--> statement-breakpoint
ALTER TABLE "rescues" ADD COLUMN "runner_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rescues" ADD COLUMN "transit_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rescues" ADD COLUMN "handed_over_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD COLUMN "vehicle_type" "vehicle_type";--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD COLUMN "capacity_kg" double precision;--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD COLUMN "radius_km" double precision;--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_incident_id_incident_reports_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_evidence" ADD CONSTRAINT "incident_evidence_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_rescue_id_rescues_id_fk" FOREIGN KEY ("rescue_id") REFERENCES "public"."rescues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescue_assignments" ADD CONSTRAINT "rescue_assignments_rescue_id_rescues_id_fk" FOREIGN KEY ("rescue_id") REFERENCES "public"."rescues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescue_assignments" ADD CONSTRAINT "rescue_assignments_runner_user_id_users_id_fk" FOREIGN KEY ("runner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescue_locations" ADD CONSTRAINT "rescue_locations_rescue_id_rescues_id_fk" FOREIGN KEY ("rescue_id") REFERENCES "public"."rescues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rescue_locations" ADD CONSTRAINT "rescue_locations_runner_user_id_users_id_fk" FOREIGN KEY ("runner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_evidence_key" ON "incident_evidence" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "incident_evidence_incident_idx" ON "incident_evidence" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "incident_reports_rescue_idx" ON "incident_reports" USING btree ("rescue_id","status");--> statement-breakpoint
CREATE INDEX "incident_reports_open_idx" ON "incident_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rescue_assignments_rescue_idx" ON "rescue_assignments" USING btree ("rescue_id");--> statement-breakpoint
CREATE INDEX "rescue_assignments_runner_idx" ON "rescue_assignments" USING btree ("runner_user_id","status");--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_capacity_positive" CHECK ("volunteer_profiles"."capacity_kg" IS NULL OR ("volunteer_profiles"."capacity_kg" > 0 AND "volunteer_profiles"."capacity_kg" <= 1000));--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_radius_range" CHECK ("volunteer_profiles"."radius_km" IS NULL OR ("volunteer_profiles"."radius_km" > 0 AND "volunteer_profiles"."radius_km" <= 100));--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_latitude_range" CHECK ("volunteer_profiles"."latitude" IS NULL OR "volunteer_profiles"."latitude" BETWEEN -90 AND 90);--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_longitude_range" CHECK ("volunteer_profiles"."longitude" IS NULL OR "volunteer_profiles"."longitude" BETWEEN -180 AND 180);--> statement-breakpoint
ALTER TABLE "volunteer_profiles" ADD CONSTRAINT "volunteer_coordinates_pair" CHECK (("volunteer_profiles"."latitude" IS NULL) = ("volunteer_profiles"."longitude" IS NULL));