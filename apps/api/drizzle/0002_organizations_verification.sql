CREATE TYPE "public"."document_review_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('REGISTRATION_CERTIFICATE', 'FOOD_SAFETY_LICENSE', 'ID_PROOF', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."verification_action" AS ENUM('SUBMITTED', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUESTED');--> statement-breakpoint
CREATE TABLE "verification_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"review_status" "document_review_status" DEFAULT 'PENDING' NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_documents_size_positive" CHECK ("verification_documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "verification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"action" "verification_action" NOT NULL,
	"from_status" "verification_status" NOT NULL,
	"to_status" "verification_status" NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"reason" text,
	"submission_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "submission_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_documents_storage_key_key" ON "verification_documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "verification_documents_org_idx" ON "verification_documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "verification_events_org_idx" ON "verification_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organizations_status_idx" ON "organizations" USING btree ("verification_status");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_latitude_range" CHECK ("organizations"."latitude" IS NULL OR "organizations"."latitude" BETWEEN -90 AND 90);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_longitude_range" CHECK ("organizations"."longitude" IS NULL OR "organizations"."longitude" BETWEEN -180 AND 180);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_coordinates_pair" CHECK (("organizations"."latitude" IS NULL) = ("organizations"."longitude" IS NULL));