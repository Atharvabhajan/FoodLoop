import type { Pool } from '../db/client.js';

/**
 * Database-backed coordination for the background sweeps. A second API process (an overlapping restart, a mistaken
 * second instance) skips a sweep another process is already running instead of duplicating it. This protects the
 * sweeps only: Socket.IO rooms, rate-limit counters and uploaded files are still per-process, so the app remains a
 * single-node design (docs/phase-7-security-operations.md).
 */
export const WORKER_LOCKS = { listingExpiry: 7201, rescueSettlement: 7202, escalation: 7203 } as const;

export type Guard = (task: () => Promise<void>) => Promise<boolean>;

/** Runs `task` only if the advisory lock is free; returns whether it ran. The lock is held on a dedicated connection. */
export function advisoryGuard(pool: Pool, key: number): Guard {
  return async (task) => {
    const client = await pool.connect();
    try {
      const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows[0].ok as boolean;
      if (!got) return false;
      try {
        await task();
        return true;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      }
    } finally {
      client.release();
    }
  };
}

export const unguarded: Guard = async (task) => {
  await task();
  return true;
};
