import pg from 'pg';
import { describeTarget, resolveAdminUrl } from './admin-url.js';

/**
 * Creates the target database if it does not exist and reports PostGIS availability.
 * Connects to the server's maintenance database using the same credentials as DATABASE_URL.
 */
async function main() {
  const url = resolveAdminUrl();
  console.log(`Privileged connection: ${describeTarget(url)}`);
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('Database name may only contain letters, digits and underscores.');

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database "${dbName}".`);
    } else {
      console.log(`Database "${dbName}" already exists.`);
    }
    const postgis = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'");
    console.log(
      postgis.rowCount
        ? 'PostGIS is available on this server; the migration will enable it.'
        : 'WARNING: PostGIS is NOT installed on this server. Phase 1 works without it, but install it before Phase 4 (see README).',
    );
  } finally {
    await client.end();
  }
}

main().catch((err: Error) => {
  console.error(`Database setup failed: ${err.message}`);
  process.exit(1);
});
