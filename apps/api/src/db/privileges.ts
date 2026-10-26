import type pg from 'pg';
import { AUDIT_TABLES, DANGEROUS_MEMBERSHIPS } from './roles.js';

type Queryable = Pick<pg.Pool, 'query'>;

export interface PrivilegeReport {
  role: string;
  violations: { code: string; message: string }[];
}

/**
 * Inspects the connection the API is actually using (not its configuration) and lists anything that would let it
 * change the schema or rewrite audit history. Read-only; works with a least-privilege role.
 */
export async function inspectRuntimeConnection(pool: Queryable): Promise<PrivilegeReport> {
  const violations: PrivilegeReport['violations'] = [];
  const add = (code: string, message: string) => violations.push({ code, message });

  const who = (await pool.query(
    'SELECT current_user AS role, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
  )).rows[0] as { role: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean } | undefined;
  if (!who) throw new Error('Could not read the current database role.');

  if (who.rolsuper) add('SUPERUSER', 'The role is a superuser.');
  if (who.rolcreaterole) add('CREATEROLE', 'The role can create roles.');
  if (who.rolcreatedb) add('CREATEDB', 'The role can create databases.');
  if (who.rolreplication) add('REPLICATION', 'The role has the replication attribute.');
  if (who.rolbypassrls) add('BYPASSRLS', 'The role bypasses row-level security.');

  for (const m of DANGEROUS_MEMBERSHIPS) {
    const r = await pool.query('SELECT pg_has_role(current_user, $1, $2) AS member', [m, 'USAGE']).catch(() => null);
    if (r?.rows[0]?.member) add(`MEMBER_OF_${m.toUpperCase()}`, `The role is a member of ${m}.`);
  }

  const schemaPrivileges = (await pool.query(
    "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema",
  )).rows[0] as { can_create_in_public: boolean; can_create_schema: boolean };
  if (schemaPrivileges.can_create_in_public) add('CAN_CREATE_IN_PUBLIC', 'The role can create objects in the public schema.');
  if (schemaPrivileges.can_create_schema) add('CAN_CREATE_SCHEMA', 'The role can create schemas in this database.');

  const owned = (await pool.query(
    `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user)::int AS relations,
            (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user)::int AS functions`,
  )).rows[0] as { relations: number; functions: number };
  if (owned.relations > 0 || owned.functions > 0) add('OWNS_SCHEMA_OBJECTS', 'The role owns tables or functions, so it could alter or drop them.');

  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r: { tablename: string }) => r.tablename);
  const lacking: string[] = [];
  for (const table of tables) {
    if (table === 'spatial_ref_sys') continue;
    const has = async (priv: string) =>
      (await pool.query('SELECT has_table_privilege(current_user, $1, $2) AS ok', [`public.${table}`, priv])).rows[0].ok as boolean;
    for (const priv of ['TRUNCATE', 'TRIGGER', 'REFERENCES']) if (await has(priv)) lacking.push(`${priv} on ${table}`);
    if ((AUDIT_TABLES as readonly string[]).includes(table)) {
      for (const priv of ['UPDATE', 'DELETE']) if (await has(priv)) lacking.push(`${priv} on ${table}`);
    }
    if (table === 'incident_reports' && (await has('DELETE'))) lacking.push('DELETE on incident_reports');
  }
  if (lacking.length > 0) add('EXCESSIVE_TABLE_PRIVILEGES', `The role holds privileges that would let it rewrite history or alter structure: ${lacking.join('; ')}.`);

  return { role: who.role, violations };
}

export type PrivilegeMode = 'enforce' | 'warn';

/**
 * Startup gate. In `enforce` mode any violation stops the API with a clear, secret-free message; `warn` mode (the
 * default outside production) still reports the problem on every start so it is never silent.
 */
export async function verifyRuntimeDatabase(
  pool: Queryable,
  mode: PrivilegeMode,
  log: (entry: Record<string, unknown>) => void = (e) => console.warn(JSON.stringify(e)),
) {
  const report = await inspectRuntimeConnection(pool);
  if (report.violations.length === 0) return report;
  const codes = report.violations.map((v) => v.code);
  if (mode === 'enforce') {
    // Short on purpose (log lines are length-bounded): the fix comes first, then the evidence.
    const shown = codes.slice(0, 3).join(', ');
    const more = codes.length > 3 ? ` and ${codes.length - 3} more` : '';
    throw new Error(
      `Refusing to start: DATABASE_URL must be the least-privilege runtime role (npm run db:roles; docs/phase-7-security-operations.md). ` +
        `Role "${report.role}" has excessive privileges: ${shown}${more}.`,
    );
  }
  log({
    level: 'warn',
    msg: 'Database role has excessive privileges (DB_PRIVILEGE_CHECK=warn). This must be fixed before deployment.',
    role: report.role,
    violations: codes,
  });
  return report;
}
