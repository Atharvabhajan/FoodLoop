import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, loadRetentionPolicy } from '../src/config.js';
import { describeTarget, resolveAdminUrl, sameLogin } from '../src/db/admin-url.js';
import { WORKER_LOCKS, advisoryGuard } from '../src/ops/advisory-lock.js';
import { setup, testDatabaseUrl } from './helpers.js';

const ctx = setup();
afterAll(() => ctx.pool.end());

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://foodloop_runtime:runtime-pw@db.internal:5432/foodloop',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  COOKIE_SECURE: 'true',
};

describe('control: the denial tests are not vacuous', () => {
  it('the same kinds of statements succeed on the privileged connection', async () => {
    await ctx.pool.query('CREATE TABLE zz_control_probe (a int)');
    await ctx.pool.query('DROP TABLE zz_control_probe');
    await expect(ctx.runtime.pool.query('CREATE TABLE zz_control_probe (a int)')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('separate runtime and privileged connections', () => {
  it('privileged commands prefer MIGRATION_DATABASE_URL', () => {
    const url = resolveAdminUrl({ MIGRATION_DATABASE_URL: 'postgres://owner:a@h/db', DATABASE_URL: 'postgres://runtime:b@h/db' }, () => undefined);
    expect(url).toContain('owner');
  });

  it('in production a missing MIGRATION_DATABASE_URL is an error, never a silent fall back to the runtime URL', () => {
    expect(() => resolveAdminUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://runtime:b@h/db' }, () => undefined)).toThrow(/MIGRATION_DATABASE_URL is required in production/);
  });

  it('outside production the legacy fall back works but is announced', () => {
    const notices: string[] = [];
    const url = resolveAdminUrl({ NODE_ENV: 'development', DATABASE_URL: 'postgres://postgres:pw@h/db' }, (m) => notices.push(m));
    expect(url).toContain('postgres');
    expect(notices.join(' ')).toMatch(/MIGRATION_DATABASE_URL is not set/);
    expect(notices.join(' ')).not.toContain('pw');
  });

  it('fails clearly when neither URL is set', () => {
    expect(() => resolveAdminUrl({}, () => undefined)).toThrow(/not set/);
  });

  it('describes a connection without its password or the rest of the string', () => {
    const text = describeTarget('postgres://foodloop_runtime:s3cr3t-pass@db.internal:6543/foodloop?sslmode=require');
    expect(text).toBe('foodloop_runtime@db.internal:6543/foodloop');
    expect(text).not.toContain('s3cr3t');
    expect(describeTarget('not a url')).not.toContain('not a url');
  });

  it('knows when two URLs are the same login', () => {
    expect(sameLogin('postgres://a:1@h:5432/x', 'postgres://a:2@h/y')).toBe(true);
    expect(sameLogin('postgres://a:1@h/x', 'postgres://b:1@h/x')).toBe(false);
  });

  it('the API configuration refuses, in production, the same login for runtime and migrations', () => {
    expect(() => loadConfig({ ...base, MIGRATION_DATABASE_URL: 'postgres://foodloop_runtime:other@db.internal:5432/foodloop' })).toThrow(/same database login/);
    expect(() => loadConfig({ ...base, MIGRATION_DATABASE_URL: 'postgres://foodloop_owner:other@db.internal:5432/foodloop' })).not.toThrow();
    // The error never carries either connection string.
    try {
      loadConfig({ ...base, MIGRATION_DATABASE_URL: base.DATABASE_URL });
    } catch (err) {
      expect((err as Error).message).not.toContain('runtime-pw');
      expect((err as Error).message).not.toMatch(/postgres:\/\//);
    }
  });

  it('production requires strict privilege checks and rate limits', () => {
    expect(() => loadConfig({ ...base, DB_PRIVILEGE_CHECK: 'warn' })).toThrow(/DB_PRIVILEGE_CHECK must be "enforce"/);
    expect(() => loadConfig({ ...base, RATE_LIMIT_ENABLED: 'false' })).toThrow(/RATE_LIMIT_ENABLED/);
    expect(loadConfig(base).privilegeCheck).toBe('enforce');
  });

  it('outside production the check warns by default and can be set to enforce', () => {
    const dev = { ...base, NODE_ENV: 'development', COOKIE_SECURE: 'false' };
    expect(loadConfig(dev).privilegeCheck).toBe('warn');
    expect(loadConfig({ ...dev, DB_PRIVILEGE_CHECK: 'enforce' }).privilegeCheck).toBe('enforce');
    expect(() => loadConfig({ ...dev, DB_PRIVILEGE_CHECK: 'off' })).toThrow();
  });

  it('API code never reads the privileged URL or resolves it (so it cannot fall back to it)', () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const operatorOnly = new Set(['db/admin-url.ts', 'db/migrate.ts', 'db/roles-cli.ts', 'db/setup.ts', 'db/seed.ts', 'db/seed-demo-fixtures.ts', 'db/check-postgis.ts', 'ops/retention-cli.ts', 'config.ts']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (operatorOnly.has(rel)) continue;
          // An actual read (env.MIGRATION_DATABASE_URL / env['...']) or the resolver; comments and advice text are fine.
          if (/\.MIGRATION_DATABASE_URL|\[['"]MIGRATION_DATABASE_URL|import[^;]*resolveAdminUrl/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('config.ts only mentions the privileged URL to compare logins, never to connect', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../src/config.ts'), 'utf8');
    expect(text).not.toMatch(/createDb|new pg\./);
  });
});

describe('retention policy configuration', () => {
  it('is empty (delete nothing) unless periods are set; blank values mean unset', () => {
    expect(loadRetentionPolicy({})).toEqual({ evidenceDays: null, incidentDays: null, orphanFileHours: null });
    expect(loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: '', RETENTION_INCIDENT_DAYS: '  '.trim() })).toEqual({ evidenceDays: null, incidentDays: null, orphanFileHours: null });
  });

  it('accepts sensible periods', () => {
    expect(loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: '90', RETENTION_INCIDENT_DAYS: '365', RETENTION_ORPHAN_FILE_HOURS: '48' })).toEqual({ evidenceDays: 90, incidentDays: 365, orphanFileHours: 48 });
  });

  it('refuses periods short enough to be a typo, and nonsensical combinations', () => {
    expect(() => loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: '0' })).toThrow();
    expect(() => loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: '1' })).toThrow();
    expect(() => loadRetentionPolicy({ RETENTION_INCIDENT_DAYS: '7' })).toThrow();
    expect(() => loadRetentionPolicy({ RETENTION_ORPHAN_FILE_HOURS: '0' })).toThrow();
    expect(() => loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: '100', RETENTION_INCIDENT_DAYS: '50' })).toThrow(/must not be shorter/);
    expect(() => loadRetentionPolicy({ RETENTION_EVIDENCE_DAYS: 'soon' })).toThrow();
  });
});

describe('background sweeps and multiple processes', () => {
  it('a sweep already running elsewhere is skipped, not duplicated; the lock is released afterwards', async () => {
    const guard = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.rescueSettlement);
    const other = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.rescueSettlement);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const first = guard(async () => {
      started();
      await hold;
    });
    await running;
    let ranSecond = false;
    expect(await other(async () => { ranSecond = true; })).toBe(false);
    expect(ranSecond).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await other(async () => { ranSecond = true; })).toBe(true); // free again
    expect(ranSecond).toBe(true);
  });

  it('different sweeps do not block each other', async () => {
    const a = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.listingExpiry);
    const b = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.rescueSettlement);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const first = a(async () => { started(); await hold; });
    await running;
    expect(await b(async () => undefined)).toBe(true);
    release();
    await first;
  });

  it('releases the lock even when the sweep throws', async () => {
    const g = advisoryGuard(ctx.runtime.pool, WORKER_LOCKS.listingExpiry);
    await expect(g(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await g(async () => undefined)).toBe(true);
  });

  it('uses the runtime role (advisory locks need no extra privilege)', async () => {
    expect(testDatabaseUrl()).toBeTruthy();
    expect((await ctx.runtime.pool.query('SELECT pg_try_advisory_lock(7299) AS ok')).rows[0].ok).toBe(true);
    await ctx.runtime.pool.query('SELECT pg_advisory_unlock_all()');
  });
});
