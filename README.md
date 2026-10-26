# FoodLoop

Real-time surplus-food redistribution platform (Web Technologies course project). This repository currently contains **Phase 0-7 plus impact metrics, the admin operations board and escalation waves**: identity, four roles, server-side authorization, organization verification, supply and demand (listings and NGO requirements), **geospatial matching with scoring and ranking**, the **direct-pickup rescue workflow**, **runner-assisted rescues** (runner profiles, claims, transit, maps, incident reports and admin resolution), and **production security and operational hardening** (a least-privilege database role for the running API, rate limits, retention, scrubbed logging). **Impact metrics** (derived from completed rescues) are built. The **admin live operations board** is built. **Escalation waves** are built. Password recovery, automated backups and deployment are **not built**. The project is **not production-ready**: see the blockers in [docs/phase-7-security-operations.md](docs/phase-7-security-operations.md#remaining-pre-deployment-blockers).

- Spec decisions: [docs/phase-0-decisions.md](docs/phase-0-decisions.md) · Organizations and verification: [docs/phase-2-organizations.md](docs/phase-2-organizations.md) · Supply and demand: [docs/phase-3-supply-demand.md](docs/phase-3-supply-demand.md) · Matching: [docs/phase-4-matching.md](docs/phase-4-matching.md) · Rescues: [docs/phase-5-rescue-logistics.md](docs/phase-5-rescue-logistics.md) · Runner logistics: [docs/phase-6-runner-logistics.md](docs/phase-6-runner-logistics.md) · **Security and operations: [docs/phase-7-security-operations.md](docs/phase-7-security-operations.md)** · **Impact metrics: [docs/phase-8-impact-metrics.md](docs/phase-8-impact-metrics.md)** · **Admin operations board: [docs/admin-live-operations-board.md](docs/admin-live-operations-board.md)** · **Escalation waves: [docs/escalation-waves.md](docs/escalation-waves.md)** · PostGIS setup: [docs/postgis-setup.md](docs/postgis-setup.md)
- Stack: Next.js + TypeScript + Tailwind (`apps/web`), Express + TypeScript (`apps/api`), PostgreSQL (+ PostGIS) via Drizzle ORM, Socket.IO (authenticated id-only nudges). npm workspaces.
- **No Docker.** PostgreSQL runs directly on your machine.

## Prerequisites

- Node.js 20+ and npm 10+
- PostgreSQL 14+ installed natively and running, plus a login with `CREATEDB` (e.g. `postgres`)
- **PostGIS (required from Phase 4)**, installed natively. See [docs/postgis-setup.md](docs/postgis-setup.md) and run `npm run db:check-postgis` before migrating.

### Native PostgreSQL / PostGIS

| OS | Steps |
|---|---|
| Windows | Install PostgreSQL from postgresql.org (the service starts automatically). Add PostGIS: launch **Stack Builder**, choose your server, select **Spatial Extensions → PostGIS**, finish, then restart the `postgresql-x64-*` service. |
| macOS | `brew install postgresql@17 postgis && brew services start postgresql@17` |
| Debian/Ubuntu | `sudo apt install postgresql postgis && sudo systemctl start postgresql` |

Phase 4 migration `0007` enables the extension and **fails if PostGIS is not installed**. Verify first with `npm run db:check-postgis` (it checks an isolated throwaway database before touching yours).

## Setup

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Edit `.env`:

- `MIGRATION_DATABASE_URL` — the **privileged** login (owner/superuser), used only by operator commands (`db:setup`, `db:migrate`, `db:seed`, `db:roles`, `retention`), e.g. `postgres://postgres:YOUR_PASSWORD@localhost:5432/foodloop`.
- `DATABASE_URL` — the **runtime** login the running API uses: the least-privilege role created by `npm run db:roles` (below). Until you have created it you may temporarily point it at the privileged login; outside production the API then starts with a warning on every start, and in production it refuses to.
- `TEST_DATABASE_URL` — the privileged login for the test database. The name must contain `test`; **tests delete all data in it.**
- `JWT_ACCESS_SECRET` — random, ≥32 chars: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- `DEMO_PASSWORD` — the shared password for the demo accounts (local only; ≥10 chars with a letter and a number). There is no default.

Create the databases (idempotent) and apply migrations:

```bash
npm run db:check-postgis   # PostGIS gate: version, isolated check, dev/test status
npm run db:setup      # creates the DB named in DATABASE_URL if missing; reports PostGIS availability
npm run db:migrate    # applies SQL migrations from apps/api/drizzle (privileged)
npm run db:roles      # creates/updates the least-privilege runtime role and its grants (needs RUNTIME_DB_PASSWORD once)
npm run db:seed       # development only: creates the demo accounts (privileged)
```

After `db:roles`, set `DATABASE_URL` to the `foodloop_runtime` login and remove `RUNTIME_DB_PASSWORD` from `.env`. Migrating an existing shared-superuser setup without losing data: [docs/phase-7-security-operations.md](docs/phase-7-security-operations.md#3-setting-it-up).

To create the test database: temporarily point `DATABASE_URL` at it, or run `CREATE DATABASE foodloop_test;` in `psql`. Migrations for it are applied automatically when tests start.

## Run

```bash
npm run dev           # API on :4000 and web on :3000
```

Open http://localhost:3000. Other scripts: `npm run dev:api`, `npm run dev:web`.

### Demo logins

After `npm run db:seed`, sign in with the password you set as `DEMO_PASSWORD`:

| Role | Email |
|---|---|
| Food Provider | `provider@demo.foodloop.test` |
| NGO | `ngo@demo.foodloop.test` |
| Rescue Runner (bicycle, 25 kg: eligible for the demo listing) | `runner@demo.foodloop.test` |
| Rescue Runner (scooter, 2 kg: too small for the demo listing) | `runner2@demo.foodloop.test` |
| Admin | `admin@demo.foodloop.test` |
| Provider with a *pending* application (Riverside Bakery) | `provider2@demo.foodloop.test` |
| NGO with a *draft* application (Care Foundation) | `ngo2@demo.foodloop.test` |

Phase 3/4 demo data (`ngo3@demo.foodloop.test` is a second verified NGO for ranking): `provider@` has a live listing, a draft, an expired and a cancelled listing; `ngo@` has an active requirement.

`provider@` and `ngo@` own **verified** organizations. Re-running the seed never overwrites progress made in the demo.
Seeding refuses to run when `NODE_ENV=production`. New provider/NGO/runner accounts can also be created at `/register`; admins cannot self-register.

### Two verified demo NGOs

`ngo@` (Hope Community Kitchen) and `ngo3@` (Helping Hands Trust) are both **verified** through the normal verification workflow (each has its review events in the audit history), each with coordinates, an active food requirement, capacity and an availability window, so both are matched, ranked and reached by escalation waves. `ngo2@` (Care Foundation) is deliberately an unsubmitted draft so the verification states can be demonstrated. No extra setup is needed: `npm run db:seed` is repeatable and never overwrites progress. To check, sign in as the admin and open **Verification queue**, or open `/ngo/listings` as each NGO while a listing is live.

## Visual identity and photos

Warm oat background, paprika actions, saffron accent, espresso text; local SVG logo and bundled, licence-recorded photographs; short CSS-only motion that respects `prefers-reduced-motion`. Final colour tokens, interaction choices and the photo source table are in [docs/design-system.md](docs/design-system.md). Credits are also shown in the app at `/credits`. The seed adds no listing photos: listings without one show a category photo marked "Illustrative photo", and a photo uploaded by the provider (previewed before upload) always replaces it.

## Maps, profiles and dashboards

Interactive maps (listing location picker, NGO location and radius, live-food map, runner position sharing with stop, admin operations map), a profile page for every role, and task-based dashboards. What each screen shows, the privacy rule behind it, and the small API additions (`PATCH /auth/me`, `DELETE /rescues/:id/location`, verified organizations may correct their map position) are in [docs/maps-profiles-dashboards.md](docs/maps-profiles-dashboards.md). Distances are straight-line estimates; there is no road routing. Map tiles come from OpenStreetMap, so the map background needs internet; every map screen keeps working without it (typed coordinates, text lists).

## Quality checks and production build

```bash
npm test              # Vitest + Supertest against TEST_DATABASE_URL (the app under test runs as a least-privilege role)
npm run typecheck
npm run lint
npm run build         # API (tsc -> dist) and web (next build)
npm start             # run the built apps (set NODE_ENV=production, COOKIE_SECURE=true behind HTTPS)
```

## Organizations and verification (Phase 2)

Providers and NGOs manage their profile at `/organization`; admins review applications at `/admin/verifications`. Lifecycle: `UNSUBMITTED → UNDER_REVIEW → VERIFIED | REJECTED (terminal) | RESUBMISSION_REQUESTED → UNDER_REVIEW`. Step-by-step demo: [docs/phase-2-organizations.md](docs/phase-2-organizations.md#demo-flow).

**Verification documents:** PDF, PNG or JPEG only, **5 MB** max, up to 10 per organization. Files are stored privately under `STORAGE_DIR` (default `storage/uploads/`, git-ignored, outside the web root) and are only downloadable through an authorized API route. Existing databases pick up the schema with `npm run db:migrate` (forward-only; no reset needed).

**PostGIS:** not required. Organization coordinates are plain `latitude`/`longitude` columns; spatial matching will need a later PostGIS migration.

## Supply and demand (Phase 3)

Verified Providers publish time-limited listings at `/provider/listings`; verified NGOs set food needs and capacity at `/ngo/requirements` and browse live listings (browse only) at `/ngo/listings`. Lifecycle: `DRAFT -> AVAILABLE -> CANCELLED | EXPIRED`. Expired listings disappear automatically: reads filter by deadline, and an in-process job (`EXPIRY_INTERVAL_SECONDS`, default 60, `0` to disable) records the expiry. NGOs only see an approximate area, never the exact pickup address.

**Food photos:** optional PNG or JPEG, **3 MB** max, stored privately (not in PostgreSQL) with embedded location metadata stripped, served only through an authorized route. Full rules, API table and demo flow: [docs/phase-3-supply-demand.md](docs/phase-3-supply-demand.md).

**PostGIS:** now required (Phase 4). Coordinates remain plain columns; a trigger-maintained `geog` column feeds the spatial queries.

## Matching (Phase 4)

Eligible verified NGOs are ranked per listing (distance 35, time feasibility 25, quantity fit 20, active need 10, reliability 10; reliability is a neutral default because no rescue history exists). Providers see ranked candidates on a listing page; NGOs see **Recommended for you** on Live food. Distances come from PostGIS; **travel times are estimates** (no routing provider), configured by the `MATCH_*` variables. Recommendations only: there is no Accept or Rescue button. Details, formula, filters and demo: [docs/phase-4-matching.md](docs/phase-4-matching.md).

## Rescues (Phase 5)

An eligible verified NGO accepts a recommended listing (re-checked live, one NGO per listing, enforced by row locks and a database index). The provider confirms the hand-off and receives a one-time pickup code; the NGO then sees the exact address and contacts, verifies pickup with the code, and confirms the quantity received. Deadlines are configurable (`RESCUE_*`), enforced on every read, and recorded in an append-only history. Lifecycle, authorization, concurrency, privacy staging, notifications and the demo flow: [docs/phase-5-rescue-logistics.md](docs/phase-5-rescue-logistics.md).

## Runner-assisted rescues (Phase 6)

For listings that request transport, the NGO can ask a volunteer runner instead of collecting the food. After the provider confirms, eligible runners (available, in radius, enough capacity, able to arrive in time; all re-checked live at claim time) see the job and one claims it (row lock plus partial unique indexes). The runner verifies pickup with the provider's code, optionally shares a coarse position (about 100 m, latest point only, deleted when tracking stops), hands over, and the NGO confirms the quantity. Parties and runners can report incidents (blocking ones pause the rescue until an admin resolves them). Only the NGO's confirmation or an admin can complete a rescue. New settings: `RESCUE_RUNNER_SEARCH_MINUTES`, `RESCUE_TRANSIT_MINUTES`, `RUNNER_KG_PER_SERVING`, `RUNNER_LOCATION_MIN_INTERVAL_SECONDS`, `RUNNER_LOCATION_MAX_AGE_MINUTES`. Lifecycle, permissions, location and incident handling, API routes, demo and limitations: [docs/phase-6-runner-logistics.md](docs/phase-6-runner-logistics.md).

Phase 7 resolved the shared-credential problem *in code and on the local cluster* (below); production readiness still depends on the blockers listed in the Phase 7 doc.

## Impact metrics

Provider, NGO, runner and admin impact pages (`/<role>/impact`) are computed on demand from completed rescues only: **servings delivered** (the quantity the recipient confirmed, not what was offered or collected), completed-rescue counts, direct versus runner-assisted, monthly totals, optional UTC date range. No stored counters, so each rescue counts exactly once. Runners are credited only for completed runner-assisted rescues they delivered. Kilograms are deliberately not reported (no valid per-rescue weight). `GET /api/v1/impact/me`, `GET /api/v1/impact/platform` (admin). Definitions, API and demo: [docs/phase-8-impact-metrics.md](docs/phase-8-impact-metrics.md).

## Escalation waves

When no NGO accepts a listing, who is told widens on a persisted, configurable schedule (the spec's example: NGO wave at T+3 min within 3 km, T+15 within 6 km, a runner wave at T+25, T+35 within 10 km, an admin alert at T+45). Publishing no longer notifies every eligible NGO at once: each wave tells only **newly eligible** organizations, best match score first, up to a batch size, after **re-checking eligibility from live data**. The runner wave tells only eligible, available runners; the final admin alert is deduplicated. Pending waves stop the instant the listing is accepted, cancelled or expired (a database trigger, plus a re-check before each step); overlapping workers and retries cannot send duplicates (advisory locks, a run-once step rule, unique recipients, notification dedupe keys). URGENT and CRITICAL listings escalate faster. Every timing, radius, batch size and interval is configuration (`ESCALATION_*`, pilot defaults and a seconds-scale demo profile in `.env.example`), validated at startup. The admin board shows each listing's stage and wave history. `ESCALATION_ENABLED=false` restores notify-everyone-at-publish. Details, eligibility rules, demo and limitations: [docs/escalation-waves.md](docs/escalation-waves.md).

## Admin live operations board

`/admin/board` (admins only): rescue counts and lists by state (**active, delayed, failed, completed, cancelled**), server-side filters (state, provider, NGO, runner, transport, start date, minimum age, blocked, needs-an-admin), search and pagination, plus live listings **nobody has accepted yet** (with urgency and eligible-NGO counts; expired and cancelled ones are shown as non-actionable). Each rescue shows its stage, next responsible party, deadline, time in stage and, when delayed, why and which action is overdue, with links to its page, audit history and incidents. "Delayed" is the warning state before a hard deadline closes a rescue: blocked by an open blocking incident, past the pickup window, or at least `OPS_DELAYED_ELAPSED_PERCENT` (default 75) of the stage's allowed time used. Read-only: interventions use the existing audited admin actions. Updates arrive over the authenticated Socket.IO channel with a 15-second polling fallback. API under `/api/v1/admin/board`. Definitions, API, demo and limitations: [docs/admin-live-operations-board.md](docs/admin-live-operations-board.md). Repeatable browser walkthrough: [e2e/README.md](e2e/README.md).

## Production security and operations (Phase 7)

- **Two connections.** The API runs as `foodloop_runtime` (`DATABASE_URL`): not a superuser, owns nothing, cannot change the schema or update/delete audit history (`rescue_events`, `listing_events`, `verification_events`, `incident_evidence` are insert/select-only). Migrations, seed, role setup and retention use `MIGRATION_DATABASE_URL`. The API never reads that URL and, in production, refuses to start if its database role is over-privileged. Startup output and logs never include passwords or connection strings.
- **Rate limits** for auth, uploads, rescue actions, incident reports and location updates (`RATE_LIMIT_*`, per user or IP, consistent `429`). Per-process counters.
- **Retention:** `npm run retention` is a dry run; `npm run retention -- --execute` removes resolved incident evidence/incidents and orphaned files **only** for periods you configure (`RETENTION_*`). Nothing is deleted by default.
- **Single node by design** (sweeps are advisory-locked, but sockets, counters and files are per process); no malware scanning; backups and deployment are not automated.

Full procedures (role setup, migration from the shared superuser, permissions, retention, recovery) and the remaining blockers: [docs/phase-7-security-operations.md](docs/phase-7-security-operations.md).

## API (v1)

Base `/api/v1`. Responses use `{ success, data, meta.requestId }` / `{ success:false, code, message, details, meta }`.

Escalation adds `/admin/board/listings/:id/escalation`; the operations board adds `/admin/board/*`; Impact adds `/impact/me` and `/impact/platform`; Phase 6 adds `/rescues/available-runs`, runner/location/incident routes under `/rescues/:id/…`, `/runner/profile` and `/incidents…`; Phase 5 adds `/listings/:id/accept` and `/rescues…`; Phase 4 adds `/listings/:id/matches`, `/listings/recommended` and `/notifications`; Phase 3 adds `/listings…` and `/ngo-requirements…`; Phase 2 adds `/organizations…` and `/admin/verifications…` (see the phase docs). Phase 1:

`GET /health` · `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` · `PATCH /auth/me` · `GET /access/{provider|ngo|runner|admin|admin-only}` (authorization probes).

Auth uses httpOnly cookies (short-lived access JWT + rotating opaque refresh token stored hashed server-side). Nothing credential-like is kept in localStorage. Details in the decisions doc.

## Project layout

```
apps/api   Express API, Drizzle schema + SQL migrations (drizzle/), seed, private file storage, tests
apps/web   Next.js app (proxies /api/* to the API)
docs/      Phase 0 decisions, Phase 2 organizations, Phase 3 supply and demand, Phase 4 matching, Phase 5 rescues, Phase 6 runner logistics, Phase 7 security and operations, impact metrics, admin operations board, escalation waves
```

## Next phase

No further phase is started. The specification's remaining items are the admin live board, impact metrics and polish (its Phase 8), and deployment, backups and observability (its Phase 9); see the Phase 7 doc for what is deferred.
