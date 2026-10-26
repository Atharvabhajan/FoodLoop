import pg from 'pg';
import { resolveAdminUrl } from './admin-url.js';

/**
 * PostGIS verification gate (no application data is touched).
 *
 * 1. Reports the server version and whether a PostGIS extension is installed on the server.
 * 2. If it is, creates a throwaway database, enables PostGIS there, prints PostGIS_Full_Version(),
 *    checks a known distance, and drops the throwaway database.
 * 3. Reports whether PostGIS is already enabled in the FoodLoop dev and test databases (read-only).
 *
 * Exit code 2 means PostGIS is not installed on the server, so geospatial work must not proceed.
 */
const CHECK_DB = 'foodloop_postgis_check';

function withDb(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function connect(url: string) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  return c;
}

async function main() {
  const devUrl = resolveAdminUrl();
  const testUrl = process.env.TEST_DATABASE_URL;

  const admin = await connect(withDb(devUrl, 'postgres'));
  try {
    const version = (await admin.query('SHOW server_version')).rows[0].server_version as string;
    console.log(`PostgreSQL server_version: ${version}`);
    const available = await admin.query(
      "SELECT name, default_version FROM pg_available_extensions WHERE name LIKE 'postgis%' ORDER BY name",
    );
    if (available.rowCount === 0) {
      console.error('\nPostGIS is NOT installed on this PostgreSQL server (no postgis* entries in pg_available_extensions).');
      console.error('Install it natively first: see docs/postgis-setup.md. Nothing was changed.');
      process.exitCode = 2;
      return;
    }
    console.log(`Available: ${available.rows.map((r) => `${r.name} ${r.default_version}`).join(', ')}`);

    // 1. Isolated check database.
    await admin.query(`DROP DATABASE IF EXISTS ${CHECK_DB}`);
    await admin.query(`CREATE DATABASE ${CHECK_DB}`);
    try {
      const check = await connect(withDb(devUrl, CHECK_DB));
      try {
        await check.query('CREATE EXTENSION postgis');
        const full = (await check.query('SELECT PostGIS_Full_Version() AS v')).rows[0].v as string;
        console.log(`\nIsolated check database: PostGIS_Full_Version() OK\n  ${full.split('\n')[0]}`);
        // Longitude is X, latitude is Y. Pune (73.8567 E, 18.5204 N) to Mumbai (72.8777 E, 19.0760 N) is about 120 km.
        const km = (
          await check.query(
            `SELECT ST_Distance(
               ST_SetSRID(ST_MakePoint(73.8567, 18.5204), 4326)::geography,
               ST_SetSRID(ST_MakePoint(72.8777, 19.0760), 4326)::geography) / 1000 AS km`,
          )
        ).rows[0].km as number;
        const ok = km > 115 && km < 125;
        console.log(`  Pune to Mumbai geodesic distance: ${km.toFixed(1)} km ${ok ? '(as expected)' : '(UNEXPECTED)'}`);
        if (!ok) process.exitCode = 1;
      } finally {
        await check.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${CHECK_DB}`);
    }
  } finally {
    await admin.end();
  }

  // 2. Read-only status of the real databases.
  for (const [label, url] of [['dev', devUrl], ['test', testUrl]] as const) {
    if (!url) continue;
    const c = await connect(url);
    try {
      const ext = await c.query("SELECT extversion FROM pg_extension WHERE extname = 'postgis'");
      let detail = 'not enabled yet (the Phase 4 migration enables it)';
      if (ext.rowCount) {
        detail = `enabled, ${(await c.query('SELECT PostGIS_Full_Version() AS v')).rows[0].v.split('\n')[0]}`;
      }
      console.log(`${label} database (${new URL(url).pathname.slice(1)}): ${detail}`);
    } finally {
      await c.end();
    }
  }
}

main().catch((err: Error) => {
  console.error(`PostGIS check failed: ${err.message}`);
  process.exit(1);
});
