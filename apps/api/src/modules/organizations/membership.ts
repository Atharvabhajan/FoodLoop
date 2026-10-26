import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { AppError } from '../../http/errors.js';
import { organizationMembers, organizations, type Organization } from '../../db/schema.js';

type Reader = Pick<Db, 'select'>;

/** Active-member organizations of one type, newest first. Rejected applications are excluded. */
export async function activeOrganizations(db: Reader, userId: string, type: 'PROVIDER' | 'NGO'): Promise<Organization[]> {
  const rows = await db
    .select({ org: organizations })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, 'ACTIVE'),
        eq(organizations.type, type),
        sql`${organizations.verificationStatus} <> 'REJECTED'`,
      ),
    )
    .orderBy(desc(organizations.createdAt));
  return rows.map((r) => r.org);
}

export async function isActiveMember(db: Reader, userId: string, organizationId: string): Promise<boolean> {
  const [row] = await db
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
  return !!row;
}

/** The caller's current organization of this type, or a 409 telling them to create one first. */
export async function currentOrganization(db: Reader, userId: string, type: 'PROVIDER' | 'NGO'): Promise<Organization> {
  const [org] = await activeOrganizations(db, userId, type);
  if (!org) {
    throw new AppError(409, 'ORGANIZATION_REQUIRED', 'Create your organization profile first.');
  }
  return org;
}
