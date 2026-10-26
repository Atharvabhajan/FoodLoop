import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import {
  foodListings,
  incidentEvidence,
  incidentReports,
  rescues,
  type IncidentCategory,
  type IncidentSeverity,
} from '../../db/schema.js';
import { AppError, errors, fieldErrors } from '../../http/errors.js';
import type { FileStorage } from '../../storage/index.js';
import { IMAGE_TYPES, sniffImage, stripImageMetadata } from '../listings/images.js';
import { effectiveRescueStatus, isActive, isBlockingIncident, nextRescueStatus, runnerSearchDeadline, type Party } from '../rescues/lifecycle.js';
import { invalidTransition, type Actor, type RescueInternals } from '../rescues/service.js';
import type { RunnerService } from '../runners/service.js';

export const MAX_EVIDENCE_PER_INCIDENT = 3;
export const RESOLUTIONS = ['NO_ACTION', 'REASSIGN_RUNNER', 'CANCEL_RESCUE', 'FAIL_DELIVERY', 'COMPLETE_WITH_QUANTITY'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const DUPLICATE_WINDOW_MS = 120_000;

export function createIncidentService(core: RescueInternals, runners: Pick<RunnerService, 'startSearch'>, storage: FileStorage) {
  const { db, settings } = core;

  /** The role under which this actor must be a party to the rescue (checked again by withRescue). */
  const roleOf = (actor: Actor): Party => {
    if (actor.platformRole === 'provider' || actor.platformRole === 'ngo' || actor.platformRole === 'runner') return actor.platformRole;
    throw errors.forbidden(); // admins resolve incidents; they do not file them
  };

  const publicIncident = (i: typeof incidentReports.$inferSelect) => ({
    id: i.id,
    rescueId: i.rescueId,
    category: i.category,
    severity: i.severity,
    blocking: i.blocking,
    status: i.status,
    description: i.description,
    reporterRole: i.reporterRole,
    createdAt: i.createdAt,
    resolvedAt: i.resolvedAt,
    resolutionCode: i.resolutionCode,
    resolutionNote: i.resolutionNote,
  });

  return {
    /**
     * A party reports a problem on an in-progress rescue. A blocking report (HIGH/CRITICAL, or food safety) stops the
     * rescue's normal forward steps until an admin resolves it. Repeating the same report within two minutes returns
     * the original instead of creating a duplicate.
     */
    async report(actor: Actor, rescueId: string, input: { category: IncidentCategory; severity: IncidentSeverity; description: string }) {
      const role = roleOf(actor);
      return core.withRescue(actor, rescueId, role, undefined, async (ctx) => {
        const status = effectiveRescueStatus(ctx.rescue, ctx.now);
        if (!(isActive(status) && status !== 'RESERVED') && status !== 'DELIVERY_FAILED') {
          return { error: new AppError(409, 'INCIDENT_NOT_ALLOWED', 'Incidents can only be reported on a rescue that is in progress after the provider confirmed.', { status }) };
        }
        if (role === 'runner' && (await core.activeAssignment(ctx.tx, ctx.rescue.id))?.runnerUserId !== actor.id) {
          return { error: new AppError(409, 'NOT_ASSIGNED', 'You are not assigned to this rescue.') };
        }
        const [dupe] = await ctx.tx
          .select()
          .from(incidentReports)
          .where(
            and(
              eq(incidentReports.rescueId, ctx.rescue.id),
              eq(incidentReports.reporterUserId, actor.id),
              eq(incidentReports.category, input.category),
              eq(incidentReports.description, input.description),
              gt(incidentReports.createdAt, new Date(ctx.now.getTime() - DUPLICATE_WINDOW_MS)),
            ),
          )
          .limit(1);
        if (dupe) return { incident: publicIncident(dupe), changed: false };

        const blocking = isBlockingIncident(input.category, input.severity);
        const [incident] = await ctx.tx
          .insert(incidentReports)
          .values({ rescueId: ctx.rescue.id, reporterUserId: actor.id, reporterRole: role, category: input.category, severity: input.severity, blocking, description: input.description, createdAt: ctx.now })
          .returning();
        const eventId = await core.recordEvent(ctx, {
          rescueId: ctx.rescue.id,
          eventType: 'INCIDENT_REPORTED',
          from: null,
          to: null,
          actor,
          metadata: { incidentId: incident!.id, category: input.category, severity: input.severity, blocking },
        });
        // Everyone involved (and admins) learn that something was reported. The description stays on the rescue page.
        const runner = await core.activeAssignment(ctx.tx, ctx.rescue.id);
        const extra = [...(runner ? [runner.runnerUserId] : []), ...(await core.adminIds(ctx.tx))];
        await core.notify(
          ctx,
          eventId,
          ctx.rescue.id,
          [ctx.rescue.providerOrgId, ctx.rescue.ngoOrgId],
          actor.id,
          `Incident reported: ${ctx.listing.title}`,
          `A ${input.severity.toLowerCase()} ${input.category.replace(/_/g, ' ').toLowerCase()} problem was reported${blocking ? '. The rescue is paused until an admin resolves it.' : '.'}`,
          extra,
        );
        return { incident: publicIncident(incident!), changed: true, rescueBlocked: blocking };
      });
    },

    /**
     * Authorization for adding evidence: a party to the rescue, adding to their OWN open incident, under the photo limit.
     * Called by the route BEFORE the upload body is read, so unauthorized callers never get a file buffered.
     */
    async assertCanAttach(actor: Actor, rescueId: string, incidentId: string) {
      const role = roleOf(actor);
      await core.withRescue(actor, rescueId, role, undefined, async (ctx) => {
        const [inc] = await ctx.tx.select().from(incidentReports).where(and(eq(incidentReports.id, incidentId), eq(incidentReports.rescueId, ctx.rescue.id)));
        if (!inc || inc.reporterUserId !== actor.id) return { error: errors.notFound('Incident not found.') };
        if (inc.status !== 'OPEN') return { error: new AppError(409, 'INCIDENT_CLOSED', 'This incident has been resolved.') };
        const [{ n } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(incidentEvidence).where(eq(incidentEvidence.incidentId, incidentId));
        if (n >= MAX_EVIDENCE_PER_INCIDENT) return { error: new AppError(409, 'EVIDENCE_LIMIT', `At most ${MAX_EVIDENCE_PER_INCIDENT} photos per incident.`) };
        return { ok: true };
      });
    },

    /** Attach a photo to your own open incident. Metadata is stripped; only the id, type, size and hash are recorded. */
    async addEvidence(actor: Actor, rescueId: string, incidentId: string, file: Express.Multer.File | undefined) {
      await this.assertCanAttach(actor, rescueId, incidentId);
      if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Attach an image in the "file" field.', { fields: { file: 'An image is required.' } });
      const format = sniffImage(file.buffer);
      if (!format) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Only PNG and JPEG images are accepted.', { fields: { file: 'Only PNG and JPEG images are accepted.' } });
      const clean = stripImageMetadata(file.buffer, format);
      if (!clean) throw new AppError(400, 'UPLOAD_INVALID', 'The image file is damaged or malformed.', { fields: { file: 'The image file is damaged.' } });

      const key = await storage.save(`incident-${incidentId}`, IMAGE_TYPES[format].extension, clean);
      try {
        return await db.transaction(async (tx) => {
          // The photo limit is enforced here, under a row lock, so concurrent uploads cannot exceed it.
          await tx.select({ id: incidentReports.id }).from(incidentReports).where(eq(incidentReports.id, incidentId)).for('update');
          const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(incidentEvidence).where(eq(incidentEvidence.incidentId, incidentId));
          if (n >= MAX_EVIDENCE_PER_INCIDENT) throw new AppError(409, 'EVIDENCE_LIMIT', `At most ${MAX_EVIDENCE_PER_INCIDENT} photos per incident.`);
          const [row] = await tx
            .insert(incidentEvidence)
            .values({ incidentId, uploadedBy: actor.id, storageKey: key, mimeType: IMAGE_TYPES[format].mime, sizeBytes: clean.length, sha256: createHash('sha256').update(clean).digest('hex') })
            .returning({ id: incidentEvidence.id, mimeType: incidentEvidence.mimeType, sizeBytes: incidentEvidence.sizeBytes, createdAt: incidentEvidence.createdAt });
          await core.recordEvent({ tx }, { rescueId, eventType: 'INCIDENT_EVIDENCE_ADDED', from: null, to: null, actor, metadata: { incidentId, evidenceId: row!.id, mimeType: row!.mimeType, sizeBytes: row!.sizeBytes } });
          return { evidence: row! };
        });
      } catch (err) {
        await storage.remove(key).catch(() => undefined);
        throw err;
      }
    },

    /** Evidence is readable by the rescue's parties and admins only. */
    async openEvidence(actor: Actor, rescueId: string, incidentId: string, evidenceId: string) {
      const [rescue] = await db.select().from(rescues).where(eq(rescues.id, rescueId));
      if (!rescue) throw errors.notFound('Rescue not found.');
      if (!(await core.partyOf(actor, rescue, db))) throw errors.notFound('Rescue not found.');
      const [row] = await db
        .select({ e: incidentEvidence })
        .from(incidentEvidence)
        .innerJoin(incidentReports, eq(incidentReports.id, incidentEvidence.incidentId))
        .where(and(eq(incidentEvidence.id, evidenceId), eq(incidentEvidence.incidentId, incidentId), eq(incidentReports.rescueId, rescueId)));
      if (!row) throw errors.notFound('Evidence not found.');
      return { mime: row.e.mimeType, stream: storage.open(row.e.storageKey) };
    },

    /* ---------------- admin ---------------- */

    async list(actor: Actor, status: 'OPEN' | 'RESOLVED' | 'ALL') {
      if (actor.platformRole !== 'admin') throw errors.forbidden();
      const rows = await db
        .select({
          i: incidentReports,
          listingTitle: foodListings.title,
          rescueStatus: rescues.status,
          providerName: sql<string>`(SELECT name FROM organizations WHERE id = ${rescues.providerOrgId})`,
          ngoName: sql<string>`(SELECT name FROM organizations WHERE id = ${rescues.ngoOrgId})`,
        })
        .from(incidentReports)
        .innerJoin(rescues, eq(rescues.id, incidentReports.rescueId))
        .innerJoin(foodListings, eq(foodListings.id, rescues.listingId))
        .where(status === 'ALL' ? undefined : eq(incidentReports.status, status))
        // Open, blocking and severe first, then oldest first.
        .orderBy(desc(incidentReports.blocking), sql`${incidentReports.severity} DESC`, asc(incidentReports.createdAt))
        .limit(200);
      return rows.map((r) => ({ ...publicIncident(r.i), listingTitle: r.listingTitle, rescueStatus: r.rescueStatus, providerName: r.providerName, ngoName: r.ngoName }));
    },

    async detail(actor: Actor, id: string) {
      if (actor.platformRole !== 'admin') throw errors.forbidden();
      const [i] = await db.select().from(incidentReports).where(eq(incidentReports.id, id));
      if (!i) throw errors.notFound('Incident not found.');
      const evidence = await db
        .select({ id: incidentEvidence.id, mimeType: incidentEvidence.mimeType, sizeBytes: incidentEvidence.sizeBytes, createdAt: incidentEvidence.createdAt })
        .from(incidentEvidence)
        .where(eq(incidentEvidence.incidentId, id))
        .orderBy(asc(incidentEvidence.createdAt));
      return { incident: publicIncident(i), evidence };
    },

    /**
     * An admin closes an incident, optionally acting on the rescue in the same locked transaction. The report itself is
     * immutable; only the resolution is recorded, once, with the admin's identity, and mirrored into the audit history.
     * A rescue can never be completed by anyone but the NGO's confirmation or an admin's explicit COMPLETE_WITH_QUANTITY.
     */
    async resolve(actor: Actor, incidentId: string, input: { resolution: Resolution; note: string; deliveredServings?: number }) {
      if (actor.platformRole !== 'admin') throw errors.forbidden();
      const [found] = await db.select({ rescueId: incidentReports.rescueId }).from(incidentReports).where(eq(incidentReports.id, incidentId));
      if (!found) throw errors.notFound('Incident not found.');

      return core.withRescue(actor, found.rescueId, 'admin', undefined, async (ctx) => {
        const [inc] = await ctx.tx.select().from(incidentReports).where(eq(incidentReports.id, incidentId)).for('update');
        if (!inc) return { error: errors.notFound('Incident not found.') };
        if (inc.status === 'RESOLVED') {
          if (inc.resolutionCode === input.resolution) return { incident: publicIncident(inc), changed: false };
          return { error: new AppError(409, 'INCIDENT_ALREADY_RESOLVED', 'This incident was already resolved differently.', { resolutionCode: inc.resolutionCode }) };
        }

        const title = `Incident resolved: ${ctx.listing.title}`;
        switch (input.resolution) {
          case 'NO_ACTION':
            break;
          case 'REASSIGN_RUNNER': {
            if (ctx.rescue.status !== 'PICKUP_ASSIGNED' || ctx.rescue.transportMode !== 'RUNNER' || !(await core.activeAssignment(ctx.tx, ctx.rescue.id))) {
              return { error: invalidTransition(ctx.rescue.status, 'reassign the runner') };
            }
            await core.apply(ctx, 'ADMIN_REASSIGN', actor, {
              reason: input.note,
              patch: { runnerBy: runnerSearchDeadline(ctx.now, ctx.listing.pickupDeadline, settings) },
              notifyText: { title, body: 'An administrator replaced the runner after an incident. We are looking for another.' },
            });
            await runners.startSearch(ctx);
            break;
          }
          case 'CANCEL_RESCUE': {
            if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_CANCEL')) return { error: invalidTransition(ctx.rescue.status, 'cancel it') };
            await core.apply(ctx, 'ADMIN_CANCEL', actor, { reason: input.note, notifyText: { title, body: `An administrator cancelled the rescue. Reason: ${input.note}` } });
            await core.releaseListing(ctx);
            break;
          }
          case 'FAIL_DELIVERY': {
            if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_FAIL')) return { error: invalidTransition(ctx.rescue.status, 'mark the delivery failed') };
            await core.apply(ctx, 'ADMIN_FAIL', actor, { reason: input.note, notifyText: { title, body: `An administrator recorded this delivery as failed. Reason: ${input.note}` } });
            break;
          }
          case 'COMPLETE_WITH_QUANTITY': {
            if (!nextRescueStatus(ctx.rescue.status, 'ADMIN_RESOLVE')) return { error: invalidTransition(ctx.rescue.status, 'complete it') };
            if (input.deliveredServings === undefined) return { error: fieldErrors({ deliveredServings: 'Enter how many servings were actually received.' }) };
            if (input.deliveredServings > (ctx.rescue.collectedServings ?? 0)) {
              return { error: fieldErrors({ deliveredServings: `Cannot exceed the ${ctx.rescue.collectedServings} servings collected.` }) };
            }
            await core.apply(ctx, 'ADMIN_RESOLVE', actor, {
              reason: input.note,
              patch: { deliveredServings: input.deliveredServings, completedAt: ctx.now, closedAt: ctx.now },
              metadata: { deliveredServings: input.deliveredServings },
              notifyText: { title, body: 'An administrator recorded the outcome of this rescue.' },
            });
            break;
          }
        }

        const [done] = await ctx.tx
          .update(incidentReports)
          .set({ status: 'RESOLVED', resolvedBy: actor.id, resolvedAt: ctx.now, resolutionCode: input.resolution, resolutionNote: input.note })
          .where(eq(incidentReports.id, incidentId))
          .returning();
        const eventId = await core.recordEvent(ctx, {
          rescueId: ctx.rescue.id,
          eventType: 'INCIDENT_RESOLVED',
          from: null,
          to: null,
          actor,
          reason: input.note,
          metadata: { incidentId, resolution: input.resolution },
        });
        // Tell the reporter and both organisations, whatever the resolution did to the rescue.
        const runnerIds = await ctx.tx.execute(sql`SELECT DISTINCT runner_user_id FROM rescue_assignments WHERE rescue_id = ${ctx.rescue.id}::uuid`);
        await core.notify(
          ctx,
          eventId,
          ctx.rescue.id,
          [ctx.rescue.providerOrgId, ctx.rescue.ngoOrgId],
          actor.id,
          title,
          'An administrator resolved the reported problem. Open the rescue for details.',
          [inc.reporterUserId, ...(runnerIds.rows as { runner_user_id: string }[]).map((r) => r.runner_user_id)],
        );
        return { incident: publicIncident(done!), rescue: await core.view(ctx.rescue, 'admin', ctx.now, ctx.tx, actor.id), changed: true };
      });
    },
  };
}

export type IncidentService = ReturnType<typeof createIncidentService>;
