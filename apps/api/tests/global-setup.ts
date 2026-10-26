import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { applyRuntimeGrants, ensureRuntimeRole } from '../src/db/roles.js';
import { TEST_RUNTIME_ROLE, testDatabaseUrl } from './helpers.js';

/**
 * Migrates the test database with the privileged connection, then (re)creates a least-privilege runtime role for it
 * with a random per-run password. The application under test connects as that role, so the whole suite also proves
 * the API works without ownership, DDL or audit-table mutation rights. The password lives only in this process's
 * environment (inherited by the test workers) and is never printed.
 */
export default async function globalSetup() {
  const url = testDatabaseUrl();
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to run tests against "${name}": the test database name must contain "test".`);
  }
  await runMigrations(url);

  const password = randomBytes(24).toString('base64url');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureRuntimeRole(client, { role: TEST_RUNTIME_ROLE, password, connectionLimit: 60 });
    await applyRuntimeGrants(client, TEST_RUNTIME_ROLE);
  } finally {
    await client.end();
  }
  const runtime = new URL(url);
  runtime.username = TEST_RUNTIME_ROLE;
  runtime.password = password;
  process.env.TEST_RUNTIME_DATABASE_URL = runtime.toString();
  process.env.TEST_RUNTIME_PASSWORD = password;
}
