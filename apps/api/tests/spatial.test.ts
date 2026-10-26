import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_POINT, createListing, pointAt, resetData, setup, verifiedAgent } from './helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const rows = async (q: ReturnType<typeof sql>) => (await ctx.db.execute(q)).rows as Record<string, unknown>[];

describe('PostGIS in the test database', () => {
  it('is enabled and reports its full version', async () => {
    const v = ((await rows(sql`SELECT PostGIS_Full_Version() AS v`))[0] as { v: string }).v;
    expect(v).toMatch(/POSTGIS="3\./);
    const ext = await rows(sql`SELECT extversion FROM pg_extension WHERE extname = 'postgis'`);
    expect(ext).toHaveLength(1);
  });

  it('this is the isolated test database, not the development database', async () => {
    const db = ((await rows(sql`SELECT current_database() AS db`))[0] as { db: string }).db;
    expect(db).toMatch(/test/i);
    expect(db).not.toBe('foodloop');
  });

  it('adds geography(Point, 4326) columns to organizations, listings and runner profiles', async () => {
    const cols = (await rows(
      sql`SELECT f_table_name AS t, type, srid FROM geography_columns WHERE f_geography_column = 'geog' ORDER BY f_table_name`,
    )) as { t: string; type: string; srid: number }[];
    expect(cols).toEqual([
      { t: 'food_listings', type: 'Point', srid: 4326 },
      { t: 'organizations', type: 'Point', srid: 4326 },
      { t: 'volunteer_profiles', type: 'Point', srid: 4326 },
    ]);
  });

  it('creates GiST indexes for spatial search', async () => {
    const idx = (await rows(sql`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('organizations_geog_gist', 'food_listings_geog_gist')`)) as { indexname: string; indexdef: string }[];
    expect(idx).toHaveLength(2);
    for (const i of idx) expect(i.indexdef).toMatch(/USING gist/i);
  });

  it('preserves the existing non-spatial columns', async () => {
    const cols = (await rows(sql`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'organizations'`)).map((r) => r.c);
    expect(cols).toEqual(expect.arrayContaining(['latitude', 'longitude', 'name', 'verification_status', 'geog']));
  });
});

describe('longitude/latitude order and known distances', () => {
  it('stores longitude as X and latitude as Y', async () => {
    await ctx.db.execute(sql`INSERT INTO organizations (type, name, latitude, longitude) VALUES ('NGO', 'Order Test', 18.5204, 73.8567)`);
    const [r] = (await rows(sql`SELECT ST_X(geog::geometry) AS x, ST_Y(geog::geometry) AS y FROM organizations WHERE name = 'Order Test'`)) as { x: number; y: number }[];
    expect(r!.x).toBeCloseTo(73.8567, 6);
    expect(r!.y).toBeCloseTo(18.5204, 6);
  });

  it('computes geodesic distances that match known values', async () => {
    const d = async (lat1: number, lng1: number, lat2: number, lng2: number) =>
      ((await rows(sql`SELECT ST_Distance(ST_SetSRID(ST_MakePoint(${lng1}, ${lat1}), 4326)::geography, ST_SetSRID(ST_MakePoint(${lng2}, ${lat2}), 4326)::geography) / 1000 AS km`))[0] as { km: number }).km;
    // Pune to Mumbai is about 120 km.
    expect(await d(18.5204, 73.8567, 19.076, 72.8777)).toBeGreaterThan(119);
    expect(await d(18.5204, 73.8567, 19.076, 72.8777)).toBeLessThan(121.5);
    // PostGIS measures on the WGS84 ellipsoid: one degree of latitude at the equator is 110.57 km.
    expect(await d(0, 0, 1, 0)).toBeCloseTo(110.57, 1);
    // One degree of longitude is 111.32 km at the equator and shrinks with latitude (55.8 km at 60 N).
    expect(await d(0, 0, 0, 1)).toBeCloseTo(111.32, 1);
    expect(await d(60, 0, 60, 1)).toBeCloseTo(55.8, 1);
    // Swapping latitude and longitude gives a very different place, which is what a wrong order would do.
    expect(await d(18.5204, 73.8567, 73.8567, 18.5204)).toBeGreaterThan(1000);
  });

  it('measures exactly the distance it was projected by', async () => {
    const p = await pointAt(ctx, PROVIDER_POINT, 5000, 45);
    const m = ((await rows(sql`SELECT ST_Distance(ST_SetSRID(ST_MakePoint(${PROVIDER_POINT.longitude}, ${PROVIDER_POINT.latitude}), 4326)::geography, ST_SetSRID(ST_MakePoint(${p.longitude}, ${p.latitude}), 4326)::geography) AS m`))[0] as { m: number }).m;
    expect(m).toBeCloseTo(5000, 2);
  });
});

describe('radius boundary (ST_DWithin)', () => {
  const within = async (meters: number, radius: number) => {
    const p = await pointAt(ctx, PROVIDER_POINT, meters, 90);
    const [r] = (await rows(sql`SELECT ST_DWithin(
        ST_SetSRID(ST_MakePoint(${PROVIDER_POINT.longitude}, ${PROVIDER_POINT.latitude}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${p.longitude}, ${p.latitude}), 4326)::geography, ${radius}::float8) AS w`)) as { w: boolean }[];
    return r!.w;
  };

  it('includes points just inside the radius and excludes points just outside', async () => {
    expect(await within(4990, 5000)).toBe(true);
    expect(await within(5010, 5000)).toBe(false);
    expect(await within(0, 5000)).toBe(true);
  });

  it('is inclusive at exactly the measured distance', async () => {
    const p = await pointAt(ctx, PROVIDER_POINT, 3210.5, 200);
    const [r] = (await rows(sql`WITH d AS (
        SELECT ST_SetSRID(ST_MakePoint(${PROVIDER_POINT.longitude}, ${PROVIDER_POINT.latitude}), 4326)::geography AS a,
               ST_SetSRID(ST_MakePoint(${p.longitude}, ${p.latitude}), 4326)::geography AS b)
      SELECT ST_DWithin(a, b, ST_Distance(a, b)) AS exact, ST_DWithin(a, b, ST_Distance(a, b) - 0.01) AS short FROM d`)) as { exact: boolean; short: boolean }[];
    expect(r).toEqual({ exact: true, short: false });
  });
});

describe('geography backfill (the migration SQL itself)', () => {
  it('backfills from existing coordinates and leaves rows without coordinates empty', async () => {
    await ctx.db.execute(sql`INSERT INTO organizations (type, name, latitude, longitude) VALUES
      ('NGO', 'Has Coords', 18.5, 73.8), ('NGO', 'No Coords', NULL, NULL)`);
    const provider = await verifiedAgent(ctx, 'provider');
    await createListing(provider.agent); // has coordinates
    await createListing(provider.agent, { title: 'Listing without coordinates', latitude: null, longitude: null });

    // Simulate pre-Phase-4 rows: geog was never populated.
    await ctx.db.execute(sql`UPDATE organizations SET geog = NULL`);
    await ctx.db.execute(sql`UPDATE food_listings SET geog = NULL`);

    // Run the real UPDATE statements from the migration file.
    const file = readFileSync(new URL('../drizzle/0007_postgis_geography.sql', import.meta.url), 'utf8');
    const backfills = file.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => /^(--[^\n]*\n)*\s*UPDATE /m.test(s) && s.includes('ST_MakePoint'));
    expect(backfills).toHaveLength(2);
    for (const stmt of backfills) await ctx.db.execute(sql.raw(stmt.replace(/^(--[^\n]*\n)+/gm, '')));

    const org = (await rows(sql`SELECT name, geog IS NOT NULL AS has FROM organizations WHERE name IN ('Has Coords', 'No Coords') ORDER BY name`)) as { name: string; has: boolean }[];
    expect(org).toEqual([{ name: 'Has Coords', has: true }, { name: 'No Coords', has: false }]);
    const l = (await rows(sql`SELECT title, geog IS NOT NULL AS has, ST_X(geog::geometry) AS x, ST_Y(geog::geometry) AS y FROM food_listings ORDER BY title`)) as { title: string; has: boolean; x: number | null; y: number | null }[];
    expect(l.find((r) => r.title === 'Vegetable Biryani')).toMatchObject({ has: true });
    expect(l.find((r) => r.title === 'Vegetable Biryani')!.x).toBeCloseTo(PROVIDER_POINT.longitude, 6);
    expect(l.find((r) => r.title === 'Vegetable Biryani')!.y).toBeCloseTo(PROVIDER_POINT.latitude, 6);
    expect(l.find((r) => r.title === 'Listing without coordinates')).toMatchObject({ has: false });
  });

  it('is forward-only: the migration contains no destructive statements', () => {
    const file = readFileSync(new URL('../drizzle/0007_postgis_geography.sql', import.meta.url), 'utf8');
    const code = file.replace(/^--.*$/gm, '');
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    expect(code).toMatch(/CREATE EXTENSION IF NOT EXISTS postgis/i);
  });
});

describe('geog stays in sync with latitude/longitude', () => {
  it('updates when coordinates change and clears when they are removed', async () => {
    await ctx.db.execute(sql`INSERT INTO organizations (type, name, latitude, longitude) VALUES ('NGO', 'Sync Test', 10, 20)`);
    const read = async () => ((await rows(sql`SELECT ST_X(geog::geometry) AS x, ST_Y(geog::geometry) AS y FROM organizations WHERE name = 'Sync Test'`))[0] as { x: number | null; y: number | null });
    expect(await read()).toEqual({ x: 20, y: 10 });
    await ctx.db.execute(sql`UPDATE organizations SET latitude = 11, longitude = 21 WHERE name = 'Sync Test'`);
    expect(await read()).toEqual({ x: 21, y: 11 });
    await ctx.db.execute(sql`UPDATE organizations SET latitude = NULL, longitude = NULL WHERE name = 'Sync Test'`);
    expect(await read()).toEqual({ x: null, y: null });
  });

  it('never stores invalid coordinates (CHECK constraints) so a bad point cannot be created', async () => {
    await expect(ctx.db.execute(sql`INSERT INTO organizations (type, name, latitude, longitude) VALUES ('NGO', 'Bad Lat', 95, 10)`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`INSERT INTO organizations (type, name, latitude, longitude) VALUES ('NGO', 'Half', 10, NULL)`)).rejects.toThrow();
  });
});

describe('GiST indexes serve nearby lookups', () => {
  it('uses the organizations GiST index for an ST_DWithin lookup', async () => {
    const plan = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const r = await tx.execute(sql`EXPLAIN SELECT id FROM organizations o
        WHERE ST_DWithin(o.geog, ST_SetSRID(ST_MakePoint(73.85, 18.52), 4326)::geography, 5000)`);
      return (r.rows as { 'QUERY PLAN': string }[]).map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('organizations_geog_gist');
  });

  it('uses the listings GiST index for an ST_DWithin lookup', async () => {
    const plan = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const r = await tx.execute(sql`EXPLAIN SELECT id FROM food_listings l
        WHERE ST_DWithin(l.geog, ST_SetSRID(ST_MakePoint(73.85, 18.52), 4326)::geography, 5000)`);
      return (r.rows as { 'QUERY PLAN': string }[]).map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('food_listings_geog_gist');
  });
});
