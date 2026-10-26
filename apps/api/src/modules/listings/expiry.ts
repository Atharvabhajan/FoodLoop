import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { describeError } from '../../log.js';
import { unguarded, type Guard } from '../../ops/advisory-lock.js';
import { foodListings, listingEvents } from '../../db/schema.js';

/**
 * Marks AVAILABLE listings whose pickup deadline has passed as EXPIRED.
 *
 * Idempotent: the UPDATE is conditional on status = 'AVAILABLE', so repeated or concurrent
 * runs expire each listing (and record its history event) exactly once. API reads also filter
 * by deadline, so correctness never depends on this job having run.
 */
export async function expireListings(db: Db, now: Date = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(foodListings)
      .set({ status: 'EXPIRED', expiredAt: now, updatedAt: now })
      .where(and(eq(foodListings.status, 'AVAILABLE'), lte(foodListings.pickupDeadline, now)))
      .returning({ id: foodListings.id });
    if (expired.length > 0) {
      await tx
        .insert(listingEvents)
        .values(expired.map((l) => ({ listingId: l.id, action: 'EXPIRED' as const, actorUserId: null })));
    }
    return expired.length;
  });
}

/** Simple single-process scheduler (no Redis/queue in V1). Returns a stop function. */
export function startExpiryWorker(db: Db, intervalSeconds: number, log: (msg: string) => void = console.log, guard: Guard = unguarded) {
  if (intervalSeconds <= 0) return () => undefined;
  const run = async () => {
    try {
      await guard(async () => {
        const n = await expireListings(db);
        if (n > 0) log(JSON.stringify({ level: 'info', msg: 'Expired listings', count: n }));
      });
    } catch (err) {
      log(JSON.stringify({ level: 'error', msg: 'Expiry run failed', ...describeError(err) }));
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
