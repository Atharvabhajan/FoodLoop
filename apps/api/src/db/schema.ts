import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const ROLES = ['provider', 'ngo', 'runner', 'admin'] as const;
export type PlatformRole = (typeof ROLES)[number];

export const platformRole = pgEnum('platform_role', ROLES);
export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED']);
export const organizationType = pgEnum('organization_type', ['PROVIDER', 'NGO']);
export const verificationStatus = pgEnum('verification_status', [
  'UNSUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'RESUBMISSION_REQUESTED',
]);
export const DOCUMENT_TYPES = [
  'REGISTRATION_CERTIFICATE',
  'FOOD_SAFETY_LICENSE',
  'ID_PROOF',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const documentType = pgEnum('document_type', DOCUMENT_TYPES);
export const documentReviewStatus = pgEnum('document_review_status', ['PENDING', 'ACCEPTED', 'REJECTED']);
export const verificationAction = pgEnum('verification_action', [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'RESUBMISSION_REQUESTED',
]);
export const FOOD_CATEGORIES = [
  'COOKED_MEALS',
  'BAKERY',
  'PRODUCE',
  'PACKAGED_FOOD',
  'DAIRY',
  'BEVERAGES',
  'OTHER',
] as const;
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];
export const foodCategory = pgEnum('food_category', FOOD_CATEGORIES);

export const PACKAGING_TYPES = ['INDIVIDUAL_BOXES', 'BULK_CONTAINERS', 'WRAPPED', 'LOOSE', 'OTHER'] as const;
export type PackagingType = (typeof PACKAGING_TYPES)[number];
export const packagingType = pgEnum('packaging_type', PACKAGING_TYPES);

// RESERVED: an active rescue holds the listing. COLLECTED: the food has left the provider (Phase 5).
export const LISTING_STATUSES = ['DRAFT', 'AVAILABLE', 'CANCELLED', 'EXPIRED', 'RESERVED', 'COLLECTED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export const listingStatus = pgEnum('listing_status', LISTING_STATUSES);
export const listingEventAction = pgEnum('listing_event_action', ['PUBLISHED', 'CANCELLED', 'EXPIRED']);

export type VerificationStatus = (typeof verificationStatus.enumValues)[number];

export const memberRole = pgEnum('member_role', ['owner', 'manager', 'operator']);
export const memberStatus = pgEnum('member_status', ['ACTIVE', 'INVITED', 'REMOVED']);
export const VEHICLE_TYPES = ['FOOT', 'BICYCLE', 'SCOOTER', 'CAR', 'VAN'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const vehicleType = pgEnum('vehicle_type', VEHICLE_TYPES);
export const availabilityStatus = pgEnum('availability_status', ['OFFLINE', 'AVAILABLE', 'BUSY']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    platformRole: platformRole('platform_role').notNull(),
    status: userStatus('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`)],
);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: organizationType('type').notNull(),
    name: text('name').notNull(),
    verificationStatus: verificationStatus('verification_status').notNull().default('UNSUBMITTED'),
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    addressLine: text('address_line'),
    city: text('city'),
    // Plain coordinates. Spatial queries need a later PostGIS migration (geometry column + GiST index).
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    /** Incremented on each submission; lets an admin decision be tied to the exact submission reviewed. */
    submissionCount: integer('submission_count').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Reason given in the most recent rejection / resubmission request. */
    statusReason: text('status_reason'),
    ...timestamps,
  },
  (t) => [
    check('organizations_latitude_range', sql`${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90`),
    check('organizations_longitude_range', sql`${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180`),
    check('organizations_coordinates_pair', sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`),
    index('organizations_status_idx').on(t.verificationStatus),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberRole: memberRole('member_role').notNull().default('owner'),
    status: memberStatus('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('organization_members_user_org_key').on(t.userId, t.organizationId),
    index('organization_members_org_idx').on(t.organizationId),
  ],
);

/**
 * Runner operating profile (spec 4.1). latitude/longitude are a deliberately COARSE base position
 * (rounded to 2 decimals, about 1 km) used only for eligibility; live position is a separate, short-lived
 * record (rescue_locations). `geog` is maintained by a SQL trigger and is not modelled here.
 */
export const volunteerProfiles = pgTable(
  'volunteer_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    availabilityStatus: availabilityStatus('availability_status').notNull().default('OFFLINE'),
    vehicleType: vehicleType('vehicle_type'),
    capacityKg: doublePrecision('capacity_kg'),
    radiusKm: doublePrecision('radius_km'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    ...timestamps,
  },
  (t) => [
    check('volunteer_capacity_positive', sql`${t.capacityKg} IS NULL OR (${t.capacityKg} > 0 AND ${t.capacityKg} <= 1000)`),
    check('volunteer_radius_range', sql`${t.radiusKm} IS NULL OR (${t.radiusKm} > 0 AND ${t.radiusKm} <= 100)`),
    check('volunteer_latitude_range', sql`${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90`),
    check('volunteer_longitude_range', sql`${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180`),
    check('volunteer_coordinates_pair', sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_refresh_hash_key').on(t.refreshTokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const verificationDocuments = pgTable(
  'verification_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentType: documentType('document_type').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** Server-generated key understood only by the storage service. Never sent to clients. */
    storageKey: text('storage_key').notNull(),
    reviewStatus: documentReviewStatus('review_status').notNull().default('PENDING'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('verification_documents_storage_key_key').on(t.storageKey),
    index('verification_documents_org_idx').on(t.organizationId),
    check('verification_documents_size_positive', sql`${t.sizeBytes} > 0`),
  ],
);

/** Append-only (a database trigger rejects UPDATE and DELETE). */
export const verificationEvents = pgTable(
  'verification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    action: verificationAction('action').notNull(),
    fromStatus: verificationStatus('from_status').notNull(),
    toStatus: verificationStatus('to_status').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    submissionNumber: integer('submission_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_events_org_idx').on(t.organizationId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type VerificationDocument = typeof verificationDocuments.$inferSelect;

export const foodListings = pgTable(
  'food_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerOrgId: uuid('provider_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    foodCategory: foodCategory('food_category').notNull(),
    servings: integer('servings').notNull(),
    estimatedKg: doublePrecision('estimated_kg'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull(),
    pickupStart: timestamp('pickup_start', { withTimezone: true }).notNull(),
    pickupDeadline: timestamp('pickup_deadline', { withTimezone: true }).notNull(),
    // Exact pickup location: private to the provider (and admins) until a later rescue workflow.
    addressLine: text('address_line').notNull(),
    city: text('city').notNull(),
    // Plain coordinates; spatial queries need a later PostGIS migration.
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    packaging: packagingType('packaging').notNull(),
    dietaryTags: text('dietary_tags').array().notNull().default(sql`'{}'::text[]`),
    allergenNotes: text('allergen_notes'),
    transportRequired: boolean('transport_required').notNull(),
    /** Server-side file key for the optional food photo; never sent to clients. */
    imageKey: text('image_key'),
    imageMime: text('image_mime'),
    status: listingStatus('status').notNull().default('DRAFT'),
    /** When the provider confirmed the food-safety declaration (set at publish). */
    declarationAcceptedAt: timestamp('declaration_accepted_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    check('food_listings_servings_positive', sql`${t.servings} > 0`),
    check('food_listings_kg_positive', sql`${t.estimatedKg} IS NULL OR ${t.estimatedKg} > 0`),
    check('food_listings_window_valid', sql`${t.pickupStart} < ${t.pickupDeadline}`),
    check('food_listings_prepared_before_deadline', sql`${t.preparedAt} <= ${t.pickupDeadline}`),
    check('food_listings_latitude_range', sql`${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90`),
    check('food_listings_longitude_range', sql`${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180`),
    check('food_listings_coordinates_pair', sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`),
    check('food_listings_cancel_reason', sql`${t.status} <> 'CANCELLED' OR ${t.cancellationReason} IS NOT NULL`),
    check('food_listings_published', sql`${t.status} = 'DRAFT' OR ${t.publishedAt} IS NOT NULL OR ${t.status} = 'CANCELLED'`),
    index('food_listings_status_deadline_idx').on(t.status, t.pickupDeadline),
    index('food_listings_provider_idx').on(t.providerOrgId, t.createdAt),
  ],
);

/** Append-only (a database trigger rejects UPDATE and DELETE). actor is null for system expiry. */
export const listingEvents = pgTable(
  'listing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => foodListings.id, { onDelete: 'restrict' }),
    action: listingEventAction('action').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('listing_events_listing_idx').on(t.listingId, t.createdAt)],
);

/** V1 keeps exactly one current requirement per NGO organization (unique ngo_org_id). */
export const ngoRequirements = pgTable(
  'ngo_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ngoOrgId: uuid('ngo_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    foodCategories: foodCategory('food_categories').array().notNull(),
    neededServings: integer('needed_servings').notNull(),
    capacityServings: integer('capacity_servings').notNull(),
    /** Stored for the later matching phase; no spatial logic uses it yet. */
    serviceRadiusKm: doublePrecision('service_radius_km').notNull(),
    availableFrom: timestamp('available_from', { withTimezone: true }).notNull(),
    availableTo: timestamp('available_to', { withTimezone: true }).notNull(),
    /** Dietary tags a listing MUST have (e.g. HALAL) / MUST NOT have (e.g. CONTAINS_NUTS) to be matched. */
    dietaryMustHave: text('dietary_must_have').array().notNull().default(sql`'{}'::text[]`),
    dietaryMustAvoid: text('dietary_must_avoid').array().notNull().default(sql`'{}'::text[]`),
    intakeEnabled: boolean('intake_enabled').notNull().default(true),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ngo_requirements_org_key').on(t.ngoOrgId),
    check('ngo_requirements_categories_nonempty', sql`cardinality(${t.foodCategories}) >= 1`),
    check('ngo_requirements_needed_positive', sql`${t.neededServings} > 0`),
    check('ngo_requirements_capacity_covers_need', sql`${t.capacityServings} >= ${t.neededServings}`),
    check('ngo_requirements_radius_range', sql`${t.serviceRadiusKm} > 0 AND ${t.serviceRadiusKm} <= 100`),
    check('ngo_requirements_window_valid', sql`${t.availableFrom} < ${t.availableTo}`),
  ],
);

export type FoodListing = typeof foodListings.$inferSelect;
export type NgoRequirement = typeof ngoRequirements.$inferSelect;

/**
 * Recommendation record per (listing, NGO). Recommendations only: nothing here reserves or accepts a
 * listing. Ineligible NGOs are stored with their failure reasons so exclusions are explainable.
 * Recomputation upserts on (listing_id, ngo_org_id), so retries never create duplicates.
 *
 * Note: the PostGIS `geog` columns on organizations and food_listings are maintained by SQL
 * (migration + trigger) and are intentionally not modelled in this file.
 */
export const matchCandidates = pgTable(
  'match_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => foodListings.id, { onDelete: 'cascade' }),
    ngoOrgId: uuid('ngo_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eligible: boolean('eligible').notNull(),
    score: doublePrecision('score'),
    rank: integer('rank'),
    distanceM: doublePrecision('distance_m'),
    estimatedTravelMinutes: integer('estimated_travel_minutes'),
    marginMinutes: integer('margin_minutes'),
    breakdown: jsonb('breakdown'),
    reasons: jsonb('reasons').notNull().default(sql`'[]'::jsonb`),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('match_candidates_listing_ngo_key').on(t.listingId, t.ngoOrgId),
    index('match_candidates_ngo_idx').on(t.ngoOrgId, t.eligible),
    check('match_candidates_score_range', sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
  ],
);

/** Minimal in-app notification inbox. `dedupe_key` makes inserts idempotent. No email/SMS/WebSocket yet. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_key').on(t.dedupeKey),
    index('notifications_user_idx').on(t.userId, t.createdAt),
  ],
);

export type MatchCandidate = typeof matchCandidates.$inferSelect;

/* ------------------------------ Phase 5: rescues ------------------------------ */

export const RESCUE_STATUSES = [
  'RESERVED',
  'PICKUP_ASSIGNED',
  'PICKUP_CONFIRMED',
  'RECIPIENT_CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'PICKUP_FAILED',
  'DELIVERY_FAILED',
  // Phase 6 (runner-assisted): appended so existing enum values keep their order.
  'AWAITING_RUNNER',
  'IN_TRANSIT',
  'DELIVERED',
] as const;
export type RescueStatus = (typeof RESCUE_STATUSES)[number];
export const rescueStatus = pgEnum('rescue_status', RESCUE_STATUSES);
export const transportMode = pgEnum('transport_mode', ['NGO_PICKUP', 'RUNNER']);
export type TransportMode = (typeof transportMode.enumValues)[number];

/**
 * The authoritative transaction for one accepted listing (spec 4.1, 7). At most one ACTIVE rescue per
 * listing is enforced by a partial unique index created in migration SQL (rescues_one_active_per_listing).
 */
export const rescues = pgTable(
  'rescues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => foodListings.id, { onDelete: 'restrict' }),
    providerOrgId: uuid('provider_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ngoOrgId: uuid('ngo_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    acceptedBy: uuid('accepted_by')
      .notNull()
      .references(() => users.id),
    status: rescueStatus('status').notNull().default('RESERVED'),
    /** Incremented on every transition; clients may send it back to detect stale actions. */
    version: integer('version').notNull().default(1),
    /** Servings offered when accepted (the listing cannot change while reserved). */
    servingsOffered: integer('servings_offered').notNull(),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    providerConfirmBy: timestamp('provider_confirm_by', { withTimezone: true }).notNull(),
    providerConfirmedAt: timestamp('provider_confirmed_at', { withTimezone: true }),
    pickupBy: timestamp('pickup_by', { withTimezone: true }).notNull(),
    /** SHA-256 of the current one-time pickup code (bound to this rescue). The code itself is never stored. */
    pickupCodeHash: text('pickup_code_hash'),
    pickupCodeAttempts: integer('pickup_code_attempts').notNull().default(0),
    pickupCodeIssuedAt: timestamp('pickup_code_issued_at', { withTimezone: true }),
    pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
    collectedServings: integer('collected_servings'),
    deliveryConfirmBy: timestamp('delivery_confirm_by', { withTimezone: true }),
    deliveredServings: integer('delivered_servings'),
    recipientConfirmedAt: timestamp('recipient_confirmed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** When the rescue reached a terminal state (completed or not). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Machine-readable outcome code for reliability later (e.g. NGO_CANCELLED, PROVIDER_NO_RESPONSE). */
    outcomeCode: text('outcome_code'),
    outcomeReason: text('outcome_reason'),
    /** NGO_PICKUP: the NGO collects (Phase 5). RUNNER: a volunteer runner collects and delivers (Phase 6). */
    transportMode: transportMode('transport_mode').notNull().default('NGO_PICKUP'),
    /** While AWAITING_RUNNER: when the search for a runner gives up. */
    runnerBy: timestamp('runner_by', { withTimezone: true }),
    transitStartedAt: timestamp('transit_started_at', { withTimezone: true }),
    handedOverAt: timestamp('handed_over_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('rescues_listing_idx').on(t.listingId),
    index('rescues_ngo_idx').on(t.ngoOrgId, t.status),
    index('rescues_provider_idx').on(t.providerOrgId, t.status),
    index('rescues_due_idx').on(t.status, t.providerConfirmBy, t.pickupBy, t.deliveryConfirmBy),
    // Impact metrics (Phase 8): completed rescues by completion time.
    index('rescues_completed_at_idx').on(t.completedAt).where(sql`${t.status} = 'COMPLETED'`),
    check('rescues_collected_range', sql`${t.collectedServings} IS NULL OR (${t.collectedServings} > 0 AND ${t.collectedServings} <= ${t.servingsOffered})`),
    check('rescues_delivered_range', sql`${t.deliveredServings} IS NULL OR (${t.deliveredServings} >= 0 AND ${t.collectedServings} IS NOT NULL AND ${t.deliveredServings} <= ${t.collectedServings})`),
    check('rescues_parties_differ', sql`${t.providerOrgId} <> ${t.ngoOrgId}`),
  ],
);

/** Append-only rescue history (a database trigger rejects UPDATE and DELETE). Never stores pickup codes. */
export const rescueEvents = pgTable(
  'rescue_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Strict insertion order. Rows written in one transaction share created_at, so history is ordered by this. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    rescueId: uuid('rescue_id')
      .notNull()
      .references(() => rescues.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    fromStatus: rescueStatus('from_status'),
    toStatus: rescueStatus('to_status'),
    /** Null for system actions (expiry). */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorRole: text('actor_role').notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rescue_events_rescue_idx').on(t.rescueId, t.createdAt)],
);

export type Rescue = typeof rescues.$inferSelect;

/* ------------------------------ Phase 6: runners, location, incidents ------------------------------ */

export const assignmentStatus = pgEnum('assignment_status', ['ACTIVE', 'COMPLETED', 'RELEASED', 'REVOKED']);

/**
 * Which runner holds a rescue. At most one ACTIVE assignment per rescue AND per runner (partial unique
 * indexes in migration SQL), so concurrent claims cannot both succeed. Ended rows are kept as history and
 * used to avoid re-offering a rescue to a runner who released it.
 */
export const rescueAssignments = pgTable(
  'rescue_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rescueId: uuid('rescue_id')
      .notNull()
      .references(() => rescues.id, { onDelete: 'restrict' }),
    runnerUserId: uuid('runner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: assignmentStatus('status').notNull().default('ACTIVE'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rescue_assignments_rescue_idx').on(t.rescueId), index('rescue_assignments_runner_idx').on(t.runnerUserId, t.status)],
);

/**
 * The runner's LATEST shared position for one rescue. One row per rescue (overwritten, never a trail),
 * rounded to 3 decimals (about 100 m), deleted as soon as the rescue leaves the tracked stages.
 */
export const rescueLocations = pgTable(
  'rescue_locations',
  {
    rescueId: uuid('rescue_id')
      .primaryKey()
      .references(() => rescues.id, { onDelete: 'cascade' }),
    runnerUserId: uuid('runner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('rescue_locations_lat', sql`${t.latitude} BETWEEN -90 AND 90`),
    check('rescue_locations_lng', sql`${t.longitude} BETWEEN -180 AND 180`),
  ],
);

export const INCIDENT_CATEGORIES = ['FOOD_SAFETY', 'QUANTITY_MISMATCH', 'PICKUP_PROBLEM', 'DELIVERY_PROBLEM', 'RUNNER_UNAVAILABLE', 'OTHER'] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const incidentCategory = pgEnum('incident_category', INCIDENT_CATEGORIES);
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const incidentSeverity = pgEnum('incident_severity', INCIDENT_SEVERITIES);
export const incidentStatus = pgEnum('incident_status', ['OPEN', 'RESOLVED']);

/**
 * A problem reported on a rescue. `blocking` incidents (HIGH/CRITICAL severity, or any FOOD_SAFETY report) stop normal
 * forward transitions until an admin resolves them (spec BR-07). Every report and resolution is also written
 * to the append-only rescue_events history.
 */
export const incidentReports = pgTable(
  'incident_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rescueId: uuid('rescue_id')
      .notNull()
      .references(() => rescues.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reporterRole: text('reporter_role').notNull(),
    category: incidentCategory('category').notNull(),
    severity: incidentSeverity('severity').notNull(),
    blocking: boolean('blocking').notNull(),
    description: text('description').notNull(),
    status: incidentStatus('status').notNull().default('OPEN'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'restrict' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionCode: text('resolution_code'),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incident_reports_rescue_idx').on(t.rescueId, t.status),
    index('incident_reports_open_idx').on(t.status, t.createdAt),
    check('incident_resolved_fields', sql`${t.status} = 'OPEN' OR (${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.resolutionCode} IS NOT NULL)`),
  ],
);

/** Evidence photos: metadata here, bytes in private storage. The storage key is never sent to clients. */
export const incidentEvidence = pgTable(
  'incident_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidentReports.id, { onDelete: 'restrict' }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('incident_evidence_key').on(t.storageKey), index('incident_evidence_incident_idx').on(t.incidentId)],
);

export type RescueAssignment = typeof rescueAssignments.$inferSelect;
export type IncidentReport = typeof incidentReports.$inferSelect;

/**
 * Phase 7: one row per executed retention run (operator command only; the runtime role has no access).
 * Counts only: never file names, descriptions or other content.
 */
export const retentionRuns = pgTable('retention_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  policy: jsonb('policy').notNull(),
  counts: jsonb('counts').notNull(),
  failures: integer('failures').notNull().default(0),
});

/* ------------------------------ Escalation waves ------------------------------ */

export const escalationStepKind = pgEnum('escalation_step_kind', ['NGO_WAVE', 'RUNNER_WAVE', 'ADMIN_ALERT']);
export const escalationStepStatus = pgEnum('escalation_step_status', ['PENDING', 'DONE', 'SKIPPED', 'CANCELLED']);
export const escalationRecipientKind = pgEnum('escalation_recipient_kind', ['NGO', 'RUNNER']);

/**
 * The persisted escalation schedule of one published listing: a row per step, per round (a round starts at publish, and a
 * new one when a failed rescue releases the listing back to the market). A step runs at most once: once it leaves PENDING a
 * trigger refuses any further change. Counts only; no names, addresses or contact details.
 */
export const escalationSteps = pgTable(
  'escalation_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => foodListings.id, { onDelete: 'restrict' }),
    round: integer('round').notNull().default(1),
    seq: integer('seq').notNull(),
    kind: escalationStepKind('kind').notNull(),
    /** Search radius of an NGO or runner wave; null for the admin alert. */
    radiusKm: doublePrecision('radius_km'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: escalationStepStatus('status').notNull().default('PENDING'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** Eligible recipients inside this wave's radius when it ran (re-evaluated live). */
    qualified: integer('qualified'),
    /** Of those, how many had not been told by an earlier wave. */
    newlyEligible: integer('newly_eligible'),
    notifiedOrgs: integer('notified_orgs'),
    notifiedUsers: integer('notified_users'),
    /** Why a step was SKIPPED or CANCELLED (a code such as LISTING_ACCEPTED, NO_TRANSPORT_NEEDED). */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('escalation_steps_listing_round_seq').on(t.listingId, t.round, t.seq),
    index('escalation_steps_due_idx').on(t.status, t.dueAt),
    check('escalation_steps_seq_positive', sql`${t.seq} > 0 AND ${t.round} > 0`),
  ],
);

/**
 * Who each wave told. Insert-only (a trigger rejects UPDATE and DELETE), and unique per listing and recipient, so nobody is
 * told twice by overlapping or repeated runs.
 */
export const escalationRecipients = pgTable(
  'escalation_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => foodListings.id, { onDelete: 'restrict' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => escalationSteps.id, { onDelete: 'restrict' }),
    kind: escalationRecipientKind('kind').notNull(),
    ngoOrgId: uuid('ngo_org_id').references(() => organizations.id, { onDelete: 'restrict' }),
    runnerUserId: uuid('runner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /** Position in the wave by match score (NGOs) or distance (runners), 1 = first. */
    position: integer('position').notNull(),
    distanceM: doublePrecision('distance_m'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('escalation_recipients_ngo_once').on(t.listingId, t.ngoOrgId).where(sql`${t.kind} = 'NGO'`),
    uniqueIndex('escalation_recipients_runner_once').on(t.listingId, t.runnerUserId).where(sql`${t.kind} = 'RUNNER'`),
    index('escalation_recipients_step_idx').on(t.stepId),
    check(
      'escalation_recipients_one_target',
      sql`(${t.kind} = 'NGO' AND ${t.ngoOrgId} IS NOT NULL AND ${t.runnerUserId} IS NULL) OR (${t.kind} = 'RUNNER' AND ${t.runnerUserId} IS NOT NULL AND ${t.ngoOrgId} IS NULL)`,
    ),
  ],
);

export type EscalationStep = typeof escalationSteps.$inferSelect;
