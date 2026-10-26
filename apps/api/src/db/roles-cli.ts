import pg from 'pg';
import { describeTarget, resolveAdminUrl } from './admin-url.js';
import { inspectRuntimeConnection } from './privileges.js';
import { applyRuntimeGrants, describeGrants, ensureRuntimeRole } from './roles.js';

/**
 * Privileged, idempotent setup of the runtime role for the database in MIGRATION_DATABASE_URL.
 *   RUNTIME_DB_ROLE      role name (default foodloop_runtime)
 *   RUNTIME_DB_PASSWORD  required to create the role; supply it again to rotate the password
 * Never prints the password or a connection string. Safe to re-run after every migration.
 */
async function main() {
  const adminUrl = resolveAdminUrl();
  const role = process.env.RUNTIME_DB_ROLE ?? 'foodloop_runtime';
  const password = process.env.RUNTIME_DB_PASSWORD || undefined;
  if (password && password.length < 16) throw new Error('RUNTIME_DB_PASSWORD must be at least 16 characters.');

  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    console.log(`Privileged connection: ${describeTarget(adminUrl)}`);
    const { created } = await ensureRuntimeRole(client, { role, password });
    console.log(created ? `Created role "${role}".` : `Role "${role}" exists; attributes reset to least privilege${password ? ', password rotated' : ''}.`);
    const { tables } = await applyRuntimeGrants(client, role);
    console.log(`Applied grants on ${tables} table(s):`);
    for (const g of describeGrants()) console.log(`  ${g.table.padEnd(24)} ${g.privileges}`);

    if (password) {
      const target = new URL(adminUrl);
      target.username = role;
      target.password = password;
      const probe = new pg.Pool({ connectionString: target.toString(), max: 1, connectionTimeoutMillis: 5000 });
      try {
        const report = await inspectRuntimeConnection(probe);
        if (report.violations.length > 0) throw new Error(`Runtime role verification FAILED: ${report.violations.map((v) => v.code).join(', ')}`);
        console.log(`Verified: connecting as "${role}" works and it holds no excessive privileges.`);
      } finally {
        await probe.end();
      }
    } else {
      console.log('Not verified by connecting (no RUNTIME_DB_PASSWORD given); the API verifies its own connection at startup.');
    }
    console.log(`\nNext: set DATABASE_URL to the "${role}" login for this database (keep the privileged URL only in MIGRATION_DATABASE_URL).`);
  } finally {
    await client.end();
  }
}

main().catch((err: Error) => {
  console.error(`Role setup failed: ${err.message}`);
  process.exit(1);
});
