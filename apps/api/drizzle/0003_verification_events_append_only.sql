-- verification_events is an audit trail: rows may be inserted, never changed or removed.
CREATE OR REPLACE FUNCTION verification_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'verification_events is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER verification_events_append_only
  BEFORE UPDATE OR DELETE ON verification_events
  FOR EACH ROW EXECUTE FUNCTION verification_events_reject_mutation();
