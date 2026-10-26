import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Db } from '../../db/client.js';
import { organizationMembers, organizations, type Organization } from '../../db/schema.js';
import { AppError, errors } from '../../http/errors.js';

/**
 * Reusable domain guards for later phases: only VERIFIED organizations may take part
 * in live operations (listings, acceptance, matching). Admins are not exempt; an admin
 * acting for an organization will use an explicit, audited override instead.
 */

export async function assertOrganizationVerified(db: Db, organizationId: string): Promise<Organization> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) throw errors.notFound('Organization not found.');
  if (org.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'ORGANIZATION_NOT_VERIFIED', 'This organization must be verified before it can do this.', {
      verificationStatus: org.verificationStatus,
    });
  }
  return org;
}

/** The user must be an active member of the organization AND the organization must be verified. */
export async function assertVerifiedMember(db: Db, userId: string, organizationId: string): Promise<Organization> {
  const [member] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  if (!member) throw errors.notFound('Organization not found.');
  return assertOrganizationVerified(db, organizationId);
}

/** Express middleware form; `getOrganizationId` extracts the target organization from the request. */
export function requireVerifiedMember(
  db: Db,
  getOrganizationId: (req: Parameters<RequestHandler>[0]) => string | undefined,
): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw errors.unauthenticated();
      const orgId = getOrganizationId(req);
      if (!orgId) throw errors.notFound('Organization not found.');
      await assertVerifiedMember(db, req.auth.user.id, orgId);
      next();
    } catch (err) {
      next(err);
    }
  };
}
