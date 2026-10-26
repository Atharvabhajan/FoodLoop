import { sql } from 'drizzle-orm';
import {
  PROVIDER_POINT,
  availableListing,
  matchedNgo,
  pointAt,
  signedInAgent,
  verifiedAgent,
  type Ctx,
} from './helpers.js';

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

export const R = (id: string) => `/api/v1/rescues/${id}`;
export const rows = async (ctx: Ctx, q: ReturnType<typeof sql>) => (await ctx.db.execute(q)).rows as Record<string, unknown>[];
export const count = async (ctx: Ctx, q: ReturnType<typeof sql>) => Number((await rows(ctx, q))[0]!.n);

/**
 * A runner whose profile is complete and positioned `metersAway` from the provider (default 2 km, west).
 * Set directly in SQL so distances are exact; the API rounds a runner's own position to ~1 km.
 */
export async function runnerAt(
  ctx: Ctx,
  opts: { metersAway?: number; bearing?: number; capacityKg?: number | null; radiusKm?: number | null; availability?: 'AVAILABLE' | 'OFFLINE'; vehicle?: string | null; positioned?: boolean } = {},
) {
  const who = await signedInAgent(ctx, 'runner');
  const point = await pointAt(ctx, PROVIDER_POINT, opts.metersAway ?? 2000, opts.bearing ?? 270);
  const positioned = opts.positioned ?? true;
  await ctx.db.execute(sql`
    UPDATE volunteer_profiles SET
      availability_status = ${opts.availability ?? 'AVAILABLE'}::availability_status,
      vehicle_type = ${opts.vehicle === undefined ? 'BICYCLE' : opts.vehicle}::vehicle_type,
      capacity_kg = ${opts.capacityKg === undefined ? 25 : opts.capacityKg},
      radius_km = ${opts.radiusKm === undefined ? 8 : opts.radiusKm},
      latitude = ${positioned ? point.latitude : null},
      longitude = ${positioned ? point.longitude : null}
    WHERE user_id = (SELECT id FROM users WHERE email = ${who.email})`);
  const userId = ((await rows(ctx, sql`SELECT id FROM users WHERE email = ${who.email}`))[0] as { id: string }).id;
  return { ...who, userId };
}

export const accept = (agent: Agent, listingId: string, body: Record<string, unknown> = {}) => agent.post(`/api/v1/listings/${listingId}/accept`).send(body);

/**
 * Provider + NGO + live listing, accepted by the NGO asking for a runner and confirmed by the provider:
 * the rescue is AWAITING_RUNNER and the provider holds the pickup code.
 */
export async function awaitingRunner(ctx: Ctx, listing: Record<string, unknown> = {}) {
  const provider = await verifiedAgent(ctx, 'provider');
  const ngo = await matchedNgo(ctx, { metersAway: 1000 });
  const l = await availableListing(provider.agent, listing);
  const acc = await accept(ngo.agent, l.id, { transportMode: 'RUNNER' });
  if (acc.status !== 201) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  const rescueId = acc.body.data.rescue.id as string;
  const conf = await provider.agent.post(`${R(rescueId)}/confirm`).send({});
  if (conf.status !== 200) throw new Error(`confirm failed ${conf.status} ${JSON.stringify(conf.body)}`);
  return { provider, ngo, listing: l, rescueId, code: conf.body.data.pickupCode as string };
}

/** AWAITING_RUNNER plus a runner who has accepted: PICKUP_ASSIGNED. */
export async function assigned(ctx: Ctx, listing: Record<string, unknown> = {}) {
  const s = await awaitingRunner(ctx, listing);
  const runner = await runnerAt(ctx);
  const res = await runner.agent.post(`${R(s.rescueId)}/assign-self`).send({});
  if (res.status !== 200) throw new Error(`assign failed ${res.status} ${JSON.stringify(res.body)}`);
  return { ...s, runner };
}

/** The runner has collected the food: IN_TRANSIT. */
export async function inTransit(ctx: Ctx, collected = 40) {
  const s = await assigned(ctx);
  const res = await s.runner.agent.post(`${R(s.rescueId)}/pickup/verify`).send({ code: s.code, collectedServings: collected });
  if (res.status !== 200) throw new Error(`verify failed ${res.status} ${JSON.stringify(res.body)}`);
  return s;
}

/** The runner has handed over: DELIVERED, waiting for the NGO. */
export async function delivered(ctx: Ctx, collected = 40) {
  const s = await inTransit(ctx, collected);
  const res = await s.runner.agent.post(`${R(s.rescueId)}/delivery/handover`).send({});
  if (res.status !== 200) throw new Error(`handover failed ${res.status} ${JSON.stringify(res.body)}`);
  return s;
}

export const rescueRow = async (ctx: Ctx, id: string) => (await rows(ctx, sql`SELECT * FROM rescues WHERE id = ${id}::uuid`))[0] as Record<string, unknown>;
export const listingStatus = async (ctx: Ctx, id: string) => ((await rows(ctx, sql`SELECT status FROM food_listings WHERE id = ${id}::uuid`))[0] as { status: string }).status;
export const events = async (ctx: Ctx, rescueId: string) =>
  (await rows(ctx, sql`SELECT event_type, from_status, to_status, actor_role, reason, metadata FROM rescue_events WHERE rescue_id = ${rescueId}::uuid ORDER BY seq`)) as {
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    actor_role: string;
    reason: string | null;
    metadata: Record<string, unknown>;
  }[];
export const assignments = async (ctx: Ctx, rescueId: string) =>
  (await rows(ctx, sql`SELECT runner_user_id, status, end_reason FROM rescue_assignments WHERE rescue_id = ${rescueId}::uuid ORDER BY accepted_at, id`)) as { runner_user_id: string; status: string; end_reason: string | null }[];
