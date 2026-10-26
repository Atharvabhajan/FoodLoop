-- Enable PostGIS when the server has it installed.
-- Phase 1 stores no geometry, so a server without PostGIS still migrates (with a NOTICE).
-- Phase 4 (geospatial matching) requires PostGIS; install it natively before then (see README).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    CREATE EXTENSION IF NOT EXISTS postgis;
  ELSE
    RAISE NOTICE 'PostGIS is not installed on this server; skipping CREATE EXTENSION postgis.';
  END IF;
END
$$;
