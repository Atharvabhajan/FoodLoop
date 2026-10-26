import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inspectRuntimeConnection, verifyRuntimeDatabase } from '../src/db/privileges.js';
import { RUNTIME_GRANTS, applyRuntimeGrants, ensureRuntimeRole, scramVerifier } from '../src/db/roles.js';
import { TEST_RUNTIME_ROLE, resetData, setup, testDatabaseUrl } from './helpers.js';
import { awaitingRunner } from './runner-helpers.js';

const ctx = setup();
beforeEach(() => resetData(ctx.db));
afterAll(() => ctx.pool.end());

const runtime = () => ctx.runtime.pool;

/** Runs a statement on the application's own connection and returns the Postgres error code (or "ok"). */
async function outcome(statement: string): Promise<string> {
  try {
    await runtime().query(statement);
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('the application runs as the least-privilege role', () => {
  it('connects as the runtime role, not the privileged one', async () => {
    const who = (await runtime().query('SELECT current_user AS u')).rows[0].u as string;
    expect(who).toBe(TEST_RUNTIME_ROLE);
    expect(decodeURIComponent(new URL(ctx.config.DATABASE_URL).username)).toBe(TEST_RUNTIME_ROLE);
    expect(decodeURIComponent(new URL(testDatabaseUrl()).username)).not.toBe(TEST_RUNTIME_ROLE);
  });

  it('has bounded statements and idle transactions', async () => {
    expect((await runtime().query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('30s');
    expect((await runtime().query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('1min');
  });

  it('holds no excessive privileges (inspection finds nothing)', async () => {
    const report = await inspectRuntimeConnection(runtime());
    expect(report).toEqual({ role: TEST_RUNTIME_ROLE, violations: [] });
  });

  it('is not a superuser, does not own the schema and cannot create anything', async () => {
    const r = (await runtime().query('SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    const owned = (await runtime().query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user")).rows[0].n;
    expect(owned).toBe(0);
  });

  it('the inspection does flag a privileged connection (so the startup gate can refuse it)', async () => {
    const report = await inspectRuntimeConnection(ctx.pool);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations.map((v) => v.code)).toContain('OWNS_SCHEMA_OBJECTS');
  });
});

describe('the runtime role cannot change the schema', () => {
  const schemaChanges: [string, string][] = [
    ['create a table', 'CREATE TABLE zz_runtime_probe (a int)'],
    ['create a schema', 'CREATE SCHEMA zz_runtime_probe'],
    ['add a column', 'ALTER TABLE rescues ADD COLUMN zz_probe int'],
    ['drop a table', 'DROP TABLE rescue_events'],
    ['replace an audit function', 'CREATE OR REPLACE FUNCTION rescue_events_reject_mutation() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql'],
    ['create a role', 'CREATE ROLE zz_runtime_probe'],
    ['make itself a superuser', `ALTER ROLE ${TEST_RUNTIME_ROLE} SUPERUSER`],
    ['run a program on the server', "COPY (SELECT 1) TO PROGRAM 'echo probe'"],
    ['read the migration bookkeeping', 'SELECT * FROM drizzle.__drizzle_migrations'],
    ['read the retention log', 'SELECT * FROM retention_runs'],
    ['write the PostGIS reference table', 'DELETE FROM spatial_ref_sys'],
  ];
  for (const [what, statement] of schemaChanges) {
    it(`cannot ${what}`, async () => {
      expect(await outcome(statement)).toBe('42501'); // insufficient_privilege
    });
  }
});

describe('the runtime role cannot rewrite audit history or bypass its protections', () => {
  const audit = ['rescue_events', 'listing_events', 'verification_events', 'incident_evidence'];
  for (const table of audit) {
    it(`cannot update, delete or truncate ${table}`, async () => {
      expect(await outcome(`UPDATE ${table} SET created_at = now()`)).toBe('42501');
      expect(await outcome(`DELETE FROM ${table}`)).toBe('42501');
      expect(await outcome(`TRUNCATE ${table}`)).toBe('42501');
    });
  }

  it('cannot delete incident reports or edit their content, only fill in a resolution', async () => {
    expect(await outcome('DELETE FROM incident_reports')).toBe('42501');
    expect(await outcome("UPDATE incident_reports SET description = 'edited'")).toBe('42501');
    expect(await outcome("UPDATE incident_reports SET severity = 'LOW'")).toBe('42501');
    expect(await outcome("UPDATE incident_reports SET resolution_note = 'ok' WHERE false")).toBe('ok'); // the resolution columns remain writable
  });

  it('cannot switch off the append-only triggers, drop them, or turn trigger firing off', async () => {
    expect(await outcome('ALTER TABLE rescue_events DISABLE TRIGGER rescue_events_append_only')).toBe('42501');
    expect(await outcome('DROP TRIGGER rescue_events_append_only ON rescue_events')).toBe('42501');
    expect(await outcome("SET session_replication_role = 'replica'")).toBe('42501');
  });

  it('cannot use the retention purge switch: it holds no DELETE privilege to begin with', async () => {
    const client = await runtime().connect();
    try {
      await client.query("SELECT set_config('foodloop.retention_purge', 'on', false)");
      await expect(client.query('DELETE FROM incident_evidence')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM incident_reports')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('cannot truncate or delete application tables it only reads and writes', async () => {
    for (const t of ['users', 'rescues', 'food_listings', 'organizations']) {
      expect(await outcome(`TRUNCATE ${t}`)).toBe('42501');
    }
    expect(await outcome('DELETE FROM users')).toBe('42501');
  });
});

describe('ordinary application work still succeeds on the runtime role', () => {
  it('appends audit events and reads them back', async () => {
    const s = await awaitingRunner(ctx);
    const insert = await runtime().query("INSERT INTO rescue_events (rescue_id, event_type, actor_role) VALUES ($1, 'PRIVILEGE_PROBE', 'system') RETURNING id", [s.rescueId]);
    expect(insert.rowCount).toBe(1);
    const read = await runtime().query("SELECT count(*)::int AS n FROM rescue_events WHERE rescue_id = $1 AND event_type = 'PRIVILEGE_PROBE'", [s.rescueId]);
    expect(read.rows[0].n).toBe(1);
  });

  it('has the PostGIS access the geography queries need', async () => {
    const d = await runtime().query("SELECT ST_Distance('SRID=4326;POINT(73.85 18.52)'::geography, 'SRID=4326;POINT(73.86 18.52)'::geography) AS m");
    expect(Math.round(d.rows[0].m)).toBeGreaterThan(900);
    expect((await runtime().query('SELECT count(*)::int AS n FROM spatial_ref_sys')).rows[0].n).toBeGreaterThan(0);
    const within = await runtime().query("SELECT ST_DWithin('SRID=4326;POINT(73.85 18.52)'::geography, 'SRID=4326;POINT(73.86 18.52)'::geography, 2000) AS w");
    expect(within.rows[0].w).toBe(true);
  });

  it('can run the normal flows through the app (sign up, sign in, read)', async () => {
    const s = await awaitingRunner(ctx);
    const res = await s.ngo.agent.get(`/api/v1/rescues/${s.rescueId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rescue.status).toBe('AWAITING_RUNNER');
  });
});

describe('role setup', () => {
  it('has an explicit grant decision for every table (a new table must be decided before it ships)', async () => {
    const tables = (await ctx.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r: { tablename: string }) => r.tablename);
    const undecided = tables.filter((t) => t !== 'spatial_ref_sys' && !(t in RUNTIME_GRANTS));
    expect(undecided).toEqual([]);
    for (const t of Object.keys(RUNTIME_GRANTS)) expect(tables, `RUNTIME_GRANTS names a table that does not exist: ${t}`).toContain(t);
  });

  it('refuses to apply grants while a table has no decision', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query('CREATE TABLE zz_undecided (a int)');
      await expect(applyRuntimeGrants(client, TEST_RUNTIME_ROLE)).rejects.toThrow(/zz_undecided/);
    } finally {
      await client.query('DROP TABLE IF EXISTS zz_undecided');
      await client.end();
    }
  });

  it('puts an over-privileged role back to least privilege on re-run, without needing its password', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`ALTER ROLE ${TEST_RUNTIME_ROLE} CREATEDB`);
      await client.query(`GRANT pg_read_all_data TO ${TEST_RUNTIME_ROLE}`);
      await client.query(`GRANT TRUNCATE ON rescue_events TO ${TEST_RUNTIME_ROLE}`);
      const before = await inspectRuntimeConnection(runtime());
      expect(before.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['CREATEDB', 'MEMBER_OF_PG_READ_ALL_DATA', 'EXCESSIVE_TABLE_PRIVILEGES']));

      const result = await ensureRuntimeRole(client, { role: TEST_RUNTIME_ROLE });
      expect(result.created).toBe(false);
      await applyRuntimeGrants(client, TEST_RUNTIME_ROLE);
      expect((await inspectRuntimeConnection(runtime())).violations).toEqual([]);
    } finally {
      await ensureRuntimeRole(client, { role: TEST_RUNTIME_ROLE });
      await applyRuntimeGrants(client, TEST_RUNTIME_ROLE);
      await client.end();
    }
  });

  it('will not create a role without a password (it would be unusable or guessable)', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await expect(ensureRuntimeRole(client, { role: 'zz_never_created_role' })).rejects.toThrow(/RUNTIME_DB_PASSWORD/);
      await expect(ensureRuntimeRole(client, { role: 'Bad Role; DROP' , password: 'x'.repeat(20) })).rejects.toThrow(/Role names/);
    } finally {
      await client.end();
    }
  });

  it('stores a SCRAM verifier, never the plaintext password, and the verifier really authenticates', async () => {
    const v = scramVerifier('a-long-example-password');
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain('a-long-example-password');
    // The suite itself logs in as the role created from such a verifier; this proves it end to end.
    const probe = new pg.Pool({ connectionString: ctx.config.DATABASE_URL, max: 1 });
    try {
      expect((await probe.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      await probe.end();
    }
    const stored = (await ctx.pool.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [TEST_RUNTIME_ROLE])).rows[0]?.rolpassword as string | undefined;
    if (stored !== undefined) expect(stored.startsWith('SCRAM-SHA-256$')).toBe(true);
  });
});

describe('startup validation', () => {
  it('passes for the runtime role', async () => {
    const report = await verifyRuntimeDatabase(runtime(), 'enforce');
    expect(report.violations).toEqual([]);
  });

  it('refuses a privileged connection in enforce mode, with a clear secret-free message', async () => {
    let message = '';
    try {
      await verifyRuntimeDatabase(ctx.pool, 'enforce');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Refusing to start/);
    expect(message).toMatch(/excessive privileges/);
    expect(message).toMatch(/db:roles/);
    expect(message).not.toMatch(/postgres(ql)?:\/\//);
    expect(message).not.toContain(process.env.TEST_RUNTIME_PASSWORD ?? 'no-password-set');
    const adminUser = decodeURIComponent(new URL(testDatabaseUrl()).password);
    if (adminUser) expect(message).not.toContain(adminUser);
  });

  it('in warn mode starts but reports the problem every time (never silent)', async () => {
    const logged: Record<string, unknown>[] = [];
    const report = await verifyRuntimeDatabase(ctx.pool, 'warn', (e) => logged.push(e));
    expect(report.violations.length).toBeGreaterThan(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn' });
    expect(JSON.stringify(logged[0])).toMatch(/excessive privileges/);
  });

  it('does not mention the database that is being inspected by connection string', async () => {
    const logged: Record<string, unknown>[] = [];
    await verifyRuntimeDatabase(ctx.pool, 'warn', (e) => logged.push(e));
    expect(JSON.stringify(logged)).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe('append-only protections still hold for the privileged connection (defence in depth)', () => {
  it('rejects UPDATE and DELETE on audit history even for the owner', async () => {
    const s = await awaitingRunner(ctx);
    await expect(ctx.db.execute(sql`UPDATE rescue_events SET reason = 'tamper' WHERE rescue_id = ${s.rescueId}::uuid`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`DELETE FROM rescue_events WHERE rescue_id = ${s.rescueId}::uuid`)).rejects.toThrow();
  });
});
