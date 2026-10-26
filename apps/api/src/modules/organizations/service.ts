import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  organizationMembers,
  organizations,
  verificationDocuments,
  verificationEvents,
  type Organization,
  type PlatformRole,
} from '../../db/schema.js';
import { AppError, errors, validationError } from '../../http/errors.js';
import { isApplicantEditable, nextStatus } from './lifecycle.js';
import type { CreateOrganizationInput, UpdateOrganizationInput } from './schemas.js';
import { ZodError } from 'zod';

export interface Actor {
  id: string;
  platformRole: PlatformRole;
}

export type OrgAccess = 'read' | 'manage';
export type OrgContext = { org: Organization; memberRole: 'owner' | 'manager' | 'operator' | null };

/** Fields an applicant must fill in before the application can be submitted. */
const REQUIRED_PROFILE_FIELDS = ['name', 'contactName', 'contactEmail', 'contactPhone', 'addressLine', 'city'] as const;
/** Fields whose change would invalidate an approval; locked once VERIFIED. */
const IDENTITY_FIELDS = ['name', 'addressLine', 'city', 'latitude', 'longitude'] as const;
export const REQUIRED_DOCUMENT_TYPE = 'REGISTRATION_CERTIFICATE';

export function serializeOrganization(ctx: OrgContext) {
  const { org, memberRole } = ctx;
  return {
    id: org.id,
    type: org.type,
    name: org.name,
    verificationStatus: org.verificationStatus,
    statusReason: org.statusReason,
    contactName: org.contactName,
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone,
    addressLine: org.addressLine,
    city: org.city,
    latitude: org.latitude,
    longitude: org.longitude,
    submissionNumber: org.submissionCount,
    submittedAt: org.submittedAt,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    myRole: memberRole,
    /** Whether the applicant may currently change the profile fields / documents. */
    editable: isApplicantEditable(org.verificationStatus),
  };
}

/** Called after a verified organization gains map coordinates so its recommendations can be refreshed. */
export interface OrganizationHooks {
  coordinatesAdded?(organizationId: string, type: 'PROVIDER' | 'NGO'): Promise<void>;
}

export function createOrganizationService(db: Db, hooks: OrganizationHooks = {}) {
  /**
   * Loads an organization on behalf of a user. Non-members get 404 (not 403) so
   * organization ids cannot be probed. Admins may read any organization but never edit.
   */
  async function resolve(actor: Actor, orgId: string, access: OrgAccess, executor: Pick<Db, 'select'> = db): Promise<OrgContext> {
    const [org] = await executor.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw errors.notFound('Organization not found.');
    if (actor.platformRole === 'admin') {
      if (access === 'manage') throw errors.forbidden();
      return { org, memberRole: null };
    }
    const [member] = await executor
      .select({ memberRole: organizationMembers.memberRole })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, orgId),
          eq(organizationMembers.userId, actor.id),
          eq(organizationMembers.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!member) throw errors.notFound('Organization not found.');
    if (access === 'manage' && member.memberRole === 'operator') throw errors.forbidden();
    return { org, memberRole: member.memberRole };
  }

  function assertEditable(org: Organization) {
    if (!isApplicantEditable(org.verificationStatus)) {
      throw new AppError(409, 'ORGANIZATION_LOCKED', lockedMessage(org.verificationStatus), {
        verificationStatus: org.verificationStatus,
      });
    }
  }

  return {
    resolve,
    assertEditable,

    async create(actor: Actor, input: CreateOrganizationInput) {
      if (actor.platformRole !== 'provider' && actor.platformRole !== 'ngo') throw errors.forbidden();
      const type = actor.platformRole === 'provider' ? 'PROVIDER' : 'NGO';
      assertCoordinates(input.latitude, input.longitude);
      return db.transaction(async (tx) => {
        // Serialize concurrent creates by the same user.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${actor.id}))`);
        const [open] = await tx
          .select({ id: organizations.id })
          .from(organizationMembers)
          .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
          .where(
            and(
              eq(organizationMembers.userId, actor.id),
              eq(organizationMembers.status, 'ACTIVE'),
              eq(organizations.type, type),
              sql`${organizations.verificationStatus} <> 'REJECTED'`,
            ),
          )
          .limit(1);
        if (open) {
          throw new AppError(
            409,
            'ORGANIZATION_EXISTS',
            'You already have an organization profile. Edit it instead, or wait until an application is rejected to start a new one.',
          );
        }
        const [org] = await tx
          .insert(organizations)
          .values({ type, ...input, latitude: input.latitude ?? null, longitude: input.longitude ?? null })
          .returning();
        await tx.insert(organizationMembers).values({ userId: actor.id, organizationId: org!.id, memberRole: 'owner' });
        return serializeOrganization({ org: org!, memberRole: 'owner' });
      });
    },

    async listMine(actor: Actor) {
      const rows = await db
        .select({ org: organizations, memberRole: organizationMembers.memberRole })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(and(eq(organizationMembers.userId, actor.id), eq(organizationMembers.status, 'ACTIVE')))
        .orderBy(desc(organizations.createdAt));
      return rows.map((r) => serializeOrganization(r));
    },

    async get(actor: Actor, orgId: string) {
      return serializeOrganization(await resolve(actor, orgId, 'read'));
    },

    async update(actor: Actor, orgId: string, input: UpdateOrganizationInput) {
      const result = await db.transaction(async (tx) => {
        const ctx = await resolve(actor, orgId, 'manage', tx);
        const { org } = ctx;
        const verified = org.verificationStatus === 'VERIFIED';
        if (!verified) assertEditable(org);
        if (verified) {
          // Name, street address and city stay locked: they are what the approval covers. The map position may be set or
          // corrected (an owner or manager only), because matching depends on it and it is not part of what was approved;
          // it must still be a complete latitude/longitude pair, and matching is re-evaluated from the new point.
          const locked = IDENTITY_FIELDS.filter((f) => f in input && f !== 'latitude' && f !== 'longitude');
          if (locked.length > 0) {
            throw new AppError(409, 'ORGANIZATION_LOCKED', 'Name and address cannot be changed after verification. Contact support.', {
              fields: Object.fromEntries(locked.map((f) => [f, 'Locked after verification.'])),
            });
          }
        }
        const nextLat = input.latitude !== undefined ? input.latitude : org.latitude;
        const nextLng = input.longitude !== undefined ? input.longitude : org.longitude;
        assertCoordinates(nextLat, nextLng);
        const [updated] = await tx
          .update(organizations)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(organizations.id, orgId))
          .returning();
        return serializeOrganization({ org: updated!, memberRole: ctx.memberRole });
      });
      if (result.verificationStatus === 'VERIFIED' && (input.latitude != null || input.longitude != null)) {
        await hooks.coordinatesAdded?.(orgId, result.type);
      }
      return result;
    },

    /** UNSUBMITTED / RESUBMISSION_REQUESTED → UNDER_REVIEW, if the profile and documents are complete. */
    async submit(actor: Actor, orgId: string) {
      return db.transaction(async (tx) => {
        const ctx = await resolve(actor, orgId, 'manage', tx);
        // Lock the row so concurrent submits / decisions are serialized.
        const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
        const target = nextStatus(org!.verificationStatus, 'SUBMIT');
        if (!target) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', submitBlockedMessage(org!.verificationStatus), {
            verificationStatus: org!.verificationStatus,
          });
        }
        const missing: string[] = REQUIRED_PROFILE_FIELDS.filter((f) => !org![f]);
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(verificationDocuments)
          .where(
            and(
              eq(verificationDocuments.organizationId, orgId),
              eq(verificationDocuments.documentType, REQUIRED_DOCUMENT_TYPE),
              sql`${verificationDocuments.reviewStatus} <> 'REJECTED'`,
            ),
          );
        if (n === 0) missing.push('document:REGISTRATION_CERTIFICATE');
        if (missing.length > 0) {
          throw new AppError(422, 'SUBMISSION_INCOMPLETE', 'Complete the required details and documents before submitting.', {
            missing,
          });
        }
        const submissionNumber = org!.submissionCount + 1;
        const [updated] = await tx
          .update(organizations)
          .set({
            verificationStatus: target,
            submissionCount: submissionNumber,
            submittedAt: new Date(),
            statusReason: null,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId))
          .returning();
        await tx.insert(verificationEvents).values({
          organizationId: orgId,
          action: 'SUBMITTED',
          fromStatus: org!.verificationStatus,
          toStatus: target,
          actorUserId: actor.id,
          submissionNumber,
        });
        return serializeOrganization({ org: updated!, memberRole: ctx.memberRole });
      });
    },

    /** Applicant-visible history: what happened and why, without admin identities. */
    async historyForApplicant(actor: Actor, orgId: string) {
      await resolve(actor, orgId, 'read');
      const rows = await db
        .select({
          id: verificationEvents.id,
          action: verificationEvents.action,
          toStatus: verificationEvents.toStatus,
          reason: verificationEvents.reason,
          submissionNumber: verificationEvents.submissionNumber,
          createdAt: verificationEvents.createdAt,
        })
        .from(verificationEvents)
        .where(eq(verificationEvents.organizationId, orgId))
        .orderBy(desc(verificationEvents.createdAt));
      return rows;
    },
  };
}

export type OrganizationService = ReturnType<typeof createOrganizationService>;

function assertCoordinates(lat: number | null | undefined, lng: number | null | undefined) {
  if ((lat == null) !== (lng == null)) {
    const message = 'Provide both latitude and longitude, or neither.';
    throw validationError(new ZodError([{ code: 'custom', path: [lat == null ? 'latitude' : 'longitude'], message, input: undefined }]));
  }
}

function lockedMessage(status: string) {
  switch (status) {
    case 'UNDER_REVIEW':
      return 'This application is under review and cannot be changed until the admin responds.';
    case 'REJECTED':
      return 'This application was rejected and can no longer be changed.';
    default:
      return 'This organization cannot be changed in its current state.';
  }
}

function submitBlockedMessage(status: string) {
  switch (status) {
    case 'UNDER_REVIEW':
      return 'This application is already under review.';
    case 'VERIFIED':
      return 'This organization is already verified.';
    case 'REJECTED':
      return 'This application was rejected and cannot be resubmitted. Start a new application.';
    default:
      return 'This application cannot be submitted in its current state.';
  }
}
