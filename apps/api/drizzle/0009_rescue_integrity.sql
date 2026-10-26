-- Phase 5 integrity rules. Forward-only and additive.

-- Spec 4.2: "Unique active rescue reservation per listing to prevent double acceptance".
-- Even if two transactions slipped past the application's row lock, the database refuses a second
-- active rescue for the same listing.
CREATE UNIQUE INDEX rescues_one_active_per_listing
  ON rescues (listing_id)
  WHERE status IN ('RESERVED', 'PICKUP_ASSIGNED', 'PICKUP_CONFIRMED');
--> statement-breakpoint
-- rescue_events is an audit trail: rows may be inserted, never changed or removed.
CREATE OR REPLACE FUNCTION rescue_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rescue_events is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rescue_events_append_only
  BEFORE UPDATE OR DELETE ON rescue_events
  FOR EACH ROW EXECUTE FUNCTION rescue_events_reject_mutation();
