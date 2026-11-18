/**
 * Tester accounts (npm run db:seed:test-accounts).
 *
 * One fresh account per role, onboarded the way a real user would be, plus enough data in each to test that role:
 *   tester.admin@     platform admin (admins cannot self-register, so this one row is written directly, as db:seed does)
 *   tester.provider@  registers, completes the organization profile, uploads a document, submits; tester.admin approves
 *   tester.ngo@       same onboarding, then sets needs, capacity, radius and availability
 *   tester.runner@    registers and sets vehicle, capacity, radius, base location and availability
 * Then, as those accounts through the API: live listings for the NGO to accept, a rescue handed over and waiting for the
 * NGO to confirm, and one completed runner rescue so every impact page has numbers.
 *
 * Additive and idempotent like db:seed:demo-fixtures: accounts are found by email and data by listing title, nothing
 * existing is changed, and an interrupted run resumes where it stopped.
 *   --dry-run   print the target database and the plan, then stop
 *   --live      also re-create short-lived items (live listings, the handed-over rescue) whose previous copy has ended
 * Needs the API running against the same database (checked). Passwords come from DEMO_PASSWORD; nothing secret is printed.
 */
import { readFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { describeTarget, resolveAdminUrl } from './admin-url.js';
import { createDb, type Db } from './client.js';
import { foodListings, organizationMembers, organizations, users } from './schema.js';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const LIVE = args.has('--live');
const E = (local: string) => `tester.${local}@demo.foodloop.test`;

const ADMIN = { email: E('admin'), name: 'Test • Admin (Operations)' };
const PROVIDER = {
  email: E('provider'), name: 'Test • Priya (Kitchen Manager)', role: 'provider' as const,
  org: { name: 'Test • Green Bowl Kitchen', contactName: 'Test • Priya', contactEmail: 'greenbowl@demo.foodloop.test', contactPhone: '+91 20 5550 1101', addressLine: '22 FC Road, Shivajinagar', city: 'Pune', latitude: 18.5236, longitude: 73.8478 },
};
const NGO = {
  email: E('ngo'), name: 'Test • Nikhil (Intake Coordinator)', role: 'ngo' as const,
  org: { name: 'Test • Open Hands Shelter', contactName: 'Test • Nikhil', contactEmail: 'openhands@demo.foodloop.test', contactPhone: '+91 20 5550 1202', addressLine: '9 Ganeshkhind Road', city: 'Pune', latitude: 18.5362, longitude: 73.8401 },
};
const RUNNER = { email: E('runner'), name: 'Test • Riya (Rescue Runner)' };
const RUNNER_PROFILE = { availabilityStatus: 'AVAILABLE', vehicleType: 'SCOOTER', capacityKg: 20, radiusKm: 10, latitude: 18.5281, longitude: 73.8445 };

type Stage = 'live' | 'delivered' | 'completed';
interface Item {
  title: string;
  stage: Stage;
  cat: 'COOKED_MEALS' | 'BAKERY' | 'PRODUCE';
  servings: number;
  kg: number;
  packaging: 'INDIVIDUAL_BOXES' | 'BULK_CONTAINERS' | 'WRAPPED' | 'LOOSE';
  tags: string[];
  transport: boolean;
  photo: string;
  note: string;
}
const ITEMS: Item[] = [
  { title: 'Test • Veg Biryani Trays', stage: 'live', cat: 'COOKED_MEALS', servings: 40, kg: 14, packaging: 'BULK_CONTAINERS', tags: ['VEGETARIAN'], transport: true, photo: 'cooked-plate', note: 'live: accept it as tester.ngo with "a runner", then deliver it as tester.runner' },
  { title: 'Test • Morning Bakery Basket', stage: 'live', cat: 'BAKERY', servings: 25, kg: 6, packaging: 'WRAPPED', tags: ['VEGETARIAN'], transport: false, photo: 'bakery-trays', note: 'live: accept it as tester.ngo and collect it yourselves' },
  { title: 'Test • Fresh Fruit Bowls', stage: 'delivered', cat: 'PRODUCE', servings: 24, kg: 8, packaging: 'INDIVIDUAL_BOXES', tags: ['VEGAN', 'GLUTEN_FREE'], transport: true, photo: 'produce-market', note: 'DELIVERED by tester.runner: tester.ngo confirms how many servings arrived (12 hours)' },
  { title: 'Test • Dal Khichdi Pot', stage: 'completed', cat: 'COOKED_MEALS', servings: 32, kg: 12, packaging: 'BULK_CONTAINERS', tags: ['VEGETARIAN'], transport: true, photo: 'cooked-thali', note: 'COMPLETED by tester.runner, 30 of 32 servings confirmed: impact for all three accounts' },
];

const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PHOTO_DIR = new URL('../../../web/public/photos/', import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Session {
  private cookie = '';
  constructor(private readonly base: string, readonly email: string) {}

  private keep(res: Response) {
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]);
    if (set.length) this.cookie = set.join('; ');
  }
  async login(password: string) {
    const res = await fetch(`${this.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: this.email, password }) });
    if (!res.ok) throw new Error(`Could not sign in as ${this.email} (HTTP ${res.status}).`);
    this.keep(res);
    return this;
  }
  async register(body: Record<string, unknown>) {
    await this.call('POST', '/auth/register', body);
    return this;
  }
  async call<T = unknown>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { Cookie: this.cookie, ...(form ? {} : { 'Content-Type': 'application/json' }) },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const json = (await res.json().catch(() => null)) as { data?: T; code?: string; message?: string } | null;
      if (res.status === 429) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}: ${json?.message ?? res.status} [${json?.code ?? 'HTTP_ERROR'}]`);
      this.keep(res);
      await sleep(120);
      return json!.data as T;
    }
    throw new Error(`${method} ${path}: still rate limited after retries`);
  }
}

const fileForm = (field: Record<string, string>, bytes: Buffer, name: string, type: string) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(field)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  return form;
};

async function userId(db: Db, email: string) {
  const [row] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  return row?.id;
}
async function orgOf(db: Db, email: string) {
  const [row] = await db
    .select({ id: organizations.id, status: organizations.verificationStatus, submissions: organizations.submissionCount })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(sql`lower(${users.email}) = ${email}`);
  return row;
}
async function hasRequirement(db: Db, orgId: string) {
  const [r] = (await db.execute(sql`SELECT count(*)::int AS n FROM ngo_requirements WHERE ngo_org_id = ${orgId}::uuid`)).rows as { n: number }[];
  return r!.n > 0;
}
async function runnerReady(db: Db, uid: string) {
  const [r] = (await db.execute(sql`SELECT vehicle_type IS NOT NULL AS ok FROM volunteer_profiles WHERE user_id = ${uid}::uuid`)).rows as { ok: boolean }[];
  return !!r?.ok;
}
/** Whether an item still needs adding: never added, or (with --live) its short-lived copy has ended. */
async function itemNeeded(db: Db, orgId: string | undefined, it: Item) {
  if (!orgId) return true;
  const [l] = await db.select({ id: foodListings.id }).from(foodListings).where(and(eq(foodListings.providerOrgId, orgId), eq(foodListings.title, it.title)));
  if (!l) return true;
  if (!LIVE || it.stage === 'completed') return false;
  const [active] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM food_listings l WHERE l.provider_org_id = ${orgId}::uuid AND l.title = ${it.title}
      AND (CASE WHEN ${it.stage} = 'live' THEN (l.status = 'AVAILABLE' AND l.pickup_deadline > now())
           ELSE EXISTS (SELECT 1 FROM rescues r WHERE r.listing_id = l.id AND r.status = 'DELIVERED') END)`)).rows as { n: number }[];
  return active!.n === 0;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to add tester accounts when NODE_ENV=production.');
  const url = resolveAdminUrl();
  const { db, pool } = createDb(url);
  try {
    const [target] = (await db.execute(sql`SELECT current_database() AS db, current_user AS usr`)).rows as { db: string; usr: string }[];
    console.log(`Target database: ${target!.db} (connected as ${target!.usr}) [${describeTarget(url).replace(/^[^@]*@/, '')}]`);

    /* ---------------- plan ---------------- */
    const plan: string[] = [];
    const adminMissing = !(await userId(db, ADMIN.email));
    if (adminMissing) plan.push(`admin account: ${ADMIN.email}`);
    for (const a of [PROVIDER, NGO]) {
      const org = await orgOf(db, a.email);
      if (!org) plan.push(`${a.role} account + organization: ${a.org.name} (register, profile, document, submit, approved by tester.admin)`);
      else if (org.status !== 'VERIFIED') plan.push(`finish onboarding ${a.org.name} (now ${org.status})`);
      if (a === NGO && !(org && (await hasRequirement(db, org.id)))) plan.push('NGO needs: cooked meals, bakery and produce; 80 servings needed, capacity 120, 10 km radius, 30 days');
    }
    const runnerId = await userId(db, RUNNER.email);
    if (!runnerId || !(await runnerReady(db, runnerId))) plan.push('runner account: scooter, 20 kg, 10 km radius, available');
    const providerOrg = (await orgOf(db, PROVIDER.email))?.id;
    const items: Item[] = [];
    for (const it of ITEMS) if (await itemNeeded(db, providerOrg, it)) { items.push(it); plan.push(`${it.title}: ${it.note}`); }

    console.log(`\nPlanned additions (${plan.length}):`);
    for (const p of plan) console.log(`  + ${p}`);
    if (plan.length === 0) console.log('  nothing: every tester account and item is already present.');
    if (DRY || plan.length === 0) return;

    const password = process.env.DEMO_PASSWORD;
    if (!password || password.length < 10) throw new Error('Set DEMO_PASSWORD in .env (the tester accounts use it too).');
    const base = `http://localhost:${process.env.API_PORT ?? 4000}/api/v1`;
    if (!(await fetch(`${base}/health`).catch(() => null))?.ok) throw new Error(`The API is not reachable at ${base}. Start it (npm run dev) against this database and run this again.`);

    if (adminMissing) {
      const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_COST ?? 12));
      await db.insert(users).values({ name: ADMIN.name, email: ADMIN.email, passwordHash: hash, platformRole: 'admin' });
      console.log(`  added ${ADMIN.email}`);
    }
    const admin = await new Session(base, ADMIN.email).login(password);
    // The API must be serving the database this command writes to: the admin it just signed in must be ours.
    const me = await admin.call<{ user: { id: string } }>('GET', '/auth/me');
    if (me.user.id !== (await userId(db, ADMIN.email))) throw new Error('The running API is connected to a different database than this command. Aborting.');

    const signIn = async (email: string, registration: Record<string, unknown>) =>
      (await userId(db, email)) ? new Session(base, email).login(password) : new Session(base, email).register({ email, password, ...registration });

    /* ---------------- provider and NGO onboarding ---------------- */
    const sessions: Record<string, Session> = {};
    for (const a of [PROVIDER, NGO]) {
      const s = await signIn(a.email, { name: a.name, role: a.role, organizationName: a.org.name });
      sessions[a.role] = s;
      let org = (await orgOf(db, a.email))!;
      if (org.status === 'UNSUBMITTED' || org.status === 'RESUBMISSION_REQUESTED') {
        // The name was given at registration; the rest of the profile is filled in now.
        const profile = Object.fromEntries(Object.entries(a.org).filter(([k]) => k !== 'name'));
        await s.call('PATCH', `/organizations/${org.id}`, profile);
        const docs = await s.call<{ documents: { documentType: string; reviewStatus: string }[] }>('GET', `/organizations/${org.id}/documents`);
        if (!docs.documents.some((d) => d.documentType === 'REGISTRATION_CERTIFICATE' && d.reviewStatus !== 'REJECTED')) {
          await s.call('POST', `/organizations/${org.id}/documents`, undefined, fileForm({ documentType: 'REGISTRATION_CERTIFICATE' }, SAMPLE_PDF, 'test-registration-certificate.pdf', 'application/pdf'));
        }
        await s.call('POST', `/organizations/${org.id}/submit`, {});
        org = (await orgOf(db, a.email))!;
      }
      if (org.status === 'UNDER_REVIEW') {
        await admin.call('POST', `/admin/verifications/${org.id}/decision`, { decision: 'APPROVE', submissionNumber: org.submissions });
        org = (await orgOf(db, a.email))!;
      }
      if (org.status !== 'VERIFIED') throw new Error(`${a.org.name} is ${org.status}; this command only onboards new tester organizations and will not override a decision.`);
      console.log(`  ${a.org.name}: verified (approved by tester.admin)`);
      if (a === NGO && !(await hasRequirement(db, org.id))) {
        await s.call('POST', '/ngo-requirements', {
          foodCategories: ['COOKED_MEALS', 'BAKERY', 'PRODUCE'], neededServings: 80, capacityServings: 120, serviceRadiusKm: 10,
          availableFrom: new Date(Date.now() - 3_600_000).toISOString(), availableTo: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          dietaryMustHave: [], dietaryMustAvoid: [], intakeEnabled: true,
        });
        console.log('  Open Hands Shelter: needs and capacity set');
      }
    }

    /* ---------------- runner ---------------- */
    const runner = await signIn(RUNNER.email, { name: RUNNER.name, role: 'runner' });
    if (!(await runnerReady(db, (await userId(db, RUNNER.email))!))) {
      await runner.call('PUT', '/runner/profile', RUNNER_PROFILE);
      console.log(`  ${RUNNER.name}: scooter, 20 kg, available`);
    }

    /* ---------------- data through the real lifecycle ---------------- */
    const provider = sessions.provider!;
    const ngo = sessions.ngo!;
    for (const it of items) {
      const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
      const created = await provider.call<{ listing: { id: string } }>('POST', '/listings', {
        title: it.title,
        description: `Fictional test listing. The photo is a bundled demo image, not a real provider upload. ${it.note}.`,
        foodCategory: it.cat, servings: it.servings, estimatedKg: it.kg, preparedAt: iso(-30), pickupStart: iso(5), pickupDeadline: iso(30 * 60),
        addressLine: PROVIDER.org.addressLine, city: 'Pune', latitude: PROVIDER.org.latitude, longitude: PROVIDER.org.longitude,
        packaging: it.packaging, dietaryTags: it.tags, transportRequired: it.transport,
      });
      const id = created.listing.id;
      await provider.call('POST', `/listings/${id}/image`, undefined, fileForm({}, await readFile(new URL(`${it.photo}.jpg`, PHOTO_DIR)), `${it.photo}.jpg`, 'image/jpeg'));
      await provider.call('POST', `/listings/${id}/publish`, { declarationAccepted: true });
      if (it.stage !== 'live') {
        const rid = (await ngo.call<{ rescue: { id: string } }>('POST', `/listings/${id}/accept`, { transportMode: 'RUNNER' })).rescue.id;
        const code = (await provider.call<{ pickupCode?: string }>('POST', `/rescues/${rid}/confirm`, {})).pickupCode;
        if (!code) throw new Error('No pickup code was issued.');
        await runner.call('POST', `/rescues/${rid}/assign-self`, {});
        await runner.call('POST', `/rescues/${rid}/pickup/verify`, { code, collectedServings: it.servings });
        await runner.call('POST', `/rescues/${rid}/delivery/handover`, { note: 'Handed to the shelter kitchen.' });
        if (it.stage === 'completed') await ngo.call('POST', `/rescues/${rid}/delivery/confirm`, { deliveredServings: it.servings - 2 });
      }
      console.log(`  added ${it.title}: ${it.stage === 'live' ? 'live, unaccepted' : it.stage === 'delivered' ? 'DELIVERED, waiting for tester.ngo' : `COMPLETED (${it.servings - 2} of ${it.servings})`}`);
    }

    console.log('\nTester accounts (password: DEMO_PASSWORD from .env):');
    for (const e of [ADMIN.email, PROVIDER.email, NGO.email, RUNNER.email]) console.log(`  ${e}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: Error) => {
  console.error(`Tester accounts failed: ${err.message}`);
  process.exit(1);
});
