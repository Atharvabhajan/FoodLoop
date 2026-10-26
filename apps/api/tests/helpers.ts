import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import type { EscalationService } from '../src/modules/escalation/service.js';
import { users } from '../src/db/schema.js';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env is optional when variables are already in the environment.
}

export const PASSWORD = 'Test-Password-123';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  return url;
}

/** The least-privilege role the application under test connects as (created by tests/global-setup.ts). */
export const TEST_RUNTIME_ROLE = process.env.TEST_RUNTIME_ROLE ?? 'foodloop_runtime_test';

export function testRuntimeUrl(): string {
  const url = process.env.TEST_RUNTIME_DATABASE_URL;
  if (!url) throw new Error('TEST_RUNTIME_DATABASE_URL is not set: tests/global-setup.ts creates it.');
  return url;
}

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testRuntimeUrl(),
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    BCRYPT_COST: '4',
    RATE_LIMIT_ENABLED: 'false',
    // The production default is the specification's T+3 minutes. Tests start the first wave at publish so every existing
    // flow that expects an NGO to hear about a listing exercises the escalation code; escalation tests set their own schedule.
    ESCALATION_WAVE1_MINUTES: '0',
    STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'foodloop-test-')),
    ...overrides,
  });
}

export function setup(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  // `db` is the PRIVILEGED connection, used by tests for fixtures and assertions (and TRUNCATE between tests).
  // The application itself runs on `runtime`, the least-privilege role, exactly as it does in production.
  const { db, pool } = createDb(testDatabaseUrl());
  const runtime = createDb(config.DATABASE_URL);
  let escalation!: EscalationService;
  const app = createApp({ config, db: runtime.db, pool: runtime.pool, onEscalationService: (s) => (escalation = s) });
  const endAdmin = pool.end.bind(pool);
  pool.end = (async () => {
    await runtime.pool.end();
    await endAdmin();
  }) as typeof pool.end;
  return { config, db, pool, app, runtime, escalation };
}

export type Ctx = ReturnType<typeof setup>;

export async function resetData(db: Ctx['db']) {
  await db.execute(
    sql`TRUNCATE TABLE escalation_recipients, escalation_steps, retention_runs, incident_evidence, incident_reports, rescue_locations, rescue_assignments, rescue_events, rescues, notifications, match_candidates, listing_events, food_listings, ngo_requirements, verification_events, verification_documents, sessions, volunteer_profiles, organization_members, organizations, users RESTART IDENTITY CASCADE`,
  );
}

export type Role = 'provider' | 'ngo' | 'runner' | 'admin';

let counter = 0;
export function emailFor(role: Role) {
  counter += 1;
  return `${role}${counter}@example.test`;
}

/** Creates an account (admins directly in the DB, since public registration blocks them) and returns a signed-in agent. */
export async function signedInAgent(ctx: Ctx, role: Role) {
  const email = emailFor(role);
  const agent = request.agent(ctx.app);
  let organizationId: string | undefined;
  if (role === 'admin') {
    await ctx.db.insert(users).values({
      name: 'Test Admin',
      email,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      platformRole: 'admin',
    });
    const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
  } else {
    const res = await agent.post('/api/v1/auth/register').send({
      name: `Test ${role}`,
      email,
      password: PASSWORD,
      role,
      ...(role === 'runner' ? {} : { organizationName: `Test ${role} org` }),
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    organizationId = res.body.data.user.memberships[0]?.organizationId;
  }
  return { agent, email, organizationId };
}

export const completeProfile = {
  contactName: 'Asha Rao',
  contactEmail: 'asha@example.test',
  contactPhone: '+91 98765 43210',
  addressLine: '12 Market Road',
  city: 'Pune',
  latitude: 18.5204,
  longitude: 73.8567,
};

export const pdfBytes = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const pngBytes = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

export async function uploadDoc(
  agent: Agent,
  orgId: string,
  opts: { type?: string; filename?: string; data?: Buffer; contentType?: string } = {},
) {
  return agent
    .post(`/api/v1/organizations/${orgId}/documents`)
    .field('documentType', opts.type ?? 'REGISTRATION_CERTIFICATE')
    .attach('file', opts.data ?? pdfBytes(), {
      filename: opts.filename ?? 'certificate.pdf',
      contentType: opts.contentType ?? 'application/pdf',
    });
}

/** Fills the profile and uploads the required document, ready to submit. */
export async function prepareApplication(agent: Agent, orgId: string) {
  const patch = await agent.patch(`/api/v1/organizations/${orgId}`).send(completeProfile);
  if (patch.status !== 200) throw new Error(`profile update failed: ${JSON.stringify(patch.body)}`);
  const up = await uploadDoc(agent, orgId);
  if (up.status !== 201) throw new Error(`upload failed: ${JSON.stringify(up.body)}`);
}

export async function submitApplication(agent: Agent, orgId: string) {
  await prepareApplication(agent, orgId);
  const res = await agent.post(`/api/v1/organizations/${orgId}/submit`);
  if (res.status !== 200) throw new Error(`submit failed: ${JSON.stringify(res.body)}`);
  return res.body.data.organization as { submissionNumber: number };
}

/**
 * Sends a hand-built multipart body so the filename reaches the server exactly as written.
 * (superagent/form-data would strip path components before sending, hiding traversal attempts.)
 */
export async function rawUpload(agent: Agent, orgId: string, filename: string, data: Buffer = pdfBytes()) {
  const boundary = '----foodloop-test-boundary';
  const CRLF = '\r\n';
  const head = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="documentType"',
    '',
    'OTHER',
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/pdf',
    '',
    '',
  ].join(CRLF);
  const tail = `${CRLF}--${boundary}--${CRLF}`;
  return agent
    .post(`/api/v1/organizations/${orgId}/documents`)
    .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
    .send(Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(tail, 'latin1')]).toString('latin1'));
}

export async function verifyOrg(ctx: Ctx, orgId: string | undefined) {
  await ctx.db.execute(sql`UPDATE organizations SET verification_status = 'VERIFIED' WHERE id = ${orgId}::uuid`);
}

/** A signed-in provider or NGO whose organization is already VERIFIED. */
export async function verifiedAgent(ctx: Ctx, role: 'provider' | 'ngo') {
  const who = await signedInAgent(ctx, role);
  await verifyOrg(ctx, who.organizationId);
  return who;
}

export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

export function listingBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Vegetable Biryani',
    description: 'Freshly cooked, packed in boxes.',
    foodCategory: 'COOKED_MEALS',
    servings: 45,
    estimatedKg: 18,
    preparedAt: minutesFromNow(-30),
    pickupStart: minutesFromNow(10),
    pickupDeadline: minutesFromNow(180),
    addressLine: '12 Secret Lane, Block C',
    city: 'Pune',
    latitude: 18.52043,
    longitude: 73.85674,
    packaging: 'INDIVIDUAL_BOXES',
    dietaryTags: ['VEGETARIAN'],
    allergenNotes: 'Contains dairy',
    transportRequired: true,
    ...overrides,
  };
}

export async function createListing(agent: Agent, overrides: Record<string, unknown> = {}) {
  const res = await agent.post('/api/v1/listings').send(listingBody(overrides));
  if (res.status !== 201) throw new Error(`create listing failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.listing as { id: string; status: string };
}

export async function publishListing(agent: Agent, id: string) {
  return agent.post(`/api/v1/listings/${id}/publish`).send({ declarationAccepted: true });
}

/** Creates and publishes a listing in one step. */
export async function availableListing(agent: Agent, overrides: Record<string, unknown> = {}) {
  const l = await createListing(agent, overrides);
  const res = await publishListing(agent, l.id);
  if (res.status !== 200) throw new Error(`publish failed: ${res.status} ${JSON.stringify(res.body)}`);
  return l;
}

export function requirementBody(overrides: Record<string, unknown> = {}) {
  return {
    foodCategories: ['COOKED_MEALS', 'BAKERY'],
    neededServings: 40,
    capacityServings: 60,
    serviceRadiusKm: 5,
    availableFrom: minutesFromNow(-60),
    availableTo: minutesFromNow(60 * 24 * 7),
    ...overrides,
  };
}

/** Provider coordinates used by listingBody(). */
export const PROVIDER_POINT = { latitude: 18.52043, longitude: 73.85674 };

/** A point exactly `meters` away from `from` along `bearingDeg` (0 = north, 90 = east), computed by PostGIS. */
export async function pointAt(ctx: Ctx, from: { latitude: number; longitude: number }, meters: number, bearingDeg = 90) {
  const r = await ctx.db.execute(sql`
    SELECT ST_Y(p::geometry) AS latitude, ST_X(p::geometry) AS longitude
      FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint(${from.longitude}, ${from.latitude}), 4326)::geography, ${meters}::float8, radians(${bearingDeg}::float8)) AS p) t`);
  return r.rows[0] as { latitude: number; longitude: number };
}

export async function setOrgCoords(ctx: Ctx, orgId: string | undefined, point: { latitude: number; longitude: number } | null) {
  await ctx.db.execute(
    sql`UPDATE organizations SET latitude = ${point?.latitude ?? null}, longitude = ${point?.longitude ?? null} WHERE id = ${orgId}::uuid`,
  );
}

/**
 * A verified NGO with coordinates and an active requirement. `metersAway` places it that far east of the
 * provider; pass `point: null` for an NGO without coordinates. Requirement fields can be overridden.
 */
export async function matchedNgo(
  ctx: Ctx,
  opts: { metersAway?: number; bearing?: number; point?: { latitude: number; longitude: number } | null; requirement?: Record<string, unknown> | null } = {},
) {
  const who = await verifiedAgent(ctx, 'ngo');
  const point = opts.point !== undefined ? opts.point : await pointAt(ctx, PROVIDER_POINT, opts.metersAway ?? 2000, opts.bearing ?? 90);
  await setOrgCoords(ctx, who.organizationId, point);
  if (opts.requirement !== null) {
    const res = await who.agent.post('/api/v1/ngo-requirements').send(requirementBody(opts.requirement ?? {}));
    if (res.status !== 201) throw new Error(`requirement failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return who;
}

export async function dbCandidates(ctx: Ctx, listingId: string) {
  const r = await ctx.db.execute(sql`SELECT ngo_org_id, eligible, score, rank, distance_m FROM match_candidates WHERE listing_id = ${listingId}::uuid ORDER BY rank NULLS LAST, ngo_org_id`);
  return r.rows as { ngo_org_id: string; eligible: boolean; score: number | null; rank: number | null; distance_m: number | null }[];
}
