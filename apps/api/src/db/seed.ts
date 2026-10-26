import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DEFAULT_STORAGE_DIR, loadMatchSettings } from '../config.js';
import { createMatchingService } from '../modules/matching/service.js';
import { LocalDiskStorage } from '../storage/index.js';
import { resolveAdminUrl } from './admin-url.js';
import { createDb, type Db } from './client.js';
import {
  foodListings,
  listingEvents,
  ngoRequirements,
  organizationMembers,
  rescueAssignments,
  rescueEvents,
  rescues,
  organizations,
  users,
  verificationDocuments,
  verificationEvents,
  volunteerProfiles,
  type PlatformRole,
  type VerificationStatus,
} from './schema.js';

interface DemoOrg {
  type: 'PROVIDER' | 'NGO';
  name: string;
  status: VerificationStatus;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  addressLine: string;
  city: string;
  latitude: number;
  longitude: number;
  /** Attach a sample registration certificate (needed for an application awaiting review). */
  withDocument?: boolean;
}

interface DemoAccount {
  role: PlatformRole;
  name: string;
  email: string;
  note?: string;
  organization?: DemoOrg;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    role: 'provider',
    name: 'Campus Canteen Manager',
    email: 'provider@demo.foodloop.test',
    note: 'verified organization',
    organization: {
      type: 'PROVIDER', name: 'Campus Canteen', status: 'VERIFIED',
      contactName: 'Campus Canteen Manager', contactEmail: 'canteen@demo.foodloop.test', contactPhone: '+91 20 5550 0101',
      addressLine: 'Main Campus, Food Court Block', city: 'Pune', latitude: 18.5204, longitude: 73.8567,
    },
  },
  {
    role: 'ngo',
    name: 'Hope Kitchen Coordinator',
    email: 'ngo@demo.foodloop.test',
    note: 'verified organization',
    organization: {
      type: 'NGO', name: 'Hope Community Kitchen', status: 'VERIFIED',
      contactName: 'Hope Kitchen Coordinator', contactEmail: 'hope@demo.foodloop.test', contactPhone: '+91 20 5550 0202',
      addressLine: '4 Station Road', city: 'Pune', latitude: 18.5314, longitude: 73.8446,
    },
  },
  { role: 'runner', name: 'Aarav (Rescue Runner)', email: 'runner@demo.foodloop.test', note: 'available, bicycle, 25 kg: eligible for the demo listing' },
  { role: 'runner', name: 'Meera (Rescue Runner)', email: 'runner2@demo.foodloop.test', note: 'available, scooter, only 2 kg: too small for the demo listing' },
  { role: 'admin', name: 'FoodLoop Operations', email: 'admin@demo.foodloop.test' },
  {
    role: 'ngo',
    name: 'Helping Hands Coordinator',
    email: 'ngo3@demo.foodloop.test',
    note: 'verified, about 6 km away: ranks below Hope Community Kitchen',
    organization: {
      type: 'NGO', name: 'Helping Hands Trust', status: 'VERIFIED',
      contactName: 'Helping Hands Coordinator', contactEmail: 'hands@demo.foodloop.test', contactPhone: '+91 20 5550 0505',
      addressLine: '88 East Avenue', city: 'Pune', latitude: 18.5204, longitude: 73.9167,
    },
  },
  // Extra applicants for the Phase 2 verification demo (see README).
  {
    role: 'provider',
    name: 'Riverside Bakery Owner',
    email: 'provider2@demo.foodloop.test',
    note: 'application UNDER_REVIEW, waiting for the admin',
    organization: {
      type: 'PROVIDER', name: 'Riverside Bakery', status: 'UNDER_REVIEW', withDocument: true,
      contactName: 'Riverside Bakery Owner', contactEmail: 'bakery@demo.foodloop.test', contactPhone: '+91 20 5550 0303',
      addressLine: '21 River Lane', city: 'Pune', latitude: 18.5089, longitude: 73.8553,
    },
  },
  {
    role: 'ngo',
    name: 'Care Foundation Lead',
    email: 'ngo2@demo.foodloop.test',
    note: 'draft application: add a certificate and submit it yourself',
    organization: {
      type: 'NGO', name: 'Care Foundation', status: 'UNSUBMITTED',
      contactName: 'Care Foundation Lead', contactEmail: 'care@demo.foodloop.test', contactPhone: '+91 20 5550 0404',
      addressLine: '9 Hill View', city: 'Pune', latitude: 18.5362, longitude: 73.8938,
    },
  },
];

/** A minimal, valid single-page PDF used as the demo registration certificate. */
const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function ensureOrganization(
  db: Db,
  storage: LocalDiskStorage,
  userId: string,
  adminId: string,
  org: DemoOrg,
) {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizations.type, org.type)))
    .limit(1);

  let orgId = existing?.id;
  if (!orgId) {
    const [row] = await db
      .insert(organizations)
      .values({ ...org, verificationStatus: org.status, submissionCount: org.status === 'UNSUBMITTED' ? 0 : 1, submittedAt: org.status === 'UNSUBMITTED' ? null : new Date() })
      .returning({ id: organizations.id });
    orgId = row!.id;
    await db.insert(organizationMembers).values({ userId, organizationId: orgId, memberRole: 'owner' });
  } else {
    // Backfill details on orgs created by an earlier phase, without touching anything already set
    // and without overriding progress made during a demo.
    await db
      .update(organizations)
      .set({
        contactName: sql`coalesce(${organizations.contactName}, ${org.contactName})`,
        contactEmail: sql`coalesce(${organizations.contactEmail}, ${org.contactEmail})`,
        contactPhone: sql`coalesce(${organizations.contactPhone}, ${org.contactPhone})`,
        addressLine: sql`coalesce(${organizations.addressLine}, ${org.addressLine})`,
        city: sql`coalesce(${organizations.city}, ${org.city})`,
        latitude: sql`coalesce(${organizations.latitude}, ${org.latitude})`,
        longitude: sql`coalesce(${organizations.longitude}, ${org.longitude})`,
      })
      .where(eq(organizations.id, orgId));
  }

  const [current] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (current!.verificationStatus === 'UNSUBMITTED') return;

  // Records the submission/approval history for seeded applications that are past draft.
  const [hasEvents] = await db.select({ n: sql<number>`count(*)::int` }).from(verificationEvents).where(eq(verificationEvents.organizationId, orgId));
  if (hasEvents!.n === 0) {
    await db.insert(verificationEvents).values({
      organizationId: orgId, action: 'SUBMITTED', fromStatus: 'UNSUBMITTED', toStatus: 'UNDER_REVIEW', actorUserId: userId, submissionNumber: 1,
    });
    if (current!.verificationStatus === 'VERIFIED') {
      await db.insert(verificationEvents).values({
        organizationId: orgId, action: 'APPROVED', fromStatus: 'UNDER_REVIEW', toStatus: 'VERIFIED', actorUserId: adminId, submissionNumber: 1,
      });
    }
  }

  const [hasDocs] = await db.select({ n: sql<number>`count(*)::int` }).from(verificationDocuments).where(eq(verificationDocuments.organizationId, orgId));
  if (hasDocs!.n === 0 && (org.withDocument || current!.verificationStatus === 'VERIFIED')) {
    const key = await storage.save(`org-${orgId}`, 'pdf', SAMPLE_PDF);
    await db.insert(verificationDocuments).values({
      organizationId: orgId,
      documentType: 'REGISTRATION_CERTIFICATE',
      originalFilename: 'demo-registration-certificate.pdf',
      mimeType: 'application/pdf',
      sizeBytes: SAMPLE_PDF.length,
      sha256: createHash('sha256').update(SAMPLE_PDF).digest('hex'),
      storageKey: key,
      reviewStatus: current!.verificationStatus === 'VERIFIED' ? 'ACCEPTED' : 'PENDING',
      uploadedBy: userId,
    });
  }
}

const HOUR = 3_600_000;

async function orgIdOf(db: Db, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .limit(1);
  return row?.id;
}

/**
 * Phase 3 demo data. Every record is identified by title (listings) or organization (requirement)
 * so re-running never duplicates or overwrites progress. The live listing is re-created only after
 * the previous one has expired or been cancelled; an NGO window that has ended is extended.
 */
async function ensureSupplyAndDemand(db: Db, providerUserId: string, ngoUserId: string) {
  const providerOrg = await orgIdOf(db, providerUserId);
  const ngoOrg = await orgIdOf(db, ngoUserId);
  const now = Date.now();
  const at = (offsetMs: number) => new Date(now + offsetMs);

  if (providerOrg) {
    const base = {
      providerOrgId: providerOrg,
      createdBy: providerUserId,
      addressLine: 'Main Campus, Food Court Block',
      city: 'Pune',
      latitude: 18.5204,
      longitude: 73.8567,
      transportRequired: true,
    } as const;
    const has = async (title: string, liveOnly = false) => {
      const [row] = await db
        .select({ id: foodListings.id })
        .from(foodListings)
        .where(
          and(
            eq(foodListings.providerOrgId, providerOrg),
            eq(foodListings.title, title),
            liveOnly ? and(eq(foodListings.status, 'AVAILABLE'), gt(foodListings.pickupDeadline, new Date())) : undefined,
          ),
        )
        .limit(1);
      return !!row;
    };
    const events = (listingId: string, items: { action: 'PUBLISHED' | 'CANCELLED' | 'EXPIRED'; actor: string | null; reason?: string }[]) =>
      db.insert(listingEvents).values(items.map((e) => ({ listingId, action: e.action, actorUserId: e.actor, reason: e.reason ?? null })));

    if (!(await has('Vegetable Biryani (demo)', true))) {
      const [l] = await db
        .insert(foodListings)
        .values({
          ...base,
          title: 'Vegetable Biryani (demo)',
          description: 'Freshly cooked vegetable biryani, packed in individual boxes.',
          foodCategory: 'COOKED_MEALS',
          servings: 45,
          estimatedKg: 18,
          preparedAt: at(-0.5 * HOUR),
          pickupStart: at(-0.1 * HOUR),
          pickupDeadline: at(8 * HOUR),
          packaging: 'INDIVIDUAL_BOXES',
          dietaryTags: ['VEGETARIAN'],
          allergenNotes: 'Contains dairy.',
          status: 'AVAILABLE',
          publishedAt: new Date(),
          declarationAcceptedAt: new Date(),
        })
        .returning({ id: foodListings.id });
      await events(l!.id, [{ action: 'PUBLISHED', actor: providerUserId }]);
    }
    if (!(await has('Seasonal Fruit Boxes (demo draft)'))) {
      await db.insert(foodListings).values({
        ...base,
        title: 'Seasonal Fruit Boxes (demo draft)',
        foodCategory: 'PRODUCE',
        servings: 30,
        preparedAt: at(-2 * HOUR),
        pickupStart: at(HOUR),
        pickupDeadline: at(6 * HOUR),
        packaging: 'BULK_CONTAINERS',
        dietaryTags: ['VEGAN'],
        transportRequired: false,
      });
    }
    if (!(await has('Day-old Sandwiches (demo expired)'))) {
      const [l] = await db
        .insert(foodListings)
        .values({
          ...base,
          title: 'Day-old Sandwiches (demo expired)',
          foodCategory: 'BAKERY',
          servings: 25,
          preparedAt: at(-9 * HOUR),
          pickupStart: at(-6 * HOUR),
          pickupDeadline: at(-3 * HOUR),
          packaging: 'WRAPPED',
          dietaryTags: ['VEGETARIAN'],
          status: 'EXPIRED',
          publishedAt: at(-8 * HOUR),
          declarationAcceptedAt: at(-8 * HOUR),
          expiredAt: at(-3 * HOUR),
        })
        .returning({ id: foodListings.id });
      await events(l!.id, [{ action: 'PUBLISHED', actor: providerUserId }, { action: 'EXPIRED', actor: null }]);
    }
    if (!(await has('Leftover Soup (demo cancelled)'))) {
      const [l] = await db
        .insert(foodListings)
        .values({
          ...base,
          title: 'Leftover Soup (demo cancelled)',
          foodCategory: 'COOKED_MEALS',
          servings: 20,
          preparedAt: at(-3 * HOUR),
          pickupStart: at(-1 * HOUR),
          pickupDeadline: at(2 * HOUR),
          packaging: 'BULK_CONTAINERS',
          status: 'CANCELLED',
          publishedAt: at(-2 * HOUR),
          declarationAcceptedAt: at(-2 * HOUR),
          cancelledAt: at(-1 * HOUR),
          cancellationReason: 'Kitchen closed early; food no longer available.',
        })
        .returning({ id: foodListings.id });
      await events(l!.id, [
        { action: 'PUBLISHED', actor: providerUserId },
        { action: 'CANCELLED', actor: providerUserId, reason: 'Kitchen closed early; food no longer available.' },
      ]);
    }
  }

  if (ngoOrg) {
    const [existing] = await db.select().from(ngoRequirements).where(eq(ngoRequirements.ngoOrgId, ngoOrg)).limit(1);
    if (!existing) {
      await db.insert(ngoRequirements).values({
        ngoOrgId: ngoOrg,
        foodCategories: ['COOKED_MEALS', 'BAKERY'],
        neededServings: 40,
        capacityServings: 60,
        serviceRadiusKm: 5,
        availableFrom: at(-HOUR),
        availableTo: at(30 * 24 * HOUR),
        intakeEnabled: true,
        updatedBy: ngoUserId,
      });
    } else if (existing.availableTo.getTime() <= now) {
      // Only the lapsed window is refreshed; intake state and quantities are left as the user set them.
      await db
        .update(ngoRequirements)
        .set({ availableFrom: at(-HOUR), availableTo: at(30 * 24 * HOUR), updatedAt: new Date() })
        .where(eq(ngoRequirements.id, existing.id));
    }
  }
}

/** A demo requirement for an NGO user; created once, and a lapsed window is refreshed (nothing else is overwritten). */
async function ensureRequirement(
  db: Db,
  userId: string,
  values: { foodCategories: ('COOKED_MEALS' | 'BAKERY' | 'PRODUCE')[]; neededServings: number; capacityServings: number; serviceRadiusKm: number },
) {
  const orgId = await orgIdOf(db, userId);
  if (!orgId) return;
  const now = Date.now();
  const [existing] = await db.select().from(ngoRequirements).where(eq(ngoRequirements.ngoOrgId, orgId)).limit(1);
  if (!existing) {
    await db.insert(ngoRequirements).values({
      ngoOrgId: orgId,
      ...values,
      availableFrom: new Date(now - HOUR),
      availableTo: new Date(now + 30 * 24 * HOUR),
      intakeEnabled: true,
      updatedBy: userId,
    });
  } else if (existing.availableTo.getTime() <= now) {
    await db
      .update(ngoRequirements)
      .set({ availableFrom: new Date(now - HOUR), availableTo: new Date(now + 30 * 24 * HOUR), updatedAt: new Date() })
      .where(eq(ngoRequirements.id, existing.id));
  }
}

/**
 * A finished rescue so history views are not empty on first sign-in. Created once (matched by listing
 * title); never touched again, and it never affects matching (reliability stays neutral until the
 * reliability model is built).
 */
async function ensureCompletedRescue(db: Db, providerUserId: string, ngoUserId: string) {
  const providerOrg = await orgIdOf(db, providerUserId);
  const ngoOrg = await orgIdOf(db, ngoUserId);
  if (!providerOrg || !ngoOrg) return;
  const title = 'Lunch Boxes (demo completed rescue)';
  const [existing] = await db
    .select({ id: foodListings.id })
    .from(foodListings)
    .where(and(eq(foodListings.providerOrgId, providerOrg), eq(foodListings.title, title)))
    .limit(1);
  if (existing) return;
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
  const [listing] = await db
    .insert(foodListings)
    .values({
      providerOrgId: providerOrg,
      createdBy: providerUserId,
      title,
      foodCategory: 'COOKED_MEALS',
      servings: 30,
      preparedAt: at(-30 * HOUR),
      pickupStart: at(-28 * HOUR),
      pickupDeadline: at(-25 * HOUR),
      addressLine: 'Main Campus, Food Court Block',
      city: 'Pune',
      latitude: 18.5204,
      longitude: 73.8567,
      packaging: 'INDIVIDUAL_BOXES',
      dietaryTags: ['VEGETARIAN'],
      transportRequired: false,
      status: 'COLLECTED',
      publishedAt: at(-30 * HOUR),
      declarationAcceptedAt: at(-30 * HOUR),
    })
    .returning({ id: foodListings.id });
  const [rescue] = await db
    .insert(rescues)
    .values({
      listingId: listing!.id,
      providerOrgId: providerOrg,
      ngoOrgId: ngoOrg,
      acceptedBy: ngoUserId,
      status: 'COMPLETED',
      version: 5,
      servingsOffered: 30,
      reservedAt: at(-29 * HOUR),
      providerConfirmBy: at(-28.75 * HOUR),
      providerConfirmedAt: at(-28.9 * HOUR),
      pickupBy: at(-24.5 * HOUR),
      pickedUpAt: at(-27 * HOUR),
      collectedServings: 30,
      deliveryConfirmBy: at(-15 * HOUR),
      deliveredServings: 29,
      recipientConfirmedAt: at(-26 * HOUR),
      completedAt: at(-26 * HOUR),
      closedAt: at(-26 * HOUR),
      outcomeCode: 'COMPLETED',
    })
    .returning({ id: rescues.id });
  const steps: [string, 'RESERVED' | 'PICKUP_ASSIGNED' | 'PICKUP_CONFIRMED' | 'RECIPIENT_CONFIRMED' | 'COMPLETED', string | null, string][] = [
    ['ACCEPTED', 'RESERVED', ngoUserId, 'ngo'],
    ['STATUS_CHANGED', 'PICKUP_ASSIGNED', providerUserId, 'provider'],
    ['STATUS_CHANGED', 'PICKUP_CONFIRMED', ngoUserId, 'ngo'],
    ['STATUS_CHANGED', 'RECIPIENT_CONFIRMED', ngoUserId, 'ngo'],
    ['STATUS_CHANGED', 'COMPLETED', null, 'system'],
  ];
  let prev: 'RESERVED' | 'PICKUP_ASSIGNED' | 'PICKUP_CONFIRMED' | 'RECIPIENT_CONFIRMED' | 'COMPLETED' | null = null;
  for (const [i, [eventType, to, actor, role]] of steps.entries()) {
    await db.insert(rescueEvents).values({
      rescueId: rescue!.id,
      eventType,
      fromStatus: prev,
      toStatus: to,
      actorUserId: actor,
      actorRole: role,
      metadata: {},
      createdAt: at((-29 + i * 0.6) * HOUR),
    });
    prev = to;
  }
}

/**
 * Phase 8 demo data: one finished RUNNER-assisted rescue (provider@ -> ngo@, carried by runner@), so the runner's and the
 * platform's impact pages have something real to show. Offered 24, collected 24, delivered 22. Created once, keyed by its
 * listing title; an existing one (or anything the demo has done since) is never touched.
 */
async function ensureCompletedRunnerRescue(db: Db, providerUserId: string, ngoUserId: string, runnerUserId: string) {
  const providerOrg = await orgIdOf(db, providerUserId);
  const ngoOrg = await orgIdOf(db, ngoUserId);
  if (!providerOrg || !ngoOrg) return;
  const title = 'Veg Pulao Trays (demo runner rescue)';
  const [existing] = await db
    .select({ id: foodListings.id })
    .from(foodListings)
    .where(and(eq(foodListings.providerOrgId, providerOrg), eq(foodListings.title, title)))
    .limit(1);
  if (existing) return;
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
  const [listing] = await db
    .insert(foodListings)
    .values({
      providerOrgId: providerOrg,
      createdBy: providerUserId,
      title,
      foodCategory: 'COOKED_MEALS',
      servings: 24,
      estimatedKg: 9,
      preparedAt: at(-52 * HOUR),
      pickupStart: at(-50 * HOUR),
      pickupDeadline: at(-46 * HOUR),
      addressLine: 'Main Campus, Food Court Block',
      city: 'Pune',
      latitude: 18.5204,
      longitude: 73.8567,
      packaging: 'INDIVIDUAL_BOXES',
      dietaryTags: ['VEGETARIAN'],
      transportRequired: true,
      status: 'COLLECTED',
      publishedAt: at(-52 * HOUR),
      declarationAcceptedAt: at(-52 * HOUR),
    })
    .returning({ id: foodListings.id });
  const done = at(-47 * HOUR);
  const [rescue] = await db
    .insert(rescues)
    .values({
      listingId: listing!.id,
      providerOrgId: providerOrg,
      ngoOrgId: ngoOrg,
      acceptedBy: ngoUserId,
      status: 'COMPLETED',
      version: 8,
      transportMode: 'RUNNER',
      servingsOffered: 24,
      reservedAt: at(-51 * HOUR),
      providerConfirmBy: at(-50.75 * HOUR),
      providerConfirmedAt: at(-50.9 * HOUR),
      runnerBy: at(-50.4 * HOUR),
      pickupBy: at(-46 * HOUR),
      pickedUpAt: at(-48.5 * HOUR),
      collectedServings: 24,
      transitStartedAt: at(-48.5 * HOUR),
      handedOverAt: at(-47.4 * HOUR),
      deliveryConfirmBy: at(-35 * HOUR),
      deliveredServings: 22,
      recipientConfirmedAt: done,
      completedAt: done,
      closedAt: done,
      outcomeCode: 'COMPLETED',
    })
    .returning({ id: rescues.id });
  await db.insert(rescueAssignments).values({
    rescueId: rescue!.id,
    runnerUserId,
    status: 'COMPLETED',
    acceptedAt: at(-50 * HOUR),
    endedAt: at(-47.4 * HOUR),
  });
  type S = 'RESERVED' | 'AWAITING_RUNNER' | 'PICKUP_ASSIGNED' | 'PICKUP_CONFIRMED' | 'IN_TRANSIT' | 'DELIVERED' | 'RECIPIENT_CONFIRMED' | 'COMPLETED';
  const steps: [string, S, string | null, string][] = [
    ['ACCEPTED', 'RESERVED', ngoUserId, 'ngo'],
    ['STATUS_CHANGED', 'AWAITING_RUNNER', providerUserId, 'provider'],
    ['STATUS_CHANGED', 'PICKUP_ASSIGNED', runnerUserId, 'runner'],
    ['STATUS_CHANGED', 'PICKUP_CONFIRMED', runnerUserId, 'runner'],
    ['STATUS_CHANGED', 'IN_TRANSIT', null, 'system'],
    ['STATUS_CHANGED', 'DELIVERED', runnerUserId, 'runner'],
    ['STATUS_CHANGED', 'RECIPIENT_CONFIRMED', ngoUserId, 'ngo'],
    ['STATUS_CHANGED', 'COMPLETED', null, 'system'],
  ];
  let prev: S | null = null;
  for (const [i, [eventType, to, actor, role]] of steps.entries()) {
    await db.insert(rescueEvents).values({
      rescueId: rescue!.id,
      eventType,
      fromStatus: prev,
      toStatus: to,
      actorUserId: actor,
      actorRole: role,
      metadata: {},
      createdAt: at((-51 + i * 0.5) * HOUR),
    });
    prev = to;
  }
}

/**
 * Phase 6 demo runner profiles. Filled in only while a profile is still empty (vehicle not set), so a runner's own
 * later changes are never overwritten. Base positions are deliberately coarse (2 decimals, about 1 km).
 */
async function ensureRunnerProfile(
  db: Db,
  userId: string,
  p: { vehicleType: 'BICYCLE' | 'SCOOTER'; capacityKg: number; radiusKm: number; latitude: number; longitude: number },
) {
  const [existing] = await db.select({ vehicleType: volunteerProfiles.vehicleType }).from(volunteerProfiles).where(eq(volunteerProfiles.userId, userId));
  if (existing && existing.vehicleType !== null) return;
  await db
    .insert(volunteerProfiles)
    .values({ userId, availabilityStatus: 'AVAILABLE', ...p })
    .onConflictDoUpdate({ target: volunteerProfiles.userId, set: { availabilityStatus: 'AVAILABLE', ...p, updatedAt: new Date() } });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo accounts when NODE_ENV=production.');
  }
  // Seeding is privileged (it writes audit history directly): never the runtime connection.
  const url = resolveAdminUrl();
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Set DEMO_PASSWORD in .env (min 10 characters, with a letter and a number). No default is provided.');
  }

  const cost = Number(process.env.BCRYPT_COST ?? 12);
  const passwordHash = await bcrypt.hash(password, cost);
  const storage = new LocalDiskStorage(process.env.STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
  const { db, pool } = createDb(url);
  try {
    const ids = new Map<string, string>();
    for (const account of DEMO_ACCOUNTS) {
      const userId = await db.transaction(async (tx) => {
        const [existing] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${account.email}`);
        let id = existing?.id;
        if (id) {
          // Re-seeding re-syncs the password so changing DEMO_PASSWORD takes effect.
          await tx.update(users).set({ passwordHash, platformRole: account.role, status: 'ACTIVE', updatedAt: new Date() }).where(eq(users.id, id));
        } else {
          const [row] = await tx
            .insert(users)
            .values({ name: account.name, email: account.email, passwordHash, platformRole: account.role })
            .returning({ id: users.id });
          id = row!.id;
        }
        if (account.role === 'runner') await tx.insert(volunteerProfiles).values({ userId: id }).onConflictDoNothing();
        return id;
      });
      ids.set(account.email, userId);
    }

    const adminId = ids.get('admin@demo.foodloop.test')!;
    for (const account of DEMO_ACCOUNTS) {
      if (account.organization) await ensureOrganization(db, storage, ids.get(account.email)!, adminId, account.organization);
    }

    await ensureSupplyAndDemand(db, ids.get('provider@demo.foodloop.test')!, ids.get('ngo@demo.foodloop.test')!);
    await ensureRequirement(db, ids.get('ngo3@demo.foodloop.test')!, { foodCategories: ['COOKED_MEALS', 'PRODUCE'], neededServings: 50, capacityServings: 100, serviceRadiusKm: 8 });
    await ensureRunnerProfile(db, ids.get('runner@demo.foodloop.test')!, { vehicleType: 'BICYCLE', capacityKg: 25, radiusKm: 8, latitude: 18.52, longitude: 73.84 });
    await ensureRunnerProfile(db, ids.get('runner2@demo.foodloop.test')!, { vehicleType: 'SCOOTER', capacityKg: 2, radiusKm: 6, latitude: 18.53, longitude: 73.88 });
    await ensureCompletedRescue(db, ids.get('provider@demo.foodloop.test')!, ids.get('ngo@demo.foodloop.test')!);
    await ensureCompletedRunnerRescue(db, ids.get('provider@demo.foodloop.test')!, ids.get('ngo@demo.foodloop.test')!, ids.get('runner@demo.foodloop.test')!);
    // Phase 4: compute recommendations for the live demo listing (idempotent; needs PostGIS).
    const matched = await createMatchingService(db, loadMatchSettings()).recomputeAllLive();

    console.log(`Seeded ${DEMO_ACCOUNTS.length} demo accounts:`);
    for (const a of DEMO_ACCOUNTS) console.log(`  ${a.role.padEnd(8)} ${a.email.padEnd(32)} ${a.note ?? ''}`);
    console.log(`Matching: recommendations recomputed for ${matched} live listing(s).`);
    console.log('Rescues: provider@/ngo@ share two completed demo rescues (one direct pickup: 29 delivered; one carried by runner@: 22 delivered), so every impact page has data; accept the live listing as ngo@ to start another.');
    console.log('Demo listings: provider@ has 1 live listing, a draft, an expired and a cancelled one; ngo@ has an active requirement.');
    console.log('Password: the value of DEMO_PASSWORD in your .env');
  } finally {
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
