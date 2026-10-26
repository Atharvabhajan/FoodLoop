/**
 * Which connection a command uses.
 *
 * The running API only ever reads DATABASE_URL (the least-privilege runtime role). Migrations, seed, role setup and
 * retention use MIGRATION_DATABASE_URL (the privileged connection). In production the privileged URL is mandatory;
 * outside production a missing one falls back to DATABASE_URL with a visible notice, so the original single-credential
 * development setup keeps working until it has been migrated (docs/phase-7-security-operations.md).
 */
export function resolveAdminUrl(env: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): string {
  const admin = env.MIGRATION_DATABASE_URL;
  if (admin) return admin;
  if (env.NODE_ENV === 'production') {
    throw new Error('MIGRATION_DATABASE_URL is required in production: privileged commands must not use the runtime connection.');
  }
  const legacy = env.DATABASE_URL;
  if (!legacy) throw new Error('MIGRATION_DATABASE_URL (or, for the legacy setup, DATABASE_URL) is not set. Copy .env.example to .env and edit it.');
  warn('Notice: MIGRATION_DATABASE_URL is not set; using DATABASE_URL for this privileged command (legacy single-credential setup).');
  return legacy;
}

/** "role@host:port/database": safe to print. Never includes the password or the rest of the connection string. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.username) || '(no user)'}@${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/** True when both URLs log in as the same user on the same server (so they are not really separated). */
export function sameLogin(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return decodeURIComponent(x.username) === decodeURIComponent(y.username) && x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432');
  } catch {
    return false;
  }
}
