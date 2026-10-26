-- listing_events is an audit trail: rows may be inserted, never changed or removed.
CREATE OR REPLACE FUNCTION listing_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'listing_events is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER listing_events_append_only
  BEFORE UPDATE OR DELETE ON listing_events
  FOR EACH ROW EXECUTE FUNCTION listing_events_reject_mutation();
