// Admin live operations board: repeatable browser walkthrough against the TEST database.
//
// Run order (see e2e/README.md): reset + seed the test DB, start the stack against it, then run this script with the
// browser-automation runner:   node <runner>/browser.mjs http://localhost:3000 --script e2e/admin-board.walkthrough.mjs
//
// Needs in the environment: DEMO_PASSWORD, TEST_DATABASE_URL (used only for pinning timestamps so a rescue is overdue).
// It prints one "STEP name: result" line per check; a failed boolean check prints "false".
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
  const logout = async (p) => { await p.getByRole('button', { name: 'Sign out' }).click(); await p.waitForURL(B + '/'); };
  const api = (p, method, path, body) =>
    p.evaluate(async ([m, u, b]) => {
      const r = await fetch(`/api/v1${u}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, data: j?.data, code: j?.code };
    }, [method, path, body]);
  const text = async (p) => (await p.locator('main').innerText()).replace(/\s+/g, ' ');
  const countOf = async (p, label) => {
    const t = (await p.getByRole('button', { name: new RegExp(`^\\S*\\s*${label}\\b`) }).first().innerText()).replace(/\s+/g, ' ');
    return Number((t.match(/(\d+)/) ?? [])[1]);
  };
  // The state tiles render a dash until the first response arrives: wait for real data before reading a baseline count.
  const boardReady = (p) => p.getByText(/Counts follow your filters/).waitFor();
  const shot = (n) => page.screenshot({ path: `${process.env.SHOTDIR ?? '.'}/${n}.png`, fullPage: true });

  // ---------- 1. Admin opens the board: counts and the unaccepted live listing ----------
  await login(page, 'admin@demo.foodloop.test');
  await page.getByRole('link', { name: 'Operations' }).first().click();
  await page.waitForURL(/\/admin\/board$/);
  await page.getByRole('group', { name: 'Rescue state' }).waitFor();
  await page.getByRole('list', { name: 'Rescues' }).waitFor();
  await boardReady(page);
  step('1a seeded history: 2 completed, nothing in progress', `${await countOf(page, 'Completed')} completed, ${await countOf(page, 'Active')} active, ${await countOf(page, 'Delayed')} delayed`);
  step('1b delayed rule is explained on the page', /Delayed.*in progress and either blocked by an incident, past the pickup window, or 75% or more/.test(await text(page)));
  await page.getByRole('tab', { name: 'Unaccepted listings' }).click();
  await page.getByText('Vegetable Biryani (demo)').waitFor();
  const t1 = await text(page);
  step('1c live unaccepted listing shown with matching counts', /Vegetable Biryani \(demo\)/.test(t1) && /eligible NGO/.test(t1));
  await page.getByRole('button', { name: /Expired or cancelled/ }).click();
  await page.getByText(/not actionable/).first().waitFor();
  step('1d expired/cancelled listings are shown as non-actionable context', (await page.getByText(/not actionable/).count()) >= 1 && !(await page.getByText('Vegetable Biryani (demo)').count()));
  await shot('board-listings');

  // ---------- 2. Make a rescue overdue: NGO accepts, provider confirms, pickup window closes ----------
  const ctxNgo = await page.context().browser().newContext();
  const pNgo = await ctxNgo.newPage();
  await login(pNgo, 'ngo@demo.foodloop.test');
  const listingId = (await sql(`SELECT id FROM food_listings WHERE title = 'Vegetable Biryani (demo)'`))[0].id;
  const acc = await api(pNgo, 'POST', `/listings/${listingId}/accept`, { transportMode: 'NGO_PICKUP' });
  const rescueId = acc.data.rescue.id;
  const ctxProv = await page.context().browser().newContext();
  const pProv = await ctxProv.newPage();
  await login(pProv, 'provider@demo.foodloop.test');
  await api(pProv, 'POST', `/rescues/${rescueId}/confirm`, {});
  step('2a rescue created and confirmed (direct pickup)', (await sql(`SELECT status FROM rescues WHERE id = $1`, [rescueId]))[0].status);
  await sql(`UPDATE food_listings SET prepared_at = now() - interval '4 hours', pickup_start = now() - interval '3 hours', pickup_deadline = now() - interval '5 minutes' WHERE id = $1`, [listingId]);
  await sql(`UPDATE rescues SET pickup_by = now() + interval '25 minutes' WHERE id = $1`, [rescueId]);

  // ---------- 3. The board shows it as delayed, with why and which action ----------
  await page.getByRole('tab', { name: 'Rescues' }).click();
  await page.getByRole('button', { name: /^\S*\s*Delayed/ }).first().click();
  await page.getByText('Why delayed:').first().waitFor({ timeout: 20000 });
  const t3 = await text(page);
  step('3a delayed count is 1', await countOf(page, 'Delayed'));
  step('3b reason and overdue action are stated', /Pickup verification is overdue: the pickup window closed/.test(t3) && /Overdue action: Pickup verification/.test(t3));
  step('3c next responsible actor and deadline shown', /Next \(NGO\)/.test(t3) && /Pickup must be verified by/.test(t3));
  await shot('board-delayed');

  // ---------- 4. Filters, search and pagination controls ----------
  await page.getByLabel('Search').first().fill('biryani');
  await page.waitForTimeout(700);
  step('4a search narrows to the rescue', /Vegetable Biryani/.test(await text(page)));
  await page.getByLabel('Search').first().fill('zzz-nothing');
  await page.getByText('No rescues match these filters.').waitFor();
  step('4b empty state with a way out', await page.getByRole('button', { name: 'Clear filters' }).first().isVisible());
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await page.getByLabel('Transport').selectOption('RUNNER');
  await page.getByText('No rescues match these filters.').waitFor();
  step('4c transport filter applies server-side', 'ok');
  await page.getByLabel('Transport').selectOption('');
  await page.getByText(/Page 1 of 1 · \d+ results?/).waitFor(); // the list reloads after the filter change
  const pager = (await page.getByRole('status').filter({ hasText: /Page \d+ of \d+/ }).innerText()).replace(/\s+/g, ' ');
  step('4d pagination reports page and total', `${/Page 1 of 1 · 3 results/.test(pager)} [${pager}]`);

  // ---------- 5. Incident on the rescue shows on the board and links through ----------
  await api(pNgo, 'POST', `/rescues/${rescueId}/incidents`, { category: 'PICKUP_PROBLEM', severity: 'HIGH', description: 'The kitchen door is locked and nobody answers.' });
  await page.getByText(/Blocking incident/).first().waitFor({ timeout: 20000 });
  step('5a blocking incident badge appears (live update or poll)', 'ok');
  await page.getByRole('link', { name: 'Incidents', exact: true }).first().click();
  await page.waitForURL(/\/admin\/incidents$/);
  await page.getByText('Problem at pickup').first().waitFor();
  step('5b incident link opens the incident queue', 'ok');
  await page.goBack();
  await page.getByRole('link', { name: 'Open rescue, history and actions' }).first().click();
  await page.waitForURL(/\/admin\/rescues\/[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: /Operations/ }).waitFor();
  const t5 = await text(page);
  step('5c rescue page shows stage, next actor, deadline, why delayed, incidents and history', /Stage\s*Ready for pickup/.test(t5) && /Next \((Admin)\)/.test(t5) && /Why delayed/.test(t5) && /Incidents:/.test(t5) && /History/.test(t5));
  await shot('board-rescue-detail');

  // ---------- 6. Real-time: another session changes the rescue; the admin board follows without a reload ----------
  await page.goto(B + '/admin/board');
  await boardReady(page);
  const before = await countOf(page, 'Cancelled');
  await api(pNgo, 'POST', `/rescues/${rescueId}/cancel`, { reason: 'No transport available today' });
  await page.waitForFunction((n) => { const b = [...document.querySelectorAll('button')].find((x) => /^\S*\s*Cancelled\b/.test(x.innerText.replace(/\s+/g, ' '))); return b && Number((b.innerText.match(/(\d+)/) ?? [])[1]) > n; }, before, { timeout: 12000 });
  step('6a cancellation appears on the board within 12 s (socket nudge)', 'ok');

  // ---------- 7. REST fallback: sockets blocked, the board still converges by polling ----------
  const ctxAdmin2 = await page.context().browser().newContext();
  const pAdmin2 = await ctxAdmin2.newPage();
  await pAdmin2.route('**/socket.io/**', (r) => r.abort());
  await login(pAdmin2, 'admin@demo.foodloop.test');
  await pAdmin2.goto(B + '/admin/board');
  await boardReady(pAdmin2);
  const activeBefore = await countOf(pAdmin2, 'Active');
  const ctxNgo3 = await page.context().browser().newContext();
  const pNgo3 = await ctxNgo3.newPage();
  await login(pNgo3, 'ngo3@demo.foodloop.test');
  await sql(`UPDATE food_listings SET status = 'AVAILABLE', prepared_at = now() - interval '1 hour', pickup_start = now() - interval '30 minutes', pickup_deadline = now() + interval '4 hours' WHERE id = $1`, [listingId]);
  const acc3 = await api(pNgo3, 'POST', `/listings/${listingId}/accept`, { transportMode: 'NGO_PICKUP' });
  step('7a second NGO accepts the released listing', acc3.status);
  await pAdmin2.waitForFunction((n) => { const b = [...document.querySelectorAll('button')].find((x) => /^\S*\s*Active\b/.test(x.innerText.replace(/\s+/g, ' '))); return b && Number((b.innerText.match(/(\d+)/) ?? [])[1]) > n; }, activeBefore, { timeout: 30000 });
  step('7b board updates by polling with sockets blocked (within 30 s)', 'ok');
  await ctxAdmin2.close();
  await ctxNgo3.close();

  // ---------- 8. Denial for non-admins (UI and API) ----------
  await login(pProv, 'provider@demo.foodloop.test').catch(() => undefined);
  await pProv.goto(B + '/admin/board');
  await pProv.waitForURL(/\/provider$/);
  step('8a a provider is bounced from the board page', pProv.url());
  const denied = await Promise.all(['/admin/board/rescues', '/admin/board/listings', '/admin/board/options', `/admin/board/rescues/${rescueId}`].map(async (u) => (await api(pProv, 'GET', u)).status));
  step('8b board API is 403 for a provider', denied.join(','));
  await login(pNgo, 'ngo@demo.foodloop.test').catch(() => undefined);
  step('8c board API is 403 for an NGO', (await api(pNgo, 'GET', '/admin/board/rescues')).status);

  // ---------- 9. Impact pages still work and are unaffected by operational counts ----------
  await page.goto(B + '/admin/impact');
  await page.locator('dt', { hasText: 'Completed rescues' }).first().waitFor();
  const t9 = await text(page);
  step('9a platform impact still counts only the 2 completed demo rescues', /Completed rescues\s*2/.test(t9) && /Servings delivered\s*51/.test(t9));
  await logout(page);
  await login(page, 'runner@demo.foodloop.test');
  await page.goto(B + '/runner/impact');
  await page.locator('dt', { hasText: 'Completed rescues' }).first().waitFor();
  step('9b runner impact page unchanged', /Completed rescues\s*1/.test(await text(page)));

  for (const c of [ctxNgo, ctxProv]) await c.close();
  return out;
}
