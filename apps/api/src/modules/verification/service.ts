import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  organizationMembers,
  organizations,
  users,
  verificationDocuments,
  verificationEvents,
  verificationStatus,
  type VerificationStatus,
} from '../../db/schema.js';
import { AppError, errors } from '../../http/errors.js';
import { serializeDocument } from '../organizations/documents.js';
import { nextStatus, type VerificationCommand } from '../organizations/lifecycle.js';
import { serializeOrganization } from '../organizations/service.js';
import type { DecisionInput } from '../organizations/schemas.js';

const commandAction = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  REQUEST_RESUBMISSION: 'RESUBMISSION_REQUESTED',
} as const;

export function isVerificationStatus(v: unknown): v is VerificationStatus {
  return typeof v === 'string' && (verificationStatus.enumValues as readonly string[]).includes(v);
}

/** Called after an NGO is approved so it can become a candidate for live listings. */
export interface VerificationHooks {
  ngoApproved?(ngoOrgId: string): Promise<void>;
}

export function createVerificationService(db: Db, hooks: VerificationHooks = {}) {
  async function ownerOf(orgId: string) {
    const [owner] = await db
      .select({ name: users.name, email: users.email, phone: users.phone })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.memberRole, 'owner')))
      .orderBy(asc(organizationMembers.createdAt))
      .limit(1);
    return owner ?? null;
  }

  return {
    /** Oldest submission first, so the longest-waiting applications are reviewed first. */
    async queue(status: VerificationStatus | 'ALL') {
      const where = status === 'ALL' ? undefined : eq(organizations.verificationStatus, status);
      const rows = await db
        .select({
          org: organizations,
          documentCount: sql<number>`(SELECT count(*)::int FROM verification_documents d WHERE d.organization_id = "organizations"."id")`,
        })
        .from(organizations)
        .where(where)
        .orderBy(asc(sql`coalesce(${organizations.submittedAt}, ${organizations.createdAt})`))
        .limit(200);
      return rows.map((r) => ({
        ...serializeOrganization({ org: r.org, memberRole: null }),
        documentCount: r.documentCount,
      }));
    },

    async detail(orgId: string) {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (!org) throw errors.notFound('Organization not found.');
      const docs = await db
        .select()
        .from(verificationDocuments)
        .where(eq(verificationDocuments.organizationId, orgId))
        .orderBy(asc(verificationDocuments.createdAt));
      const history = await db
        .select({
          id: verificationEvents.id,
          action: verificationEvents.action,
          fromStatus: verificationEvents.fromStatus,
          toStatus: verificationEvents.toStatus,
          reason: verificationEvents.reason,
          submissionNumber: verificationEvents.submissionNumber,
          createdAt: verificationEvents.createdAt,
          actorName: users.name,
        })
        .from(verificationEvents)
        .innerJoin(users, eq(users.id, verificationEvents.actorUserId))
        .where(eq(verificationEvents.organizationId, orgId))
        .orderBy(desc(verificationEvents.createdAt));
      return {
        organization: serializeOrganization({ org, memberRole: null }),
        owner: await ownerOf(orgId),
        documents: docs.map(serializeDocument),
        history,
      };
    },

    async decide(adminId: string, orgId: string, input: DecisionInput) {
      const command: VerificationCommand = input.decision;
      const result = await db.transaction(async (tx) => {
        // Row lock: two admins deciding at once are serialized, so the second sees the new status.
        const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
        if (!org) throw errors.notFound('Organization not found.');
        const target = nextStatus(org.verificationStatus, command);
        if (!target) {
          throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This application is not awaiting review, so it cannot be decided.', {
            verificationStatus: org.verificationStatus,
          });
        }
        if (org.submissionCount !== input.submissionNumber) {
          throw new AppError(409, 'STALE_REVIEW', 'The applicant resubmitted since you opened this application. Reload it and review again.', {
            currentSubmissionNumber: org.submissionCount,
          });
        }
        const reason = input.reason?.trim() || null;
        const [updated] = await tx
          .update(organizations)
          .set({
            verificationStatus: target,
            statusReason: command === 'APPROVE' ? null : reason,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId))
          .returning();
        if (command === 'APPROVE') {
          await tx
            .update(verificationDocuments)
            .set({ reviewStatus: 'ACCEPTED', updatedAt: new Date() })
            .where(and(eq(verificationDocuments.organizationId, orgId), eq(verificationDocuments.reviewStatus, 'PENDING')));
        }
        await tx.insert(verificationEvents).values({
          organizationId: orgId,
          action: commandAction[command as keyof typeof commandAction],
          fromStatus: org.verificationStatus,
          toStatus: target,
          actorUserId: adminId,
          reason,
          submissionNumber: org.submissionCount,
        });
        return serializeOrganization({ org: updated!, memberRole: null });
      });
      if (command === 'APPROVE' && result.type === 'NGO') await hooks.ngoApproved?.(orgId);
      return result;
    },
  };
}

export type VerificationService = ReturnType<typeof createVerificationService>;
