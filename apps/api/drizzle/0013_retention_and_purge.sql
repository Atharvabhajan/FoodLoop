CREATE TABLE "retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Phase 7 retention. Incident reports and evidence stay undeletable by the application (the runtime role has no DELETE
-- privilege on them). The only exception is the operator's retention command, which must opt in per transaction
-- (foodloop.retention_purge = 'on') and can only remove RESOLVED material. Forgeable by anyone holding the privileged
-- credential, which is the point: that credential is the operator's, and the runtime role cannot delete at all.
CREATE OR REPLACE FUNCTION incident_reports_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'RESOLVED' AND current_setting('foodloop.retention_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'incident_reports cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved incident report cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.rescue_id IS DISTINCT FROM OLD.rescue_id
     OR NEW.reporter_user_id IS DISTINCT FROM OLD.reporter_user_id
     OR NEW.reporter_role IS DISTINCT FROM OLD.reporter_role
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.blocking IS DISTINCT FROM OLD.blocking
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the content of an incident report is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION incident_evidence_reject_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('foodloop.retention_purge', true) = 'on'
     AND EXISTS (SELECT 1 FROM incident_reports i WHERE i.id = OLD.incident_id AND i.status = 'RESOLVED') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'incident_evidence is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
