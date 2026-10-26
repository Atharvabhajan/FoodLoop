import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import type { EscalationService } from '../src/modules/escalation/service.js';
import { MAX_SOCKETS_PER_USER, attachRealtime } from '../src/realtime.js';
import { PASSWORD, availableListing, createListing, matchedNgo, resetData, signedInAgent, testConfig, testDatabaseUrl, verifiedAgent } from './helpers.js';
import { runnerAt } from './runner-helpers.js';

const config = testConfig();
// Fixtures use the privileged connection; the application and the socket layer run as the least-privilege runtime role.
const { db, pool } = createDb(testDatabaseUrl());
const runtime = createDb(config.DATABASE_URL);
const ctxFor = () => {
  let escalation!: EscalationService;
  const app = createApp({ config, db: runtime.db, pool: runtime.pool, onEscalationService: (s) => (escalation = s) });
  return { config, db, pool, app, runtime, escalation };
};
let server: Server;
let url: string;
let rt: ReturnType<typeof attachRealtime>;
const sockets: Socket[] = [];

beforeEach(async () => {
  await resetData(db);
  let push: (u: string[], r: string) => void = () => undefined;
  let pushListing: (id: string, users?: string[]) => void = () => undefined;
  const app = createApp({ config, db: runtime.db, pool: runtime.pool, realtime: { rescueChanged: (u, r) => push(u, r), listingChanged: (id, users) => pushListing(id, users) } });
  server = createServer(app);
  rt = attachRealtime(server, runtime.db, config);
  push = rt.rescueChanged;
  pushListing = rt.listingChanged;
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  rt.io.close();
  await new Promise((r) => server.close(r));
});
afterAll(async () => {
  await runtime.pool.end();
  await pool.end();
});

/** Signs in over real HTTP and returns the session cookie header a browser would send. */
async function cookieFor(email: string) {
  const res = await request(url).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');
}

// The readiness promise is attached at creation, so a socket that connects while the test is still
// awaiting something else is never missed.
const ready = new WeakMap<Socket, Promise<void>>();
function open(cookie?: string) {
  const s = connect(url, { addTrailingSlash: false, transports: ['websocket'], reconnection: false, extraHeaders: cookie ? { cookie } : {} });
  const p = new Promise<void>((res, rej) => {
    s.once('connect', () => res());
    s.once('connect_error', rej);
  });
  p.catch(() => undefined);
  ready.set(s, p);
  sockets.push(s);
  return s;
}
const connected = (s: Socket) => ready.get(s)!;
const nextEvent = (s: Socket, name: string, ms = 2500) =>
  new Promise<unknown>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    s.once(name, (d) => { clearTimeout(t); res(d); });
  });
const silent = async (s: Socket, name: string, ms = 600) => {
  let got = false;
  s.on(name, () => { got = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !got;
};

describe('authenticated real-time updates', () => {
  it('refuses a socket without a valid session', async () => {
    await expect(connected(open())).rejects.toThrow(/unauthorized/);
    await expect(connected(open('fl_access=not-a-token'))).rejects.toThrow(/unauthorized/);
  });

  it('refuses a socket whose session has been revoked', async () => {
    const provider = await verifiedAgent(ctxFor(), 'provider');
    const cookie = await cookieFor(provider.email);
    await request(url).post('/api/v1/auth/logout').set('Cookie', cookie).expect(200);
    await expect(connected(open(cookie))).rejects.toThrow(/unauthorized/);
  });

  it('caps concurrent sockets per user, without affecting other users', async () => {
    const ctx = ctxFor();
    const provider = await verifiedAgent(ctx, 'provider');
    const other = await verifiedAgent(ctx, 'provider');
    const cookie = await cookieFor(provider.email);
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) {
      await connected(open(cookie));
    }
    await expect(connected(open(cookie))).rejects.toThrow(/too many connections/);
    await connected(open(await cookieFor(other.email))); // someone else is unaffected
  });

  it('nudges only the parties to a rescue, with an id and nothing else', async () => {
    const ctx = ctxFor();
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const bystander = await matchedNgo(ctx, { metersAway: 1500 });
    const outsiderProvider = await verifiedAgent(ctx, 'provider');
    const listing = await availableListing(provider.agent);

    const sProvider = open(await cookieFor(provider.email));
    const sNgo = open(await cookieFor(ngo.email));
    const sBystander = open(await cookieFor(bystander.email));
    const sOutsider = open(await cookieFor(outsiderProvider.email));
    await Promise.all([sProvider, sNgo, sBystander, sOutsider].map(connected));

    const gotProvider = nextEvent(sProvider, 'rescue.updated');
    const gotNgo = nextEvent(sNgo, 'rescue.updated');
    const bystanderQuiet = silent(sBystander, 'rescue.updated');
    const outsiderQuiet = silent(sOutsider, 'rescue.updated');

    const ngoCookie = await cookieFor(ngo.email);
    const accept = await request(url).post(`/api/v1/listings/${listing.id}/accept`).set('Cookie', ngoCookie).send({});
    expect(accept.status).toBe(201);
    const rescueId = accept.body.data.rescue.id;

    const [p, n] = (await Promise.all([gotProvider, gotNgo])) as { rescueId: string }[];
    expect(p).toEqual({ rescueId });
    expect(n).toEqual({ rescueId }); // the acting NGO's other tabs refresh too
    expect(await bystanderQuiet).toBe(true);
    expect(await outsiderQuiet).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/Biryani|address|contact/i);
  });

  it('nudges admins about every rescue change and every listing change (for the operations board), and nobody else', async () => {
    const ctx = ctxFor();
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const stranger = await verifiedAgent(ctx, 'provider');
    const sAdmin = open(await cookieFor(admin.email));
    const sStranger = open(await cookieFor(stranger.email));
    const sProvider = open(await cookieFor(provider.email));
    await Promise.all([sAdmin, sStranger, sProvider].map(connected));

    // A listing is published: admins (only) are told which listing, nothing else.
    const listingNudge = nextEvent(sAdmin, 'listing.updated');
    const strangerListingQuiet = silent(sStranger, 'listing.updated', 1200);
    const providerListingQuiet = silent(sProvider, 'listing.updated', 1200);
    // Published over the real server (the one wired to Socket.IO), as a browser would.
    const draft = await createListing(provider.agent);
    await request(url).post(`/api/v1/listings/${draft.id}/publish`).set('Cookie', await cookieFor(provider.email)).send({ declarationAccepted: true }).expect(200);
    const listing = draft;
    expect(await listingNudge).toEqual({ listingId: listing.id });
    expect(await strangerListingQuiet).toBe(true);
    expect(await providerListingQuiet).toBe(true);

    // The admin is not a party to the rescue, yet hears about each step, exactly once per event, with only an id.
    const events: unknown[] = [];
    sAdmin.on('rescue.updated', (d) => events.push(d));
    const strangerQuiet = silent(sStranger, 'rescue.updated', 1500);
    const accepted = await request(url).post(`/api/v1/listings/${listing.id}/accept`).set('Cookie', await cookieFor(ngo.email)).send({});
    expect(accepted.status).toBe(201);
    const rescueId = accepted.body.data.rescue.id as string;
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 3000 });
    const afterAccept = events.length;
    await request(url).post(`/api/v1/rescues/${rescueId}/confirm`).set('Cookie', await cookieFor(provider.email)).send({}).expect(200);
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(afterAccept), { timeout: 3000 });
    for (const e of events) expect(e).toEqual({ rescueId });
    expect(await strangerQuiet).toBe(true);
    // Admin-stream membership comes from the server-side role: the stranger above never receives these events.
    expect(JSON.stringify(events)).not.toMatch(/Biryani|address|contact|code/i);
  });

  it('nudges exactly the NGOs a wave notified, and admins, with the listing id only; the notification itself is available over REST', async () => {
    const ctx = ctxFor();
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const near = await matchedNgo(ctx, { metersAway: 1500 }); // inside wave 1 (3 km)
    const far = await matchedNgo(ctx, { metersAway: 4000, requirement: { serviceRadiusKm: 15 } }); // eligible, but only wave 2 reaches it
    const sNear = open(await cookieFor(near.email));
    const sFar = open(await cookieFor(far.email));
    const sAdmin = open(await cookieFor(admin.email));
    await Promise.all([sNear, sFar, sAdmin].map(connected));
    const nearNudge = nextEvent(sNear, 'listing.updated');
    const adminNudge = nextEvent(sAdmin, 'listing.updated');
    const farQuiet = silent(sFar, 'listing.updated', 1800);

    // Published through the server wired to Socket.IO. The test configuration starts wave 1 at publish.
    const draft = await createListing(provider.agent);
    await request(url).post(`/api/v1/listings/${draft.id}/publish`).set('Cookie', await cookieFor(provider.email)).send({ declarationAccepted: true }).expect(200);
    expect(await nearNudge).toEqual({ listingId: draft.id });
    expect(await adminNudge).toEqual({ listingId: draft.id });
    expect(await farQuiet).toBe(true);

    // No socket needed to see it: the notification is on the REST inbox of exactly the NGO that was told.
    const inbox = async (cookieOwner: { email: string }) => (await request(url).get('/api/v1/notifications').set('Cookie', await cookieFor(cookieOwner.email))).body.data.notifications;
    expect((await inbox(near)).filter((n: { type: string }) => n.type === 'LISTING_MATCH')).toHaveLength(1);
    expect(await inbox(far)).toEqual([]);
  });

  it('keeps the board correct when no socket is connected (REST is the source of truth)', async () => {
    const ctx = ctxFor();
    const admin = await signedInAgent(ctx, 'admin');
    const provider = await verifiedAgent(ctx, 'provider');
    const ngo = await matchedNgo(ctx, { metersAway: 1000 });
    const listing = await availableListing(provider.agent);
    const cookie = await cookieFor(admin.email);
    const board = async () => (await request(url).get('/api/v1/admin/board/rescues').set('Cookie', cookie)).body.data.counts;
    expect(await board()).toMatchObject({ total: 0 });
    await request(url).post(`/api/v1/listings/${listing.id}/accept`).set('Cookie', await cookieFor(ngo.email)).send({}).expect(201);
    expect(await board()).toMatchObject({ total: 1, active: 1 }); // visible by simply asking again: no socket needed
  });

  it('nudges runners about a job they could take and about a rescue they hold, but not offline runners or strangers', async () => {
    const hctx = ctxFor();
    const eligible = await runnerAt(hctx);
    const offline = await runnerAt(hctx, { availability: 'OFFLINE' });
    const provider = await verifiedAgent(hctx, 'provider');
    const ngo = await matchedNgo(hctx, { metersAway: 1000 });
    const listing = await availableListing(provider.agent);
    const sEligible = open(await cookieFor(eligible.email));
    const sOffline = open(await cookieFor(offline.email));
    const sProvider = open(await cookieFor(provider.email));
    await Promise.all([sEligible, sOffline, sProvider].map(connected));

    const ngoCookie = await cookieFor(ngo.email);
    const accepted = await request(url).post(`/api/v1/listings/${listing.id}/accept`).set('Cookie', ngoCookie).send({ transportMode: 'RUNNER' });
    const rescueId = accepted.body.data.rescue.id as string;

    // The provider confirms: the search starts, and only the eligible runner is nudged.
    const jobNudge = nextEvent(sEligible, 'rescue.updated');
    const offlineQuiet = silent(sOffline, 'rescue.updated', 1500);
    await request(url).post(`/api/v1/rescues/${rescueId}/confirm`).set('Cookie', await cookieFor(provider.email)).send({}).expect(200);
    expect(await jobNudge).toEqual({ rescueId });
    expect(await offlineQuiet).toBe(true);

    // The runner accepts: the provider hears about it, the offline runner still hears nothing.
    const providerNudge = nextEvent(sProvider, 'rescue.updated');
    const offlineQuiet2 = silent(sOffline, 'rescue.updated', 1000);
    await request(url).post(`/api/v1/rescues/${rescueId}/assign-self`).set('Cookie', await cookieFor(eligible.email)).send({}).expect(200);
    expect(await providerNudge).toEqual({ rescueId });
    expect(await offlineQuiet2).toBe(true);
  });
});
