-- Phase 4: spatial columns. Forward-only and additive: no existing column, row or index is changed.
-- Requires PostGIS to be installed on the server (see docs/postgis-setup.md); fails loudly if it is not,
-- so a partially working geospatial setup is never created.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN geog geography(Point, 4326);
--> statement-breakpoint
ALTER TABLE food_listings ADD COLUMN geog geography(Point, 4326);
--> statement-breakpoint
-- Backfill from the existing plain coordinates, only when BOTH are present and valid.
-- ST_MakePoint takes (x, y) = (longitude, latitude).
UPDATE organizations
   SET geog = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
 WHERE latitude IS NOT NULL AND longitude IS NOT NULL
   AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180;
--> statement-breakpoint
UPDATE food_listings
   SET geog = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
 WHERE latitude IS NOT NULL AND longitude IS NOT NULL
   AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180;
--> statement-breakpoint
CREATE INDEX organizations_geog_gist ON organizations USING GIST (geog);
--> statement-breakpoint
CREATE INDEX food_listings_geog_gist ON food_listings USING GIST (geog);
--> statement-breakpoint
-- Keep `geog` in step with latitude/longitude so no application code path can leave them inconsistent.
CREATE OR REPLACE FUNCTION set_geog_from_lat_lng() RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL
     AND NEW.latitude BETWEEN -90 AND 90 AND NEW.longitude BETWEEN -180 AND 180 THEN
    NEW.geog := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  ELSE
    NEW.geog := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER organizations_set_geog
  BEFORE INSERT OR UPDATE OF latitude, longitude ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_geog_from_lat_lng();
--> statement-breakpoint
CREATE TRIGGER food_listings_set_geog
  BEFORE INSERT OR UPDATE OF latitude, longitude ON food_listings
  FOR EACH ROW EXECUTE FUNCTION set_geog_from_lat_lng();
