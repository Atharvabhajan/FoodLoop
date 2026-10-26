-- Phase 6 integrity rules. Forward-only. Nothing here references the new rescue_status labels
-- (AWAITING_RUNNER, IN_TRANSIT, DELIVERED): Drizzle applies all pending migrations in ONE transaction and a
-- newly added enum value cannot be used until that transaction commits.

-- 1. One ACTIVE assignment per rescue, and one ACTIVE assignment per runner, enforced by the database.
CREATE UNIQUE INDEX rescue_assignments_one_active_per_rescue
  ON rescue_assignments (rescue_id)
  WHERE status = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX rescue_assignments_one_active_per_runner
  ON rescue_assignments (runner_user_id)
  WHERE status = 'ACTIVE';
--> statement-breakpoint
-- 2. "One active rescue per listing" (migration 0009) listed the Phase 5 active states explicitly. Redefine it by
--    what is NOT finished, so every present and future in-progress state (including the new runner states) is covered.
--    Only an index changes; no row is touched, and existing rows already satisfy the wider rule.
DROP INDEX IF EXISTS rescues_one_active_per_listing;
--> statement-breakpoint
CREATE UNIQUE INDEX rescues_one_active_per_listing
  ON rescues (listing_id)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'PICKUP_FAILED', 'DELIVERY_FAILED', 'RECIPIENT_CONFIRMED');
--> statement-breakpoint
-- 3. Coarse runner base position: spatial column kept in step with latitude/longitude (same trigger function as 0007).
ALTER TABLE volunteer_profiles ADD COLUMN geog geography(Point, 4326);
--> statement-breakpoint
CREATE INDEX volunteer_profiles_geog_gist ON volunteer_profiles USING GIST (geog);
--> statement-breakpoint
CREATE TRIGGER volunteer_profiles_set_geog
  BEFORE INSERT OR UPDATE OF latitude, longitude ON volunteer_profiles
  FOR EACH ROW EXECUTE FUNCTION set_geog_from_lat_lng();
--> statement-breakpoint
-- 4. Incident reports: the report itself is an immutable record. Only the resolution fields may be filled in, once;
--    a resolved report cannot be reopened or edited, and no report can be deleted.
CREATE OR REPLACE FUNCTION incident_reports_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
CREATE TRIGGER incident_reports_guard
  BEFORE UPDATE OR DELETE ON incident_reports
  FOR EACH ROW EXECUTE FUNCTION incident_reports_guard();
--> statement-breakpoint
-- 5. Evidence metadata is append-only.
CREATE OR REPLACE FUNCTION incident_evidence_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'incident_evidence is append-only (% not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER incident_evidence_append_only
  BEFORE UPDATE OR DELETE ON incident_evidence
  FOR EACH ROW EXECUTE FUNCTION incident_evidence_reject_mutation();
