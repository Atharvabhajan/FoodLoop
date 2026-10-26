import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_RUNTIME_ROLE, testDatabaseUrl, testRuntimeUrl } from './helpers.js';

const cwd = path.resolve(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Starts the real server entry point as its own process with exactly this environment. */
async function startServer(env: Record<string, string>, waitFor: RegExp, timeoutMs = 25_000) {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      JWT_ACCESS_SECRET: 'startup-test-secret-startup-test-secret-0123456789',
      API_PORT: String(port),
      EXPIRY_INTERVAL_SECONDS: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  const result = await new Promise<{ exited: boolean; code: number | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false, code: null }), timeoutMs);
    const check = setInterval(() => {
      if (waitFor.test(output)) {
        clearTimeout(timer);
        clearInterval(check);
        resolve({ exited: false, code: null });
      }
    }, 100);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(check);
      resolve({ exited: true, code });
    });
  });
  return { child, port, output: () => output, ...result };
}

const production = { NODE_ENV: 'production', COOKIE_SECURE: 'true', RATE_LIMIT_ENABLED: 'true', CORS_ALLOWED_ORIGINS: 'https://app.example.test' };

describe('the real server process', () => {
  it('refuses to start in production on a privileged (owner/superuser) database login', async () => {
    const s = await startServer({ ...production, DATABASE_URL: testDatabaseUrl() }, /never-matches/);
    expect(s.exited).toBe(true);
    expect(s.code).toBe(1);
    const out = s.output();
    expect(out).toMatch(/API failed to start/);
    expect(out).toMatch(/Refusing to start/);
    expect(out).toMatch(/excessive privileges/);
    expect(out).toMatch(/db:roles/);
    // No credentials or connection strings in the failure output.
    expect(out).not.toContain(decodeURIComponent(new URL(testDatabaseUrl()).password));
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  }, 40_000);

  it('does not fall back to a privileged URL that happens to be in its environment', async () => {
    // Production API given a privileged MIGRATION_DATABASE_URL AND a runtime DATABASE_URL: it must use the runtime one.
    const s = await startServer({ ...production, DATABASE_URL: testRuntimeUrl(), MIGRATION_DATABASE_URL: testDatabaseUrl() }, /FoodLoop API listening/);
    try {
      expect(s.exited).toBe(false);
      const out = s.output();
      expect(out).toMatch(/FoodLoop API listening/);
      expect(out).toContain(`"dbRole":"${TEST_RUNTIME_ROLE}"`);
      expect(out).toContain('"dbRoleClean":true');
      expect(out).not.toMatch(/postgres(ql)?:\/\//);
    } finally {
      s.child.kill();
    }
  }, 40_000);

  it('rejects the same login for runtime and migrations in production before touching the database', async () => {
    const s = await startServer({ ...production, DATABASE_URL: testRuntimeUrl(), MIGRATION_DATABASE_URL: testRuntimeUrl() }, /never-matches/);
    expect(s.exited).toBe(true);
    expect(s.code).toBe(1);
    expect(s.output()).toMatch(/same database login/);
    expect(s.output()).not.toContain(decodeURIComponent(new URL(testRuntimeUrl()).password));
  }, 40_000);

  it('outside production a privileged login still starts, with a visible warning on every start', async () => {
    const s = await startServer({ NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl() }, /FoodLoop API listening/);
    try {
      expect(s.exited).toBe(false);
      const out = s.output();
      expect(out).toMatch(/excessive privileges/);
      expect(out).toMatch(/"level":"warn"/);
      expect(out).toContain('"dbRoleClean":false');
      expect(out).not.toContain(decodeURIComponent(new URL(testDatabaseUrl()).password));
    } finally {
      s.child.kill();
    }
  }, 40_000);

  it('fails with a clear, secret-free message when the database is unreachable', async () => {
    const s = await startServer({ ...production, DATABASE_URL: 'postgres://foodloop_runtime:Sup3rSecretPw@127.0.0.1:1/foodloop' }, /never-matches/);
    expect(s.exited).toBe(true);
    expect(s.code).toBe(1);
    expect(s.output()).toMatch(/API failed to start/);
    expect(s.output()).not.toContain('Sup3rSecretPw');
  }, 40_000);

  it('fails clearly when required configuration is missing', async () => {
    const s = await startServer({ NODE_ENV: 'development' }, /never-matches/);
    expect(s.exited).toBe(true);
    expect(s.code).toBe(1);
    expect(s.output()).toMatch(/DATABASE_URL is required/);
  }, 40_000);
});
