CREATE TYPE "public"."escalation_recipient_kind" AS ENUM('NGO', 'RUNNER');--> statement-breakpoint
CREATE TYPE "public"."escalation_step_kind" AS ENUM('NGO_WAVE', 'RUNNER_WAVE', 'ADMIN_ALERT');--> statement-breakpoint
CREATE TYPE "public"."escalation_step_status" AS ENUM('PENDING', 'DONE', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "escalation_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"kind" "escalation_recipient_kind" NOT NULL,
	"ngo_org_id" uuid,
	"runner_user_id" uuid,
	"position" integer NOT NULL,
	"distance_m" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalation_recipients_one_target" CHECK (("escalation_recipients"."kind" = 'NGO' AND "escalation_recipients"."ngo_org_id" IS NOT NULL AND "escalation_recipients"."runner_user_id" IS NULL) OR ("escalation_recipients"."kind" = 'RUNNER' AND "escalation_recipients"."runner_user_id" IS NOT NULL AND "escalation_recipients"."ngo_org_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "escalation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"seq" integer NOT NULL,
	"kind" "escalation_step_kind" NOT NULL,
	"radius_km" double precision,
	"due_at" timestamp with time zone NOT NULL,
	"status" "escalation_step_status" DEFAULT 'PENDING' NOT NULL,
	"executed_at" timestamp with time zone,
	"qualified" integer,
	"newly_eligible" integer,
	"notified_orgs" integer,
	"notified_users" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escalation_steps_seq_positive" CHECK ("escalation_steps"."seq" > 0 AND "escalation_steps"."round" > 0)
);
--> statement-breakpoint
ALTER TABLE "escalation_recipients" ADD CONSTRAINT "escalation_recipients_listing_id_food_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."food_listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_recipients" ADD CONSTRAINT "escalation_recipients_step_id_escalation_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."escalation_steps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_recipients" ADD CONSTRAINT "escalation_recipients_ngo_org_id_organizations_id_fk" FOREIGN KEY ("ngo_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_recipients" ADD CONSTRAINT "escalation_recipients_runner_user_id_users_id_fk" FOREIGN KEY ("runner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_steps" ADD CONSTRAINT "escalation_steps_listing_id_food_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."food_listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_recipients_ngo_once" ON "escalation_recipients" USING btree ("listing_id","ngo_org_id") WHERE "escalation_recipients"."kind" = 'NGO';--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_recipients_runner_once" ON "escalation_recipients" USING btree ("listing_id","runner_user_id") WHERE "escalation_recipients"."kind" = 'RUNNER';--> statement-breakpoint
CREATE INDEX "escalation_recipients_step_idx" ON "escalation_recipients" USING btree ("step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escalation_steps_listing_round_seq" ON "escalation_steps" USING btree ("listing_id","round","seq");--> statement-breakpoint
CREATE INDEX "escalation_steps_due_idx" ON "escalation_steps" USING btree ("status","due_at");--> statement-breakpoint
-- A step runs at most once: only a PENDING step may change, only to a finished state, and its identity never changes.
CREATE OR REPLACE FUNCTION escalation_steps_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'escalation_steps cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'an escalation step that has finished cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.listing_id IS DISTINCT FROM OLD.listing_id OR NEW.round IS DISTINCT FROM OLD.round OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.radius_km IS DISTINCT FROM OLD.radius_km OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'the identity and schedule of an escalation step are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER escalation_steps_guard
  BEFORE UPDATE OR DELETE ON escalation_steps
  FOR EACH ROW EXECUTE FUNCTION escalation_steps_guard();
--> statement-breakpoint
-- Who was told is history: insert-only.
CREATE OR REPLACE FUNCTION escalation_recipients_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'escalation_recipients is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER escalation_recipients_append_only
  BEFORE UPDATE OR DELETE ON escalation_recipients
  FOR EACH ROW EXECUTE FUNCTION escalation_recipients_reject_mutation();
--> statement-breakpoint
-- The moment a listing stops being AVAILABLE (accepted, cancelled, expired, collected), its pending steps are cancelled in the
-- SAME transaction. This covers every code path that changes the status, so no wave can be left scheduled for a listing that
-- is no longer open. (The executor also re-checks the listing before each step.)
CREATE OR REPLACE FUNCTION food_listings_cancel_escalation() RETURNS trigger AS $$
BEGIN
  UPDATE escalation_steps
     SET status = 'CANCELLED',
         reason = CASE NEW.status WHEN 'RESERVED' THEN 'LISTING_ACCEPTED' WHEN 'CANCELLED' THEN 'LISTING_CANCELLED' WHEN 'EXPIRED' THEN 'LISTING_EXPIRED' ELSE 'LISTING_CLOSED' END
   WHERE listing_id = NEW.id AND status = 'PENDING';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER food_listings_cancel_escalation
  AFTER UPDATE OF status ON food_listings
  FOR EACH ROW WHEN (OLD.status = 'AVAILABLE' AND NEW.status <> 'AVAILABLE')
  EXECUTE FUNCTION food_listings_cancel_escalation();
