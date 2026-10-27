/**
 * Additive demo fixtures (npm run db:seed:demo-fixtures).
 *
 * Unlike db:seed this NEVER touches an existing user, organization, listing, rescue or requirement: it only adds the
 * fixtures that are missing, found by name, so running it again adds and changes nothing.
 *
 *   --dry-run   print the target database, record counts and the plan, then stop (writes nothing)
 *   --live      also re-create the short-lived stage fixtures (a reserved rescue lasts 15 minutes by design) whose
 *               previous copy has run its course. Use it right before a demo.
 *
 * Two mechanisms, both through the real rules:
 *   - Historic and account fixtures (verification states, a third runner, an expired and a pickup-failed rescue) are written
 *     directly with the privileged connection, with consistent timestamps and audit events, in the style of db:seed.
 *   - Everything that has a live lifecycle (listings, matching, escalation waves, rescues at every stage, incidents, evidence)
 *     is driven through the running API as the demo accounts, so every rule, audit event, notification and deadline is the
 *     application's own. This needs the API running against the same database (it is checked).
 * Demo records are named "Demo • ...". Passwords come from DEMO_PASSWORD; nothing secret is printed or stored (pickup codes
 * live only in memory for the few calls that need them).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { DEFAULT_STORAGE_DIR } from '../config.js';
import { LocalDiskStorage } from '../storage/index.js';
import { describeTarget, resolveAdminUrl } from './admin-url.js';
import { createDb, type Db } from './client.js';
import {
  foodListings,
  listingEvents,
  organizationMembers,
  organizations,
  rescueEvents,
  rescues,
  users,
  verificationDocuments,
  verificationEvents,
  volunteerProfiles,
} from './schema.js';

const HOUR = 3_600_000;
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const LIVE = args.has('--live');
const E = (local: string) => `${local}@demo.foodloop.test`;

const PROVIDER = E('provider');
const HOPE = E('ngo');
const HANDS = E('ngo3');
const RUNNER = E('runner');
const ADMIN = E('admin');
const RUNNER3_EMAIL = E('demo.runner3');

const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const COUNT_TABLES = [
  'users', 'organizations', 'verification_events', 'verification_documents', 'food_listings', 'listing_events', 'ngo_requirements',
  'match_candidates', 'notifications', 'rescues', 'rescue_events', 'rescue_assignments', 'incident_reports', 'incident_evidence',
  'escalation_steps', 'escalation_recipients', 'volunteer_profiles',
] as const;

async function counts(db: Db) {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) out[t] = ((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`))).rows[0] as { n: number }).n;
  const imp = (await db.execute(sql`SELECT count(*)::int AS rescues, coalesce(sum(delivered_servings), 0)::int AS servings FROM rescues WHERE status = 'COMPLETED'`)).rows[0] as { rescues: number; servings: number };
  return { tables: out, impact: imp };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* 1. Account and verification-state fixtures (direct)                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface OrgFixture {
  email: string;
  userName: string;
  role: 'provider' | 'ngo';
  org: { name: string; type: 'PROVIDER' | 'NGO'; status: 'RESUBMISSION_REQUESTED' | 'REJECTED'; reason: string; contactName: string; contactEmail: string; contactPhone: string; addressLine: string; city: string; latitude: number; longitude: number };
  note: string;
}

const ORG_FIXTURES: OrgFixture[] = [
  {
    email: E('demo.greenfield'),
    userName: 'Demo • Greenfield Owner',
    role: 'provider',
    note: 'verification: resubmission requested',
    org: {
      name: 'Demo • Greenfield Caterers', type: 'PROVIDER', status: 'RESUBMISSION_REQUESTED',
      reason: 'The food safety licence scan is blurred and expires before the date on the application. Please upload a clear, current copy and submit again.',
      contactName: 'Demo • Greenfield Owner', contactEmail: 'greenfield@demo.foodloop.test', contactPhone: '+91 20 5550 0606',
      addressLine: '14 Orchard Road', city: 'Pune', latitude: 18.5018, longitude: 73.8636,
    },
  },
  {
    email: E('demo.sunrise'),
    userName: 'Demo • Sunrise Lead',
    role: 'ngo',
    note: 'verification: rejected',
    org: {
      name: 'Demo • Sunrise Relief Society', type: 'NGO', status: 'REJECTED',
      reason: 'The registration number on the certificate could not be matched to a registered charity, and its address differs from the application. You can apply again with matching documents.',
      contactName: 'Demo • Sunrise Lead', contactEmail: 'sunrise@demo.foodloop.test', contactPhone: '+91 20 5550 0707',
      addressLine: '3 Lake View', city: 'Pune', latitude: 18.5679, longitude: 73.9143,
    },
  },
];

const RUNNER3 = {
  email: RUNNER3_EMAIL,
  name: 'Demo • Kabir (Rescue Runner)',
  profile: { vehicleType: 'CAR' as const, capacityKg: 60, radiusKm: 12, latitude: 18.53, longitude: 73.86 },
};

async function userId(db: Db, email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  return row?.id;
}
async function orgByName(db: Db, name: string) {
  const [row] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name));
  return row?.id;
}
async function listingByTitle(db: Db, providerOrgId: string, title: string) {
  const [row] = await db.select({ id: foodListings.id }).from(foodListings).where(and(eq(foodListings.providerOrgId, providerOrgId), eq(foodListings.title, title)));
  return row?.id;
}

/** Historic rescues that ended in a state only time can produce (the deadline passed): written directly with a coherent timeline. */
interface HistoricRescue {
  title: string;
  ngoEmail: string;
  outcome: 'EXPIRED' | 'PICKUP_FAILED';
  note: string;
}
const HISTORIC: HistoricRescue[] = [
  { title: 'Demo • Evening Curry Boxes (provider did not respond)', ngoEmail: HANDS, outcome: 'EXPIRED', note: 'rescue expired: the provider never confirmed the hand-off' },
  { title: 'Demo • Roti & Sabzi Packs (pickup not verified)', ngoEmail: HOPE, outcome: 'PICKUP_FAILED', note: 'rescue failed: pickup was never verified before the window closed' },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* 2. Lifecycle fixtures (through the API)                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

type Cat = 'COOKED_MEALS' | 'BAKERY' | 'PRODUCE';
type Stage = 'unaccepted' | 'awaiting_runner' | 'reserved' | 'pickup_assigned_incident' | 'pickup_confirmed' | 'in_transit' | 'delivered' | 'cancelled' | 'delivery_failed' | 'completed_with_incident';

interface Fixture {
  title: string;
  stage: Stage;
  /** Short-lived stage: only re-created by --live. */
  live: boolean;
  cat: Cat;
  servings: number;
  kg: number;
  packaging: 'INDIVIDUAL_BOXES' | 'BULK_CONTAINERS' | 'WRAPPED' | 'LOOSE';
  tags: string[];
  allergen?: string;
  hours: number;
  lat: number;
  lng: number;
  transport: boolean;
  photo: string;
  note: string;
}

const FIXTURES: Fixture[] = [
  { title: 'Demo • Paneer & Dal Meal Boxes', stage: 'unaccepted', live: true, cat: 'COOKED_MEALS', servings: 60, kg: 24, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGETARIAN', 'CONTAINS_DAIRY'], allergen: 'Contains dairy.', hours: 30, lat: 18.5231, lng: 73.8499, transport: true, photo: 'cooked-thali', note: 'live, unaccepted: both verified NGOs are eligible at different distances' },
  { title: 'Demo • Fresh Bread & Buns', stage: 'unaccepted', live: true, cat: 'BAKERY', servings: 40, kg: 12, packaging: 'WRAPPED', tags: ['VEGETARIAN', 'JAIN'], hours: 26, lat: 18.5262, lng: 73.8583, transport: false, photo: 'bakery-loaves', note: 'live, unaccepted: only Hope Community Kitchen takes bakery' },
  { title: 'Demo • Seasonal Vegetable Crates', stage: 'unaccepted', live: true, cat: 'PRODUCE', servings: 50, kg: 30, packaging: 'LOOSE', tags: ['VEGAN', 'GLUTEN_FREE'], hours: 30, lat: 18.5187, lng: 73.8651, transport: true, photo: 'produce-market', note: 'live, unaccepted: only Helping Hands takes produce (Hope is shown a category mismatch)' },
  { title: 'Demo • Rice & Sambar Trays', stage: 'awaiting_runner', live: true, cat: 'COOKED_MEALS', servings: 40, kg: 16, packaging: 'BULK_CONTAINERS', tags: ['VEGETARIAN'], hours: 30, lat: 18.5204, lng: 73.8567, transport: true, photo: 'cooked-plate', note: 'AWAITING_RUNNER: an open job for Aarav (bicycle, 25 kg); too heavy for Meera (scooter, 2 kg)' },
  { title: 'Demo • Fruit & Salad Cups', stage: 'reserved', live: true, cat: 'PRODUCE', servings: 20, kg: 6, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGAN'], hours: 30, lat: 18.5204, lng: 73.8567, transport: false, photo: 'produce-market', note: 'RESERVED: waiting for the provider to confirm (15 minutes by design)' },
  { title: 'Demo • Veg Sandwich Platters', stage: 'pickup_assigned_incident', live: true, cat: 'BAKERY', servings: 25, kg: 8, packaging: 'WRAPPED', tags: ['VEGETARIAN'], hours: 36, lat: 18.5204, lng: 73.8567, transport: false, photo: 'bakery-trays', note: 'PICKUP_ASSIGNED with an open blocking incident: the admin must act' },
  { title: 'Demo • Khichdi Bulk Pot', stage: 'pickup_confirmed', live: true, cat: 'COOKED_MEALS', servings: 30, kg: 12, packaging: 'BULK_CONTAINERS', tags: ['VEGETARIAN'], hours: 36, lat: 18.5204, lng: 73.8567, transport: false, photo: 'cooked-thali', note: 'PICKUP_CONFIRMED: collected by the NGO, waiting for it to confirm receipt' },
  { title: 'Demo • Pulao & Raita Boxes', stage: 'in_transit', live: true, cat: 'COOKED_MEALS', servings: 28, kg: 11, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGETARIAN', 'CONTAINS_DAIRY'], hours: 36, lat: 18.5204, lng: 73.8567, transport: true, photo: 'cooked-plate', note: 'IN_TRANSIT: carried by Kabir, the third demo runner' },
  { title: 'Demo • Idli & Sambar Boxes', stage: 'delivered', live: true, cat: 'COOKED_MEALS', servings: 26, kg: 10, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGAN'], hours: 36, lat: 18.5204, lng: 73.8567, transport: true, photo: 'cooked-thali', note: 'DELIVERED: handed over by Aarav, waiting for the NGO to confirm the quantity' },
  { title: 'Demo • Soup Cans (NGO cancelled)', stage: 'cancelled', live: false, cat: 'COOKED_MEALS', servings: 22, kg: 9, packaging: 'BULK_CONTAINERS', tags: ['VEGETARIAN'], hours: 30, lat: 18.5204, lng: 73.8567, transport: false, photo: 'cooked-plate', note: 'rescue CANCELLED by the NGO with a reason; the provider then cancelled the listing' },
  { title: 'Demo • Wrapped Meals (delivery failed)', stage: 'delivery_failed', live: false, cat: 'COOKED_MEALS', servings: 18, kg: 7, packaging: 'WRAPPED', tags: ['VEGETARIAN'], hours: 30, lat: 18.5204, lng: 73.8567, transport: false, photo: 'packaged-tiffin', note: 'DELIVERY_FAILED: an admin recorded that custody was lost' },
  { title: 'Demo • Evening Meal Share (completed, resolved incident)', stage: 'completed_with_incident', live: false, cat: 'COOKED_MEALS', servings: 20, kg: 8, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGETARIAN'], hours: 30, lat: 18.5204, lng: 73.8567, transport: false, photo: 'cooked-thali', note: 'COMPLETED (18 of 20 received) with a resolved incident and a photo of evidence' },
];

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${message} [${code}]`);
  }
}

class Session {
  private cookie = '';
  constructor(private readonly base: string, readonly email: string) {}

  async login(password: string) {
    const res = await fetch(`${this.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: this.email, password }) });
    if (!res.ok) throw new Error(`Could not sign in as ${this.email} (HTTP ${res.status}). Is DEMO_PASSWORD the password this database's accounts use?`);
    this.cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return this;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { Cookie: this.cookie, ...(form ? {} : { 'Content-Type': 'application/json' }) },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; code?: string; message?: string } | null;
      if (res.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new ApiError(res.status, json?.code ?? 'HTTP_ERROR', `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}: ${json?.message ?? res.status}`);
      await sleep(120);
      return json!.data as T;
    }
    throw new Error(`${method} ${path}: still rate limited after retries`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PHOTO_DIR = new URL('../../../web/public/photos/', import.meta.url);
const photoForm = async (name: string) => {
  const bytes = await readFile(new URL(`${name}.jpg`, PHOTO_DIR));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), `${name}.jpg`);
  return form;
};

/* ------------------------------------------------------------------------------------------------------------------ */

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to add demo fixtures when NODE_ENV=production.');
  const url = resolveAdminUrl();
  const { db, pool } = createDb(url);
  try {
    const [target] = (await db.execute(sql`SELECT current_database() AS db, current_user AS usr`)).rows as { db: string; usr: string }[];
    console.log(`Target database: ${target!.db} (connected as ${target!.usr}) [${describeTarget(url).replace(/^[^@]*@/, '')}]`);
    if (!DRY) console.log('Mode: additive. Existing records are never changed; missing fixtures are added.');
    const before = await counts(db);
    console.log('\nCurrent counts:', JSON.stringify(before.tables));
    console.log(`Impact now: ${before.impact.rescues} completed rescues, ${before.impact.servings} servings delivered`);

    const providerOrg = await orgByName(db, 'Campus Canteen');
    const hopeOrg = (await db.select({ id: organizationMembers.organizationId }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(sql`lower(${users.email}) = ${HOPE}`))[0]?.id;
    const handsOrg = (await db.select({ id: organizationMembers.organizationId }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(sql`lower(${users.email}) = ${HANDS}`))[0]?.id;
    if (!providerOrg || !hopeOrg || !handsOrg) throw new Error('The existing demo accounts (provider@, ngo@, ngo3@ and their organizations) are not in this database. Run npm run db:seed first.');

    /* ---------------- plan ---------------- */
    const plan: string[] = [];
    const todo = { orgs: [] as OrgFixture[], runner3: false, historic: [] as HistoricRescue[], api: [] as Fixture[] };
    /** Listings a previous interrupted run published but could not finish: resumed instead of duplicated. */
    const resume = new Map<string, string>();
    for (const f of ORG_FIXTURES) if (!(await orgByName(db, f.org.name))) { todo.orgs.push(f); plan.push(`account + organization: ${f.org.name} (${f.note})`); }
    if (!(await userId(db, RUNNER3.email))) { todo.runner3 = true; plan.push(`runner account: ${RUNNER3.name} (car, 60 kg)`); }
    for (const h of HISTORIC) if (!(await listingByTitle(db, providerOrg, h.title))) { todo.historic.push(h); plan.push(`historic rescue: ${h.title} (${h.note})`); }
    for (const f of FIXTURES) {
      const id = await listingByTitle(db, providerOrg, f.title);
      let needed = !id;
      if (id && f.stage !== 'unaccepted') {
        const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM rescues WHERE listing_id = ${id}::uuid`)).rows as { n: number }[];
        const [l] = (await db.execute(sql`SELECT status FROM food_listings WHERE id = ${id}::uuid`)).rows as { status: string }[];
        if (r!.n === 0 && l!.status === 'AVAILABLE') {
          resume.set(f.title, id);
          needed = true;
        }
      }
      if (id && LIVE && f.live) {
        const [active] = (await db.execute(sql`
          SELECT count(*)::int AS n FROM food_listings l WHERE l.provider_org_id = ${providerOrg}::uuid AND l.title = ${f.title}
            AND (CASE WHEN ${f.stage} = 'unaccepted' THEN (l.status = 'AVAILABLE' AND l.pickup_deadline > now())
                 ELSE EXISTS (SELECT 1 FROM rescues r WHERE r.listing_id = l.id AND r.status IN ('RESERVED','AWAITING_RUNNER','PICKUP_ASSIGNED','PICKUP_CONFIRMED','IN_TRANSIT','DELIVERED','RECIPIENT_CONFIRMED')) END)`)).rows as { n: number }[];
        needed = active!.n === 0;
      }
      if (needed) { todo.api.push(f); plan.push(`${resume.has(f.title) ? 'finish (an earlier run was interrupted)' : f.live ? 'live' : 'durable'} fixture: ${f.title} (${f.note})`); }
    }
    console.log(`\nPlanned additions (${plan.length}):`);
    for (const p of plan) console.log(`  + ${p}`);
    if (plan.length === 0) console.log('  nothing: every fixture is already present.');
    if (DRY || plan.length === 0) return;

    const password = process.env.DEMO_PASSWORD;
    if (!password || password.length < 10) throw new Error('Set DEMO_PASSWORD in .env (the password the demo accounts already use).');
    const storage = new LocalDiskStorage(process.env.STORAGE_DIR ?? DEFAULT_STORAGE_DIR);
    const adminId = await userId(db, ADMIN);
    if (!adminId) throw new Error('admin@demo.foodloop.test is missing: run npm run db:seed first.');

    /* ---------------- direct fixtures ---------------- */
    const hash = todo.orgs.length || todo.runner3 ? await bcrypt.hash(password, Number(process.env.BCRYPT_COST ?? 12)) : '';
    for (const f of todo.orgs) {
      await db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({ name: f.userName, email: f.email, passwordHash: hash, platformRole: f.role }).returning({ id: users.id });
        const at = (h: number) => new Date(Date.now() - h * HOUR);
        const o = f.org;
        const [org] = await tx.insert(organizations).values({
          type: o.type, name: o.name, verificationStatus: o.status, contactName: o.contactName, contactEmail: o.contactEmail, contactPhone: o.contactPhone,
          addressLine: o.addressLine, city: o.city, latitude: o.latitude, longitude: o.longitude, submissionCount: 1, submittedAt: at(52), statusReason: o.reason,
        }).returning({ id: organizations.id });
        await tx.insert(organizationMembers).values({ userId: u!.id, organizationId: org!.id, memberRole: 'owner' });
        await tx.insert(verificationEvents).values([
          { organizationId: org!.id, action: 'SUBMITTED', fromStatus: 'UNSUBMITTED', toStatus: 'UNDER_REVIEW', actorUserId: u!.id, submissionNumber: 1, createdAt: at(52) },
          { organizationId: org!.id, action: o.status === 'REJECTED' ? 'REJECTED' : 'RESUBMISSION_REQUESTED', fromStatus: 'UNDER_REVIEW', toStatus: o.status, actorUserId: adminId, reason: o.reason, submissionNumber: 1, createdAt: at(30) },
        ]);
        const key = await storage.save(`org-${org!.id}`, 'pdf', SAMPLE_PDF);
        await tx.insert(verificationDocuments).values({
          organizationId: org!.id, documentType: o.status === 'REJECTED' ? 'REGISTRATION_CERTIFICATE' : 'FOOD_SAFETY_LICENSE',
          originalFilename: o.status === 'REJECTED' ? 'demo-registration-certificate.pdf' : 'demo-food-safety-licence.pdf', mimeType: 'application/pdf',
          sizeBytes: SAMPLE_PDF.length, sha256: createHash('sha256').update(SAMPLE_PDF).digest('hex'), storageKey: key,
          reviewStatus: o.status === 'REJECTED' ? 'REJECTED' : 'PENDING', uploadedBy: u!.id,
        });
      });
      console.log(`  added ${f.org.name}`);
    }
    if (todo.runner3) {
      await db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({ name: RUNNER3.name, email: RUNNER3.email, passwordHash: hash, platformRole: 'runner' }).returning({ id: users.id });
        await tx.insert(volunteerProfiles).values({ userId: u!.id, availabilityStatus: 'AVAILABLE', ...RUNNER3.profile });
      });
      console.log(`  added ${RUNNER3.name}`);
    }

    const providerUser = (await userId(db, PROVIDER))!;
    for (const h of todo.historic) {
      const ngoUser = (await userId(db, h.ngoEmail))!;
      const ngoOrg = h.ngoEmail === HOPE ? hopeOrg : handsOrg;
      const at = (hrs: number) => new Date(Date.now() + hrs * HOUR);
      await db.transaction(async (tx) => {
        const failedPickup = h.outcome === 'PICKUP_FAILED';
        const [l] = await tx.insert(foodListings).values({
          providerOrgId: providerOrg, createdBy: providerUser, title: h.title, foodCategory: 'COOKED_MEALS', servings: 24, estimatedKg: 9,
          description: 'Demo history record. Photo-free on purpose: this one ended before any pickup.',
          preparedAt: at(-44), pickupStart: at(-42), pickupDeadline: at(failedPickup ? -26 : -30), addressLine: 'Main Campus, Food Court Block', city: 'Pune',
          latitude: 18.5204, longitude: 73.8567, packaging: 'INDIVIDUAL_BOXES', dietaryTags: ['VEGETARIAN'], transportRequired: false,
          status: 'EXPIRED', publishedAt: at(-44), declarationAcceptedAt: at(-44), expiredAt: at(failedPickup ? -26 : -30),
        }).returning({ id: foodListings.id });
        await tx.insert(listingEvents).values([{ listingId: l!.id, action: 'PUBLISHED', actorUserId: providerUser, createdAt: at(-44) }, { listingId: l!.id, action: 'EXPIRED', actorUserId: null, createdAt: at(failedPickup ? -26 : -30) }]);
        const reserved = at(failedPickup ? -36 : -39);
        const closed = at(failedPickup ? -26.5 : -38.7);
        const [r] = await tx.insert(rescues).values({
          listingId: l!.id, providerOrgId: providerOrg, ngoOrgId: ngoOrg, acceptedBy: ngoUser, status: h.outcome, version: failedPickup ? 3 : 2, servingsOffered: 24,
          reservedAt: reserved, providerConfirmBy: new Date(reserved.getTime() + 0.25 * HOUR), providerConfirmedAt: failedPickup ? new Date(reserved.getTime() + 0.1 * HOUR) : null,
          pickupBy: closed, closedAt: closed, outcomeCode: failedPickup ? 'PICKUP_NOT_VERIFIED' : 'PROVIDER_NO_RESPONSE',
          outcomeReason: failedPickup ? 'Pickup was not verified before the window closed.' : 'The provider did not confirm the hand-off in time.',
        }).returning({ id: rescues.id });
        const steps: [string, string | null, string | null, string, Date][] = failedPickup
          ? [['ACCEPTED', 'RESERVED', ngoUser, 'ngo', reserved], ['STATUS_CHANGED', 'PICKUP_ASSIGNED', providerUser, 'provider', new Date(reserved.getTime() + 0.1 * HOUR)], ['STATUS_CHANGED', 'PICKUP_FAILED', null, 'system', closed]]
          : [['ACCEPTED', 'RESERVED', ngoUser, 'ngo', reserved], ['STATUS_CHANGED', 'EXPIRED', null, 'system', closed]];
        let prev: string | null = null;
        for (const [eventType, to, actor, role, when] of steps) {
          await tx.insert(rescueEvents).values({ rescueId: r!.id, eventType, fromStatus: prev as never, toStatus: to as never, actorUserId: actor, actorRole: role, metadata: {}, createdAt: when });
          prev = to;
        }
      });
      console.log(`  added ${h.title}`);
    }

    /* ---------------- lifecycle fixtures through the API ---------------- */
    if (todo.api.length) {
      const base = `http://localhost:${process.env.API_PORT ?? 4000}/api/v1`;
      const health = await fetch(`${base}/health`).catch(() => null);
      if (!health?.ok) throw new Error(`The API is not reachable at ${base}. Start it (npm run dev) against this database, then run this command again: it will only add what is still missing.`);
      const as = async (email: string) => new Session(base, email).login(password);
      const provider = await as(PROVIDER);
      // The API must be talking to the database we are about to describe: its provider organization has to be the one we found.
      const seen = (await provider.call<{ organizations: { id: string }[] }>('GET', '/organizations')).organizations.map((o) => o.id);
      if (!seen.includes(providerOrg)) throw new Error('The running API is connected to a different database than this command. Aborting before adding anything through it.');
      const hope = await as(HOPE);
      const hands = await as(HANDS);
      const admin = await as(ADMIN);
      const runner = await as(RUNNER);
      const runner3 = await as(RUNNER3.email).catch(() => null);

      const make = async (f: Fixture) => {
        const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
        const created = await provider.call<{ listing: { id: string } }>('POST', '/listings', {
          title: f.title,
          description: `Fictional demo listing. The photo is a bundled demo image, not a real provider upload. ${f.note}.`,
          foodCategory: f.cat, servings: f.servings, estimatedKg: f.kg, preparedAt: iso(-30), pickupStart: iso(5), pickupDeadline: iso(f.hours * 60),
          addressLine: 'Main Campus, Food Court Block', city: 'Pune', latitude: f.lat, longitude: f.lng,
          packaging: f.packaging, dietaryTags: f.tags, ...(f.allergen ? { allergenNotes: f.allergen } : {}), transportRequired: f.transport,
        });
        const id = created.listing.id;
        await provider.call('POST', `/listings/${id}/image`, undefined, await photoForm(f.photo));
        await provider.call('POST', `/listings/${id}/publish`, { declarationAccepted: true });
        return id;
      };
      const accept = async (ngo: Session, listingId: string, mode: 'RUNNER' | 'NGO_PICKUP') =>
        (await ngo.call<{ rescue: { id: string } }>('POST', `/listings/${listingId}/accept`, { transportMode: mode })).rescue.id;
      const confirm = async (rescueId: string) => (await provider.call<{ pickupCode?: string }>('POST', `/rescues/${rescueId}/confirm`, {})).pickupCode;
      const verify = async (who: Session, rescueId: string, code: string | undefined, collected: number) => {
        if (!code) throw new Error('No pickup code was issued, so pickup cannot be verified.');
        await who.call('POST', `/rescues/${rescueId}/pickup/verify`, { code, collectedServings: collected });
      };

      for (const f of todo.api) {
        const listingId = resume.get(f.title) ?? (await make(f));
        let status = 'published (live, unaccepted)';
        switch (f.stage) {
          case 'unaccepted':
            break;
          case 'awaiting_runner': {
            const rid = await accept(hope, listingId, 'RUNNER');
            await confirm(rid);
            status = 'AWAITING_RUNNER';
            break;
          }
          case 'reserved':
            await accept(hands, listingId, 'NGO_PICKUP');
            status = 'RESERVED';
            break;
          case 'pickup_assigned_incident': {
            const rid = await accept(hope, listingId, 'NGO_PICKUP');
            await confirm(rid);
            await hope.call('POST', `/rescues/${rid}/incidents`, { category: 'PICKUP_PROBLEM', severity: 'HIGH', description: 'Demo incident: the provider kitchen was closed when the NGO team arrived, and nobody could be reached by phone.' });
            status = 'PICKUP_ASSIGNED + open blocking incident';
            break;
          }
          case 'pickup_confirmed': {
            const rid = await accept(hands, listingId, 'NGO_PICKUP');
            await verify(hands, rid, await confirm(rid), f.servings);
            status = 'PICKUP_CONFIRMED';
            break;
          }
          case 'in_transit': {
            if (!runner3) throw new Error('The third demo runner could not sign in.');
            const rid = await accept(hope, listingId, 'RUNNER');
            const code = await confirm(rid);
            await runner3.call('POST', `/rescues/${rid}/assign-self`, {});
            await verify(runner3, rid, code, f.servings);
            status = 'IN_TRANSIT';
            break;
          }
          case 'delivered': {
            const rid = await accept(hope, listingId, 'RUNNER');
            const code = await confirm(rid);
            await runner.call('POST', `/rescues/${rid}/assign-self`, {});
            await verify(runner, rid, code, f.servings);
            await runner.call('POST', `/rescues/${rid}/delivery/handover`, { note: 'Demo hand-over at the NGO kitchen door.' });
            status = 'DELIVERED';
            break;
          }
          case 'cancelled': {
            const rid = await accept(hands, listingId, 'NGO_PICKUP');
            await hands.call('POST', `/rescues/${rid}/cancel`, { reason: 'Our kitchen volunteers called in sick, so we cannot collect this today.' });
            await provider.call('POST', `/listings/${listingId}/cancel`, { reason: 'Food no longer available after the NGO cancelled; the kitchen used it internally.' });
            status = 'rescue CANCELLED, listing CANCELLED';
            break;
          }
          case 'delivery_failed': {
            const rid = await accept(hands, listingId, 'NGO_PICKUP');
            await verify(hands, rid, await confirm(rid), f.servings);
            await admin.call('POST', `/rescues/${rid}/admin/fail`, { reason: 'Demo: the NGO could not account for the food after pickup, so custody is recorded as lost.' });
            status = 'DELIVERY_FAILED';
            break;
          }
          case 'completed_with_incident': {
            const rid = await accept(hands, listingId, 'NGO_PICKUP');
            await verify(hands, rid, await confirm(rid), f.servings);
            const inc = await hands.call<{ incident: { id: string } }>('POST', `/rescues/${rid}/incidents`, { category: 'QUANTITY_MISMATCH', severity: 'MEDIUM', description: 'Demo incident: two boxes were missing from the handover, so 18 of the 20 offered servings arrived.' });
            await hands.call('POST', `/rescues/${rid}/incidents/${inc.incident.id}/evidence`, undefined, await photoForm('packaged-tiffin'));
            await admin.call('POST', `/incidents/${inc.incident.id}/resolve`, { resolution: 'NO_ACTION', note: 'Demo review: the provider confirmed two boxes were not packed. The NGO may confirm the 18 servings it received.' });
            await hands.call('POST', `/rescues/${rid}/delivery/confirm`, { deliveredServings: 18 });
            status = 'COMPLETED (18 delivered) + resolved incident with a photo';
            break;
          }
        }
        console.log(`  added ${f.title}: ${status}`);
      }
    }

    const after = await counts(db);
    console.log('\nCounts after:', JSON.stringify(after.tables));
    console.log(`Impact after: ${after.impact.rescues} completed rescues, ${after.impact.servings} servings delivered (was ${before.impact.rescues} / ${before.impact.servings})`);
    const delta = Object.entries(after.tables).filter(([k, v]) => v !== before.tables[k]).map(([k, v]) => `${k} +${v - before.tables[k]!}`);
    console.log(`Rows added: ${delta.join(', ') || 'none'}`);
    console.log('Demo password: the value of DEMO_PASSWORD in your .env (new demo accounts use it too).');
  } finally {
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`Demo fixtures failed: ${err.message}`);
  process.exit(1);
});

