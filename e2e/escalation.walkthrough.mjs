// Escalation waves: repeatable browser walkthrough against the TEST database.
//
// Start the stack with the DEMO escalation profile (seconds-scale; see .env.example and e2e/README.md):
//   ESCALATION_WAVE1_MINUTES=0.1 ESCALATION_WAVE2_MINUTES=0.2 ESCALATION_RUNNER_MINUTES=0.3
//   ESCALATION_WAVE3_MINUTES=0.4 ESCALATION_ADMIN_MINUTES=0.5 ESCALATION_INTERVAL_SECONDS=3
// then:  node <runner>/browser.mjs http://localhost:3000 --script e2e/escalation.walkthrough.mjs
//
// Needs DEMO_PASSWORD and TEST_DATABASE_URL (read-only checks of what was sent, and nothing else) in the environment.
// Prints one "STEP name: result" line per check; a failed boolean check prints "false". Reset the test database first.
import pg from 'pg';

const PW = process.env.DEMO_PASSWORD;
const B = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const DB = process.env.TEST_DATABASE_URL;

export default async function run(page) {
  if (!PW) throw new Error('DEMO_PASSWORD is not set.');
  if (!DB || !/test/i.test(decodeURIComponent(new URL(DB).pathname))) throw new Error('TEST_DATABASE_URL must name a test database.');
  const out = [];
  const step = (n, v) => { out.push(`${n}: ${v}`); console.log(`STEP ${n}: ${v}`); };
  const sql = async (q, params = []) => {
    const c = new pg.Client({ connectionString: DB });
    await c.connect();
    try { return (await c.query(q, params)).rows; } finally { await c.end(); }
  };
  const login = async (p, email) => {
    await p.goto(B + '/');
    await p.getByLabel('Email').fill(email);
    await p.getByLabel('Password').fill(PW);
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForURL(/\/(provider|ngo|runner|admin)$/);
  };
  const api = (p, method, path, body) =>
    p.evaluate(async ([m, u, b]) => {
      const r = await fetch(`/api/v1${u}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, data: j?.data, code: j?.code };
    }, [method, path, body]);
  const poll = async (fn, ms, every = 500) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, every));
    }
  };
  const told = async (email, listingId, type) =>
    Number((await sql(`SELECT count(*)::int AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 AND n.entity_id = $2 AND n.type = $3`, [email, listingId, type]))[0].n);
  const stepStatuses = async (listingId) => (await sql(`SELECT status, reason FROM escalation_steps WHERE listing_id = $1 AND round = 1 ORDER BY seq`, [listingId]));
  const iso = (min) => new Date(Date.now() + min * 60_000).toISOString();
  const listingBody = (title) => ({
    title, description: 'Packed in boxes.', foodCategory: 'COOKED_MEALS', servings: 30, estimatedKg: 12,
    preparedAt: iso(-30), pickupStart: iso(5), pickupDeadline: iso(180),
    addressLine: 'Main Campus, Food Court Block', city: 'Pune', latitude: 18.5204, longitude: 73.8567,
    packaging: 'INDIVIDUAL_BOXES', dietaryTags: ['VEGETARIAN'], transportRequired: true,
  });
  const shot = (n) => page.screenshot({ path: `${process.env.SHOTDIR ?? '.'}/${n}.png`, fullPage: true });
  const browser = page.context().browser();
  const sessions = {};
  const open = async (key, email) => { const c = await browser.newContext(); const p = await c.newPage(); await login(p, email); sessions[key] = { c, p }; return p; };

  // ---------- 1. Sign in everyone; the admin opens the board's listings view ----------
  await login(page, 'admin@demo.foodloop.test');
  const pProv = await open('provider', 'provider@demo.foodloop.test');
  const pNear = await open('near', 'ngo@demo.foodloop.test'); // Hope Community Kitchen: inside 3 km
  const pFar = await open('far', 'ngo3@demo.foodloop.test'); // Helping Hands: about 6 km, so only the 10 km wave reaches it
  await open('runner', 'runner@demo.foodloop.test');
  await page.goto(B + '/admin/board');
  await page.getByRole('tab', { name: 'Unaccepted listings' }).click();
  await page.getByText(/Counts follow your filters|Live, unaccepted/).first().waitFor();

  // ---------- 2. A listing is published: the schedule is persisted, nobody is told yet ----------
  const title = `Escalation demo ${Date.now() % 100000}`;
  const created = await api(pProv, 'POST', '/listings', listingBody(title));
  const listingId = created.data.listing.id;
  const published = Date.now();
  await api(pProv, 'POST', `/listings/${listingId}/publish`, { declarationAccepted: true });
  const steps = await sql(`SELECT seq, kind, radius_km, EXTRACT(EPOCH FROM due_at) * 1000 AS due FROM escalation_steps WHERE listing_id = $1 AND round = 1 ORDER BY seq`, [listingId]);
  step('2a five steps persisted: kinds and radii', steps.map((s) => `${s.kind}${s.radius_km ? `@${s.radius_km}km` : ''}`).join(' > '));
  step('2b offsets in seconds from publish', steps.map((s) => Math.round((Number(s.due) - published) / 1000)).join(','));
  step('2c nobody told at publish', `${await told('ngo@demo.foodloop.test', listingId, 'LISTING_MATCH')} / ${await told('ngo3@demo.foodloop.test', listingId, 'LISTING_MATCH')}`);

  // ---------- 3. The board shows the schedule; wave 1 runs and tells only the NGO inside 3 km ----------
  const card = page.locator('li', { hasText: title });
  await card.getByText(/Escalation:/).waitFor({ timeout: 25000 });
  step('3a admin board shows the escalation stage', (await card.innerText()).replace(/\s+/g, ' ').match(/Escalation: \d of 5 steps done[^|]*/)?.[0]?.slice(0, 110));
  const w1 = await poll(async () => (await stepStatuses(listingId))[0].status === 'DONE', 30000);
  step('3b wave 1 ran', w1);
  step('3c only the NGO inside 3 km was told', `near=${await told('ngo@demo.foodloop.test', listingId, 'LISTING_MATCH')} far=${await told('ngo3@demo.foodloop.test', listingId, 'LISTING_MATCH')} runner=${await told('runner@demo.foodloop.test', listingId, 'LISTING_RUNNER_ALERT')} admin=${await told('admin@demo.foodloop.test', listingId, 'ESCALATION_ADMIN')}`);

  // ---------- 4. Nobody accepts: later waves run once each, ending with the admin alert ----------
  const all = await poll(async () => (await stepStatuses(listingId)).every((s) => s.status === 'DONE'), 60000);
  step('4a all five steps done', all);
  step('4b each recipient told exactly once (no duplicates across waves or worker passes)',
    `near=${await told('ngo@demo.foodloop.test', listingId, 'LISTING_MATCH')} far=${await told('ngo3@demo.foodloop.test', listingId, 'LISTING_MATCH')} runner=${await told('runner@demo.foodloop.test', listingId, 'LISTING_RUNNER_ALERT')} admin=${await told('admin@demo.foodloop.test', listingId, 'ESCALATION_ADMIN')}`);
  step('4c duplicate notification keys in the whole database', (await sql(`SELECT count(*)::int AS n FROM (SELECT dedupe_key FROM notifications GROUP BY dedupe_key HAVING count(*) > 1) t`))[0].n);
  await card.getByText('Admin alerted').waitFor({ timeout: 25000 }); // the page was not reloaded: socket nudge or polling
  step('4d admin board updated without a reload: 5 of 5 and "Admin alerted"', /5 of 5 steps done/.test((await card.innerText()).replace(/\s+/g, ' ')));
  await card.getByText('Wave history').click();
  await card.getByText('Who was told').waitFor({ timeout: 10000 });
  const hist = (await card.innerText()).replace(/\s+/g, ' ');
  step('4e wave history lists both NGOs and the runner by name', /Hope Community Kitchen/.test(hist) && /Helping Hands/.test(hist) && /Aarav/.test(hist));
  step('4f history shows counts per step', /NGO wave \(within 3 km\)/.test(hist) && /Runner network/.test(hist) && /Admin alert/.test(hist));
  await shot('escalation-history');

  // ---------- 5. The NGO's own view: one notification, no private details ----------
  const inbox = await api(pNear, 'GET', '/notifications');
  const mine = inbox.data.notifications.filter((n) => n.entityId === listingId);
  step('5a the notified NGO sees one match notification', `${mine.length} ${mine[0]?.type}`);
  step('5b it carries no address or contact', !/Food Court|@demo|\+91|18\.52/.test(JSON.stringify(mine)));

  // ---------- 6. Acceptance stops the remaining waves ----------
  const titleB = `${title} (accepted)`;
  const createdB = await api(pProv, 'POST', '/listings', listingBody(titleB));
  const idB = createdB.data.listing.id;
  await api(pProv, 'POST', `/listings/${idB}/publish`, { declarationAccepted: true });
  await poll(async () => (await stepStatuses(idB))[0].status === 'DONE', 30000);
  const acc = await api(pNear, 'POST', `/listings/${idB}/accept`, { transportMode: 'NGO_PICKUP' });
  step('6a NGO accepts after wave 1', acc.status);
  const afterAccept = await stepStatuses(idB);
  step('6b remaining steps cancelled at once, with the reason', afterAccept.map((s) => `${s.status}${s.reason ? `:${s.reason}` : ''}`).join(' '));
  const wait = Math.max(0, 40000 - (Date.now() - published));
  await new Promise((r) => setTimeout(r, wait + 12000)); // well past what would have been waves 2 to 5
  step('6c nothing was sent after acceptance',
    `far=${await told('ngo3@demo.foodloop.test', idB, 'LISTING_MATCH')} runner=${await told('runner@demo.foodloop.test', idB, 'LISTING_RUNNER_ALERT')} admin=${await told('admin@demo.foodloop.test', idB, 'ESCALATION_ADMIN')}`);
  const histB = await api(page, 'GET', `/admin/board/listings/${idB}/escalation`);
  step('6d the admin history shows the stop', histB.data.rounds[0].steps.map((s) => s.status).join(','));

  // ---------- 7. Authorization ----------
  step('7a history route is 403 for an NGO and a provider', `${(await api(pNear, 'GET', `/admin/board/listings/${listingId}/escalation`)).status},${(await api(pProv, 'GET', `/admin/board/listings/${listingId}/escalation`)).status}`);
  step('7b and for a runner', (await api(sessions.runner.p, 'GET', `/admin/board/listings/${listingId}/escalation`)).status);
  const farInbox = (await api(pFar, 'GET', '/notifications')).data.notifications;
  step('7c the far NGO was told about the unaccepted listing once, and never about the accepted one',
    `${farInbox.filter((n) => n.entityId === listingId).length} / ${farInbox.filter((n) => n.entityId === idB).length}`);

  for (const { c } of Object.values(sessions)) await c.close();
  return out;
}
