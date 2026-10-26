import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { ngoRequirements, type NgoRequirement, type Organization, type PlatformRole } from '../../db/schema.js';
import { AppError, errors, fieldErrors } from '../../http/errors.js';
import { assertOrganizationVerified } from '../organizations/guards.js';
import { currentOrganization } from '../organizations/membership.js';
import type { CreateRequirementInput, UpdateRequirementInput } from './schemas.js';

export interface Actor {
  id: string;
  platformRole: PlatformRole;
}

type Clock = () => Date;

/**
 * `active`       : intake is enabled and the availability window has not ended.
 * `acceptingNow` : active AND the window has started. Neither flag does any matching.
 */
export function serializeRequirement(r: NgoRequirement, now: Date) {
  const active = r.intakeEnabled && r.availableTo.getTime() > now.getTime();
  return {
    id: r.id,
    ngoOrgId: r.ngoOrgId,
    foodCategories: r.foodCategories,
    neededServings: r.neededServings,
    capacityServings: r.capacityServings,
    serviceRadiusKm: r.serviceRadiusKm,
    availableFrom: r.availableFrom,
    availableTo: r.availableTo,
    dietaryMustHave: r.dietaryMustHave,
    dietaryMustAvoid: r.dietaryMustAvoid,
    intakeEnabled: r.intakeEnabled,
    active,
    acceptingNow: active && r.availableFrom.getTime() <= now.getTime(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type Merged = Pick<NgoRequirement, 'neededServings' | 'capacityServings' | 'availableFrom' | 'availableTo'> & {
  dietaryMustHave?: string[];
  dietaryMustAvoid?: string[];
};

function validate(m: Merged, now: Date) {
  const f: Record<string, string> = {};
  if (m.capacityServings < m.neededServings) f.capacityServings = 'Capacity must be at least the servings needed.';
  if (m.availableFrom >= m.availableTo) f.availableTo = 'Availability end must be after the start.';
  else if (m.availableTo <= now) f.availableTo = 'Availability end must be in the future. Extend the window to keep receiving food.';
  const clash = (m.dietaryMustHave ?? []).filter((t) => (m.dietaryMustAvoid ?? []).includes(t));
  if (clash.length > 0) f.dietaryMustAvoid = 'A tag cannot be both required and excluded.';
  if (Object.keys(f).length > 0) throw fieldErrors(f);
}

const exists = () => new AppError(409, 'REQUIREMENT_EXISTS', 'Your organization already has a requirement. Update it instead.');

/** Called after a requirement changes so recommendations can be refreshed (never rolls back the change). */
export interface RequirementHooks {
  requirementChanged?(ngoOrgId: string): Promise<void>;
}

export function createRequirementService(db: Db, clock: Clock = () => new Date(), hooks: RequirementHooks = {}) {
  /** The caller's NGO organization. Managing requires it to be VERIFIED; reading does not. */
  async function ngoOrg(actor: Actor, verified: boolean): Promise<Organization> {
    if (actor.platformRole !== 'ngo') throw errors.forbidden();
    const org = await currentOrganization(db, actor.id, 'NGO');
    if (verified) await assertOrganizationVerified(db, org.id);
    return org;
  }

  async function load(orgId: string) {
    const [row] = await db.select().from(ngoRequirements).where(eq(ngoRequirements.ngoOrgId, orgId)).limit(1);
    return row ?? null;
  }

  async function mustLoad(orgId: string) {
    const row = await load(orgId);
    if (!row) throw new AppError(404, 'REQUIREMENT_NOT_FOUND', 'You have not set up your food requirements yet.');
    return row;
  }

  return {
    async getCurrent(actor: Actor) {
      const org = await ngoOrg(actor, false);
      const row = await load(org.id);
      return {
        organization: { id: org.id, name: org.name, verificationStatus: org.verificationStatus },
        requirement: row ? serializeRequirement(row, clock()) : null,
      };
    },

    async create(actor: Actor, input: CreateRequirementInput) {
      const org = await ngoOrg(actor, true);
      const now = clock();
      validate(input, now);
      if (await load(org.id)) throw exists();
      try {
        const [row] = await db.insert(ngoRequirements).values({ ...input, ngoOrgId: org.id, updatedBy: actor.id }).returning();
        await hooks.requirementChanged?.(org.id);
        return serializeRequirement(row!, now);
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
        if (code === '23505') throw exists();
        throw err;
      }
    },

    async update(actor: Actor, input: UpdateRequirementInput) {
      const org = await ngoOrg(actor, true);
      const now = clock();
      const current = await mustLoad(org.id);
      validate({ ...current, ...input }, now);
      const [row] = await db
        .update(ngoRequirements)
        .set({ ...input, updatedBy: actor.id, updatedAt: now })
        .where(eq(ngoRequirements.id, current.id))
        .returning();
      await hooks.requirementChanged?.(org.id);
      return serializeRequirement(row!, now);
    },

    /** Idempotent: pausing a paused requirement (or resuming an active one) succeeds unchanged. */
    async setIntake(actor: Actor, enabled: boolean) {
      const org = await ngoOrg(actor, true);
      const now = clock();
      const current = await mustLoad(org.id);
      if (current.intakeEnabled === enabled) return serializeRequirement(current, now);
      const [row] = await db
        .update(ngoRequirements)
        .set({ intakeEnabled: enabled, updatedBy: actor.id, updatedAt: now })
        .where(eq(ngoRequirements.id, current.id))
        .returning();
      await hooks.requirementChanged?.(org.id);
      return serializeRequirement(row!, now);
    },
  };
}

export type RequirementService = ReturnType<typeof createRequirementService>;
