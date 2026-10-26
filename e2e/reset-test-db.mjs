// Resets ONLY the application tables of the TEST database and reseeds the demo data into it.
//
//   node --env-file=.env e2e/reset-test-db.mjs
//
// Safety: refuses unless TEST_DATABASE_URL names a database containing "test"; never touches DATABASE_URL or
// MIGRATION_DATABASE_URL's database (the seed is pointed at the test database explicitly, because .env normally points
// those at development). The PostGIS reference table (spatial_ref_sys) is left alone. Prints no credentials.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
if (!/test/i.test(name)) throw new Error(`Refusing: "${name}" is not a test database (its name must contain "test").`);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('TRUNCATE retention_runs, users, organizations, food_listings, notifications, sessions RESTART IDENTITY CASCADE');
  const srs = (await client.query('SELECT count(*)::int AS n FROM spatial_ref_sys')).rows[0].n;
  if (srs === 0) throw new Error('spatial_ref_sys is empty in the test database; PostGIS distance queries would fail. See docs/postgis-setup.md.');
  console.log(`Test database "${name}" reset (spatial_ref_sys intact: ${srs} rows).`);
} finally {
  await client.end();
}

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = spawnSync('npm', ['run', 'db:seed'], {
  cwd: root,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  // Seeding is privileged and reads MIGRATION_DATABASE_URL: pin both URLs to the test database.
  env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url },
});
if (seed.status !== 0) {
  console.error('Seeding the test database failed:');
  console.error(String(seed.stderr).replace(/postgres(ql)?:\/\/\S+/g, 'postgres://[hidden]').split('\n').slice(-8).join('\n'));
  process.exit(1);
}
console.log('Demo data seeded into the test database.');
