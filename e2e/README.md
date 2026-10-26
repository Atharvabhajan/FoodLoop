# Browser walkthroughs

Repeatable end-to-end checks that drive the real web app in a headless browser against the **test database** (never the development one).

| File | What it does |
|---|---|
| `reset-test-db.mjs` | Truncates only the application tables of `TEST_DATABASE_URL` (refuses unless the database name contains `test`) and reseeds the demo data into it. |
| `admin-board.walkthrough.mjs` | Admin live operations board: counts, unaccepted listings, an overdue rescue with its reason, filters and search, an incident link, socket updates, the polling fallback with sockets blocked, denial for non-admins, and a check that the impact pages are unchanged. |
| `escalation.walkthrough.mjs` | Escalation waves: a listing progressing through every wave (who is told and when, no duplicates), the admin board updating without a reload and its wave history, and a second listing whose later waves stop when an NGO accepts. Needs the stack started with the **demo escalation profile**. |

## Running

1. Reset and seed the test database: `node --env-file=.env e2e/reset-test-db.mjs`
2. Start the stack against the test database, with the API on a least-privilege runtime login (see `docs/phase-7-security-operations.md`): set `DATABASE_URL` to a runtime-role URL on the test database, `MIGRATION_DATABASE_URL` empty, then `npm run build && npm start`.
3. Run the walkthrough with a Playwright-style runner that executes `export default async function run(page)` files. With the Claude Code browser-automation skill:
   `node <skill>/browser.mjs http://localhost:3000 --script e2e/admin-board.walkthrough.mjs`
   with `DEMO_PASSWORD`, `TEST_DATABASE_URL` and (optionally) `SHOTDIR` in the environment.

Each check prints `STEP <name>: <result>`; a failed boolean check prints `false`. The walkthrough changes the test data (it accepts and cancels a rescue), so reset between runs.

**Demo escalation profile** (for `escalation.walkthrough.mjs`; set in the environment of the API before `npm start`, otherwise the pilot defaults make a wave take minutes): `ESCALATION_WAVE1_MINUTES=0.1 ESCALATION_WAVE2_MINUTES=0.2 ESCALATION_RUNNER_MINUTES=0.3 ESCALATION_WAVE3_MINUTES=0.4 ESCALATION_ADMIN_MINUTES=0.5 ESCALATION_INTERVAL_SECONDS=3`. The run takes about a minute and a half.

These are not run by `npm test` (they need a built, running stack and a browser).
