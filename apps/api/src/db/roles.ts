import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Least-privilege runtime role (Phase 7).
 *
 * The running API connects as this role. It owns nothing, cannot change the schema, and cannot update or delete
 * audit history. Everything privileged (migrations, seed, role setup, retention) uses a separate connection.
 * Every table must appear in RUNTIME_GRANTS: a new table added by a migration fails `applyRuntimeGrants` and the
 * grant-coverage test until someone decides what the API may do with it.
 */

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface TableGrant {
  privileges: Privilege[];
  /** When set, UPDATE is granted on these columns only. */
  updateColumns?: string[];
}

const CRUD: Privilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const NO_DELETE: Privilege[] = ['SELECT', 'INSERT', 'UPDATE'];
const APPEND_ONLY: Privilege[] = ['SELECT', 'INSERT'];

export const RUNTIME_GRANTS: Record<string, TableGrant> = {
  users: { privileges: NO_DELETE },
  sessions: { privileges: NO_DELETE },
  organizations: { privileges: NO_DELETE },
  organization_members: { privileges: NO_DELETE },
  verification_documents: { privileges: CRUD },
  ngo_requirements: { privileges: NO_DELETE },
  food_listings: { privileges: NO_DELETE },
  notifications: { privileges: NO_DELETE },
  match_candidates: { privileges: CRUD },
  rescues: { privileges: NO_DELETE },
  rescue_assignments: { privileges: NO_DELETE },
  rescue_locations: { privileges: CRUD },
  volunteer_profiles: { privileges: NO_DELETE },
  // The report is immutable; the application may only fill in the resolution, once (a trigger enforces "once").
  incident_reports: {
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    updateColumns: ['status', 'resolved_by', 'resolved_at', 'resolution_code', 'resolution_note'],
  },
  // Append-only audit history: no UPDATE, DELETE or TRUNCATE for the runtime role.
  rescue_events: { privileges: APPEND_ONLY },
  listing_events: { privileges: APPEND_ONLY },
  verification_events: { privileges: APPEND_ONLY },
  incident_evidence: { privileges: APPEND_ONLY },
  // Escalation waves: a step may only be finished once (trigger); who was told is insert-only history.
  escalation_steps: {
    privileges: ['SELECT', 'INSERT', 'UPDATE'],
    updateColumns: ['status', 'executed_at', 'qualified', 'newly_eligible', 'notified_orgs', 'notified_users', 'reason'],
  },
  escalation_recipients: { privileges: APPEND_ONLY },
  // Operator-only.
  retention_runs: { privileges: [] },
};

/** Tables whose history must never be altered through the runtime connection. */
export const AUDIT_TABLES = ['rescue_events', 'listing_events', 'verification_events', 'incident_evidence', 'escalation_recipients'] as const;

/** Extension-owned tables the role may only read (PostGIS needs spatial_ref_sys for geography operations). */
const READ_ONLY_EXTENSION_TABLES = ['spatial_ref_sys'];

/** Built-in roles that would let a connection bypass table privileges or touch the server's filesystem. */
export const DANGEROUS_MEMBERSHIPS = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_signal_backend',
] as const;

export const RUNTIME_STATEMENT_TIMEOUT = '30s';
export const RUNTIME_IDLE_TX_TIMEOUT = '60s';

export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertRoleName(name: string) {
  if (!ROLE_NAME.test(name)) throw new Error('Role names may only contain lowercase letters, digits and underscores.');
}

/**
 * Builds a SCRAM-SHA-256 verifier so the plaintext password is never sent to the server (and so never appears in
 * server statement logs). PostgreSQL accepts this form directly in CREATE/ALTER ROLE ... PASSWORD.
 */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export interface EnsureRoleOptions {
  role: string;
  /** Plaintext only to derive a verifier locally; never logged or sent. Omit to leave an existing password alone. */
  password?: string;
  connectionLimit?: number;
}

/**
 * Creates the role if needed and forces its attributes back to least privilege on every run, so an operator who
 * elevated it by mistake is corrected. Does not need the password of an existing role.
 */
export async function ensureRuntimeRole(client: pg.Client, { role, password, connectionLimit = 20 }: EnsureRoleOptions) {
  assertRoleName(role);
  const id = client.escapeIdentifier(role);
  const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
  if (!exists && !password) throw new Error(`Role "${role}" does not exist; set RUNTIME_DB_PASSWORD to create it.`);
  const attrs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT ${Math.trunc(connectionLimit)}`;
  const pw = password ? ` PASSWORD ${client.escapeLiteral(scramVerifier(password))}` : '';
  await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${id} WITH ${attrs}${pw}`);
  // A runaway query or a leaked open transaction (and the locks it holds) ends on its own.
  await client.query(`ALTER ROLE ${id} SET statement_timeout = '${RUNTIME_STATEMENT_TIMEOUT}'`);
  await client.query(`ALTER ROLE ${id} SET idle_in_transaction_session_timeout = '${RUNTIME_IDLE_TX_TIMEOUT}'`);
  // Not a member of anything (no inherited privileges).
  const memberships = await client.query(
    'SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1',
    [role],
  );
  for (const m of memberships.rows as { rolname: string }[]) await client.query(`REVOKE ${client.escapeIdentifier(m.rolname)} FROM ${id}`);
  return { created: !exists };
}

/** Idempotent: resets every privilege the role holds in the current database, then grants exactly RUNTIME_GRANTS. */
export async function applyRuntimeGrants(client: pg.Client, role: string) {
  assertRoleName(role);
  const id = client.escapeIdentifier(role);
  const db = client.escapeIdentifier((await client.query('SELECT current_database() AS d')).rows[0].d as string);

  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r: { tablename: string }) => r.tablename);
  const unaccounted = tables.filter((t) => !(t in RUNTIME_GRANTS) && !READ_ONLY_EXTENSION_TABLES.includes(t));
  if (unaccounted.length > 0) {
    throw new Error(`No runtime grant decision for table(s): ${unaccounted.join(', ')}. Add them to RUNTIME_GRANTS in src/db/roles.ts.`);
  }

  await client.query(`REVOKE ALL ON DATABASE ${db} FROM ${id}`);
  await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${id}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${id}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${id}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${id}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${id}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${id}`);
  // The migration bookkeeping schema is not the API's business.
  if ((await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle'")).rowCount === 1) {
    await client.query(`REVOKE ALL ON SCHEMA drizzle FROM ${id}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${id}`);
  }

  for (const table of tables) {
    const grant = RUNTIME_GRANTS[table];
    if (!grant) continue;
    const t = client.escapeIdentifier(table);
    const plain = grant.updateColumns ? grant.privileges.filter((p) => p !== 'UPDATE') : grant.privileges;
    if (plain.length > 0) await client.query(`GRANT ${plain.join(', ')} ON ${t} TO ${id}`);
    if (grant.updateColumns) {
      await client.query(`GRANT UPDATE (${grant.updateColumns.map((c) => client.escapeIdentifier(c)).join(', ')}) ON ${t} TO ${id}`);
    }
  }
  // Identity/serial columns need their sequences to insert.
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${id}`);
  // Functions (including PostGIS) stay executable through PUBLIC; reading spatial_ref_sys is PostGIS's own default.
  return { tables: tables.length };
}

/** Reads the grant plan back, for the setup command's report (no secrets involved). */
export function describeGrants() {
  return Object.entries(RUNTIME_GRANTS).map(([table, g]) => ({
    table,
    privileges: g.privileges.length === 0 ? 'none' : g.updateColumns ? `${g.privileges.filter((p) => p !== 'UPDATE').join('/')}/UPDATE(${g.updateColumns.length} cols)` : g.privileges.join('/'),
  }));
}
