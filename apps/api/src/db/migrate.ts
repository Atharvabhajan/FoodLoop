import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeTarget, resolveAdminUrl } from './admin-url.js';
import { createDb } from './client.js';
import { applyRuntimeGrants } from './roles.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/** Re-applies the runtime role's grants so tables added by a migration are decided right away. No-op if the role is not set up. */
export async function syncRuntimeGrants(url: string, role: string): Promise<'applied' | 'role-missing'> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 0) return 'role-missing';
    await applyRuntimeGrants(client, role);
    return 'applied';
  } finally {
    await client.end();
  }
}

// Executed directly via `npm run db:migrate`. Uses the privileged connection, never the runtime one.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const role = process.env.RUNTIME_DB_ROLE ?? 'foodloop_runtime';
  void (async () => {
    const url = resolveAdminUrl();
    console.log(`Privileged connection: ${describeTarget(url)}`);
    await runMigrations(url);
    const synced = await syncRuntimeGrants(url, role);
    console.log(synced === 'applied' ? `Runtime grants for "${role}" re-applied.` : `Runtime role "${role}" does not exist yet; run npm run db:roles (see docs/phase-7-security-operations.md).`);
  })()
    .then(() => console.log('Migrations applied.'))
    .catch((err: Error) => {
      console.error(`Migration failed: ${err.message}`);
      process.exit(1);
    });
}
