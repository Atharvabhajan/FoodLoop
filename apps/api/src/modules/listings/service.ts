import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  foodListings,
  listingEvents,
  organizations,
  type FoodListing,
  type FoodCategory,
  type PlatformRole,
} from '../../db/schema.js';
import { AppError, errors, fieldErrors } from '../../http/errors.js';
import type { FileStorage } from '../../storage/index.js';
import { safeDisplayFilename } from '../organizations/documents.js';
import { assertOrganizationVerified } from '../organizations/guards.js';
import { activeOrganizations, currentOrganization, isActiveMember } from '../organizations/membership.js';
import { MIN_PICKUP_NOTICE_MINUTES, PREPARED_AT_GRACE_MINUTES, urgencyFor } from './constants.js';
import { IMAGE_TYPES, sniffImage, stripImageMetadata } from './images.js';
import { effectiveStatus, isListingEditable, nextListingStatus } from './lifecycle.js';
import type { CreateListingInput, UpdateListingInput } from './schemas.js';

export interface Actor {
  id: string;
  platformRole: PlatformRole;
}

type Clock = () => Date;
type Mode = 'draft' | 'publish' | 'live-edit';

const minutes = (n: number) => n * 60_000;
const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

/** Full view for the owning provider's members and admins (includes the exact pickup address). */
export function serializeListing(l: FoodListing, now: Date) {
  const status = effectiveStatus(l, now);
  return {
    id: l.id,
    providerOrgId: l.providerOrgId,
    title: l.title,
    description: l.description,
    foodCategory: l.foodCategory,
    servings: l.servings,
    estimatedKg: l.estimatedKg,
    preparedAt: l.preparedAt,
    pickupStart: l.pickupStart,
    pickupDeadline: l.pickupDeadline,
    addressLine: l.addressLine,
    city: l.city,
    latitude: l.latitude,
    longitude: l.longitude,
    packaging: l.packaging,
    dietaryTags: l.dietaryTags,
    allergenNotes: l.allergenNotes,
    transportRequired: l.transportRequired,
    hasImage: l.imageKey !== null,
    status,
    urgency: status === 'AVAILABLE' ? urgencyFor(l.pickupDeadline, now) : null,
    editable: isListingEditable(status),
    declarationAcceptedAt: l.declarationAcceptedAt,
    publishedAt: l.publishedAt,
    cancelledAt: l.cancelledAt,
    cancellationReason: l.cancellationReason,
    expiredAt: l.expiredAt,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

/**
 * Pre-acceptance view for verified NGOs. Deliberately omits the exact address, coordinates,
 * provider contact details and the internal declaration/cancellation data; location is a city
 * plus coordinates rounded to ~1 km.
 */
export function serializePublicListing(l: FoodListing, providerName: string, now: Date) {
  return {
    id: l.id,
    providerName,
    title: l.title,
    description: l.description,
    foodCategory: l.foodCategory,
    servings: l.servings,
    estimatedKg: l.estimatedKg,
    preparedAt: l.preparedAt,
    pickupStart: l.pickupStart,
    pickupDeadline: l.pickupDeadline,
    approximateArea: { city: l.city, latitude: round2(l.latitude), longitude: round2(l.longitude) },
    packaging: l.packaging,
    dietaryTags: l.dietaryTags,
    allergenNotes: l.allergenNotes,
    transportRequired: l.transportRequired,
    hasImage: l.imageKey !== null,
    status: 'AVAILABLE' as const,
    urgency: urgencyFor(l.pickupDeadline, now),
    publishedAt: l.publishedAt,
  };
}

type State = Pick<FoodListing, 'preparedAt' | 'pickupStart' | 'pickupDeadline' | 'latitude' | 'longitude'>;

function validateState(state: State, now: Date, mode: Mode, deadlineChanged = true) {
  const f: Record<string, string> = {};
  if (state.pickupStart >= state.pickupDeadline) f.pickupDeadline = 'Pickup deadline must be after the pickup start.';
  if (state.preparedAt > state.pickupDeadline) f.preparedAt = 'Preparation time must be before the pickup deadline.';
  else if (state.preparedAt.getTime() > now.getTime() + minutes(PREPARED_AT_GRACE_MINUTES)) {
    f.preparedAt = 'Preparation time cannot be in the future.';
  }
  if ((state.latitude == null) !== (state.longitude == null)) {
    f[state.latitude == null ? 'latitude' : 'longitude'] = 'Provide both latitude and longitude, or neither.';
  }
  if (!f.pickupDeadline) {
    if (mode === 'publish' || (mode === 'live-edit' && deadlineChanged)) {
      if (state.pickupDeadline.getTime() < now.getTime() + minutes(MIN_PICKUP_NOTICE_MINUTES)) {
        f.pickupDeadline = `Pickup deadline must be at least ${MIN_PICKUP_NOTICE_MINUTES} minutes from now.`;
      }
    } else if (mode === 'live-edit' && state.pickupDeadline <= now) {
      f.pickupDeadline = 'Pickup deadline has already passed.';
    }
  }
  if (Object.keys(f).length > 0) throw fieldErrors(f);
}

/** Called after a listing changes in a way that can alter its recommendations (never rolls back the change). */
export interface ListingHooks {
  listingChanged?(listingId: string): Promise<void>;
}

export function createListingService(db: Db, storage: FileStorage, clock: Clock = () => new Date(), hooks: ListingHooks = {}) {
  /** Locks and returns the listing for a provider-side write. Admins and non-members cannot write. */
  async function loadForWrite(actor: Actor, id: string, tx: Pick<Db, 'select'> = db, lock = false): Promise<FoodListing> {
    const q = tx.select().from(foodListings).where(eq(foodListings.id, id)).limit(1);
    const [listing] = lock ? await q.for('update') : await q;
    if (!listing) throw errors.notFound('Listing not found.');
    if (actor.platformRole === 'admin') throw errors.forbidden();
    if (actor.platformRole !== 'provider' || !(await isActiveMember(tx, actor.id, listing.providerOrgId))) {
      throw errors.notFound('Listing not found.');
    }
    return listing;
  }

  /** Who may see this listing: 'full' (provider members, admin), 'public' (verified NGO, live only) or none. */
  async function viewer(actor: Actor, id: string) {
    const [row] = await db
      .select({ listing: foodListings, providerName: organizations.name })
      .from(foodListings)
      .innerJoin(organizations, eq(organizations.id, foodListings.providerOrgId))
      .where(eq(foodListings.id, id))
      .limit(1);
    if (!row) throw errors.notFound('Listing not found.');
    const now = clock();
    if (actor.platformRole === 'admin') return { kind: 'full' as const, ...row, now };
    if (actor.platformRole === 'provider' && (await isActiveMember(db, actor.id, row.listing.providerOrgId))) {
      return { kind: 'full' as const, ...row, now };
    }
    if (actor.platformRole === 'ngo' && effectiveStatus(row.listing, now) === 'AVAILABLE') {
      await verifiedNgoOrganization(actor);
      return { kind: 'public' as const, ...row, now };
    }
    // An NGO that holds (or held) a rescue for this listing keeps the redacted view, e.g. for its photo.
    if (actor.platformRole === 'ngo') {
      const party = await db.execute(sql`
        SELECT 1 FROM rescues r JOIN organization_members m ON m.organization_id = r.ngo_org_id
         WHERE r.listing_id = ${id}::uuid AND m.user_id = ${actor.id}::uuid AND m.status = 'ACTIVE' LIMIT 1`);
      if (party.rows.length > 0) return { kind: 'public' as const, ...row, now };
    }
    throw errors.notFound('Listing not found.');
  }

  async function verifiedNgoOrganization(actor: Actor) {
    if (actor.platformRole !== 'ngo') throw errors.forbidden();
    const orgs = await activeOrganizations(db, actor.id, 'NGO');
    const verified = orgs.find((o) => o.verificationStatus === 'VERIFIED');
    if (verified) return verified;
    if (orgs[0]) return assertOrganizationVerified(db, orgs[0].id); // throws ORGANIZATION_NOT_VERIFIED
    throw new AppError(409, 'ORGANIZATION_REQUIRED', 'Create your organization profile first.');
  }

  return {
    clock,

    async create(actor: Actor, input: CreateListingInput) {
      if (actor.platformRole !== 'provider') throw errors.forbidden();
      const org = await currentOrganization(db, actor.id, 'PROVIDER');
      const now = clock();
      validateState(
        { ...input, latitude: input.latitude ?? null, longitude: input.longitude ?? null },
        now,
        'draft',
      );
      const [row] = await db
        .insert(foodListings)
        .values({
          ...input,
          providerOrgId: org.id,
          createdBy: actor.id,
          description: input.description ?? null,
          estimatedKg: input.estimatedKg ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          allergenNotes: input.allergenNotes ?? null,
        })
        .returning();
      return serializeListing(row!, now);
    },

    async listMine(actor: Actor, scope: 'active' | 'past' | 'all') {
      if (actor.platformRole !== 'provider') throw errors.forbidden();
      const org = await currentOrganization(db, actor.id, 'PROVIDER');
      const now = clock();
      const live = and(eq(foodListings.status, 'AVAILABLE'), gt(foodListings.pickupDeadline, now));
      // RESERVED listings (held by an active rescue) are still active work for the provider.
      const activeCond = or(inArray(foodListings.status, ['DRAFT', 'RESERVED']), live);
      const pastCond = or(
        inArray(foodListings.status, ['CANCELLED', 'EXPIRED', 'COLLECTED']),
        and(eq(foodListings.status, 'AVAILABLE'), lte(foodListings.pickupDeadline, now)),
      );
      const where = and(
        eq(foodListings.providerOrgId, org.id),
        scope === 'active' ? activeCond : scope === 'past' ? pastCond : undefined,
      );
      const rows = await db
        .select()
        .from(foodListings)
        .where(where)
        .orderBy(scope === 'past' ? desc(foodListings.updatedAt) : asc(foodListings.pickupDeadline))
        .limit(100);
      return rows.map((r) => serializeListing(r, now));
    },

    async get(actor: Actor, id: string) {
      const v = await viewer(actor, id);
      return v.kind === 'full'
        ? serializeListing(v.listing, v.now)
        : serializePublicListing(v.listing, v.providerName, v.now);
    },

    async update(actor: Actor, id: string, input: UpdateListingInput) {
      const updated = await db.transaction(async (tx) => {
        const listing = await loadForWrite(actor, id, tx, true);
        const now = clock();
        const status = effectiveStatus(listing, now);
        if (status === 'EXPIRED') throw new AppError(409, 'LISTING_EXPIRED', 'This listing has expired and can no longer be changed.');
        if (!isListingEditable(status)) {
          throw new AppError(409, 'LISTING_LOCKED', `A ${status.toLowerCase()} listing cannot be changed.`, { status });
        }
        const merged = { ...listing, ...input };
        validateState(
          merged,
          now,
          status === 'AVAILABLE' ? 'live-edit' : 'draft',
          input.pickupDeadline !== undefined && input.pickupDeadline.getTime() !== listing.pickupDeadline.getTime(),
        );
        const [row] = await tx
          .update(foodListings)
          .set({ ...input, updatedAt: now })
          .where(eq(foodListings.id, id))
          .returning();
        return serializeListing(row!, now);
      });
      // Only live listings have recommendations to refresh.
      if (updated.status === 'AVAILABLE') await hooks.listingChanged?.(id);
      return updated;
    },

    async publish(actor: Actor, id: string) {
      const published = await db.transaction(async (tx) => {
        const listing = await loadForWrite(actor, id, tx, true);
        const now = clock();
        if (nextListingStatus(listing.status, 'PUBLISH') === null) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', `A ${effectiveStatus(listing, now).toLowerCase()} listing cannot be published.`, {
            status: listing.status,
          });
        }
        await assertOrganizationVerified(db, listing.providerOrgId);
        validateState(listing, now, 'publish');
        const [row] = await tx
          .update(foodListings)
          .set({ status: 'AVAILABLE', publishedAt: now, declarationAcceptedAt: now, updatedAt: now })
          .where(eq(foodListings.id, id))
          .returning();
        await tx.insert(listingEvents).values({ listingId: id, action: 'PUBLISHED', actorUserId: actor.id });
        return serializeListing(row!, now);
      });
      await hooks.listingChanged?.(id);
      return published;
    },

    async cancel(actor: Actor, id: string, reason: string) {
      return db.transaction(async (tx) => {
        const listing = await loadForWrite(actor, id, tx, true);
        const now = clock();
        const status = effectiveStatus(listing, now);
        if (status === 'EXPIRED') throw new AppError(409, 'LISTING_EXPIRED', 'This listing has already expired.');
        if (status === 'RESERVED') {
          throw new AppError(409, 'RESCUE_ACTIVE', 'An NGO has accepted this listing. Cancel or decline the rescue from its rescue page instead.');
        }
        if (nextListingStatus(listing.status, 'CANCEL') === null) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', `A ${status.toLowerCase()} listing cannot be cancelled.`, { status });
        }
        const [row] = await tx
          .update(foodListings)
          .set({ status: 'CANCELLED', cancelledAt: now, cancellationReason: reason, updatedAt: now })
          .where(eq(foodListings.id, id))
          .returning();
        await tx.insert(listingEvents).values({ listingId: id, action: 'CANCELLED', actorUserId: actor.id, reason });
        return serializeListing(row!, now);
      });
    },

    /** Live listings for a verified NGO: AVAILABLE and not past deadline. No matching or ranking. */
    async feed(actor: Actor, query: { category?: FoodCategory; limit: number }) {
      await verifiedNgoOrganization(actor);
      const now = clock();
      const rows = await db
        .select({ listing: foodListings, providerName: organizations.name })
        .from(foodListings)
        .innerJoin(organizations, eq(organizations.id, foodListings.providerOrgId))
        .where(
          and(
            eq(foodListings.status, 'AVAILABLE'),
            gt(foodListings.pickupDeadline, now),
            eq(organizations.verificationStatus, 'VERIFIED'),
            query.category ? eq(foodListings.foodCategory, query.category) : undefined,
          ),
        )
        .orderBy(asc(foodListings.pickupDeadline), asc(foodListings.id))
        .limit(query.limit);
      return rows.map((r) => serializePublicListing(r.listing, r.providerName, now));
    },

    async history(actor: Actor, id: string) {
      const v = await viewer(actor, id);
      if (v.kind !== 'full') throw errors.notFound('Listing not found.');
      return db
        .select({ id: listingEvents.id, action: listingEvents.action, reason: listingEvents.reason, createdAt: listingEvents.createdAt })
        .from(listingEvents)
        .where(eq(listingEvents.listingId, id))
        .orderBy(desc(listingEvents.createdAt));
    },

    /** Call before reading an upload body so unauthorized callers cannot make us buffer files. */
    async assertCanManage(actor: Actor, id: string) {
      await loadForWrite(actor, id);
    },

    async setImage(actor: Actor, id: string, file: Express.Multer.File | undefined) {
      if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Attach an image in the "file" field.', { fields: { file: 'An image is required.' } });
      const name = safeDisplayFilename(file.originalname ?? '');
      if (!name) throw new AppError(400, 'INVALID_FILENAME', 'The file name is not allowed.', { fields: { file: 'Rename the file without path characters.' } });
      const format = sniffImage(file.buffer);
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      if (!format || !IMAGE_TYPES[format].names.includes(ext)) {
        throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Only PNG and JPEG images are accepted.', { fields: { file: 'Only PNG and JPEG images are accepted.' } });
      }
      const clean = stripImageMetadata(file.buffer, format);
      if (!clean) throw new AppError(400, 'UPLOAD_INVALID', 'The image file is damaged or malformed.', { fields: { file: 'The image file is damaged.' } });

      const listing = await loadForWrite(actor, id);
      const now = clock();
      const status = effectiveStatus(listing, now);
      if (!isListingEditable(status) || status === 'EXPIRED') throw new AppError(409, 'LISTING_LOCKED', `A ${status.toLowerCase()} listing cannot be changed.`);

      const key = await storage.save(`listing-${id}`, IMAGE_TYPES[format].extension, clean);
      try {
        await db
          .update(foodListings)
          .set({ imageKey: key, imageMime: IMAGE_TYPES[format].mime, updatedAt: now })
          .where(eq(foodListings.id, id));
      } catch (err) {
        await storage.remove(key).catch(() => undefined);
        throw err;
      }
      if (listing.imageKey) await storage.remove(listing.imageKey).catch(() => undefined);
      return { hasImage: true };
    },

    async removeImage(actor: Actor, id: string) {
      const listing = await loadForWrite(actor, id);
      const status = effectiveStatus(listing, clock());
      if (!isListingEditable(status) || status === 'EXPIRED') throw new AppError(409, 'LISTING_LOCKED', `A ${status.toLowerCase()} listing cannot be changed.`);
      await db.update(foodListings).set({ imageKey: null, imageMime: null, updatedAt: clock() }).where(eq(foodListings.id, id));
      if (listing.imageKey) await storage.remove(listing.imageKey).catch(() => undefined);
    },

    /** Same visibility rule as the listing itself: owners/admin always, verified NGOs while live. */
    async openImage(actor: Actor, id: string) {
      const v = await viewer(actor, id);
      if (!v.listing.imageKey || !v.listing.imageMime) throw errors.notFound('This listing has no image.');
      return { mime: v.listing.imageMime, stream: storage.open(v.listing.imageKey) };
    },
  };
}

export type ListingService = ReturnType<typeof createListingService>;
