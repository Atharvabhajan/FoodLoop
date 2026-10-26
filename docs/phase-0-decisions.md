# FoodLoop — Phase 0 Decisions (frozen baseline)

Source of truth: *FoodLoop V1 Product & Technical Specification v1.0* (06 Oct 2026). Items marked **[Assumption]** are not specified and are chosen here; items marked **[Spec]** follow the spec's stated default.

## 1. V1 objective and non-goals

**Objective.** Prove one complete rescue loop (listing → match → reserve → transport → pickup/delivery proof → verified impact) among Food Providers, NGOs, Rescue Runners and Admins. FoodLoop is a coordination and logistics network, not a food-ordering marketplace. [Spec]

**This milestone (Phases 0–1)** delivers only identity, roles, the schema foundation, and the tooling around them.

**Non-goals** (spec §10.2, plus this milestone): consumer food ordering, payments, dynamic pricing, restaurant menus, AI chatbot/AI matching, multi-warehouse inventory, fleet optimization, native apps. Not built yet (later phases): organization onboarding/verification, listings, NGO requirements, matching, rescues, runner logistics, notifications, maps, impact, background jobs/Redis.

## 2. Roles and permission boundaries

| Role | `platform_role` | Phase 1 boundary |
|---|---|---|
| Food Provider | `provider` | Own profile; provider test route only |
| NGO / Organization | `ngo` | Own profile; NGO test route only |
| Volunteer / Rescue Runner | `runner` | Own profile; runner test route only |
| Admin | `admin` | Own profile; admin route and `platform:manage` |

- Authorization is enforced by Express middleware (`requireRole`, `requirePermission`) after authentication; the frontend only uses the role to choose a page.
- Permissions are a code table (`apps/api/src/http/permissions.ts`) mapping role → permission strings. Later phases add organization-scoped checks on top.
- **[Assumption]** In Phase 1 Admin does **not** inherit other roles' routes. The spec's "Override/support" capabilities arrive later as explicit, reason-required, audited admin actions (spec §2.2), not as implicit access.
- **[Assumption]** Admin accounts cannot be self-registered; they are created by the seed (dev) or directly by an operator.

## 3. Users, organizations, memberships, volunteer profiles

```
users 1 ──< organization_members >── 1 organizations
users 1 ── 0..1 volunteer_profiles
users 1 ──< sessions
```

- A **person** (`users`) is separate from an **organization** (`organizations`, type `PROVIDER` or `NGO`). One login ≠ one business. [Spec §2.1]
- `organization_members` links them with `member_role` (`owner | manager | operator`) and `status`. Unique per (user, organization).
- `volunteer_profiles` holds runner-specific state (Phase 1: availability only; vehicle, capacity, radius, geo point arrive in Phase 6).
- **Effective role.** A user's effective *platform* role is `users.platform_role` — a single value read from the database on every request (never trusted from the token). Organization-scoped authority is `organization_members.member_role` for an `ACTIVE` membership in that organization; it never raises the platform role. A provider or NGO user therefore needs both the platform role *and* an active membership for org-scoped actions (enforced from Phase 2).
- **[Assumption]** Registering as provider/NGO creates the user, a new organization (`verification_status = UNSUBMITTED`) and an `owner` membership in one transaction. Runner registration creates a `volunteer_profiles` row. Joining an *existing* organization (invitations) is deferred.
- Organizations cannot participate in rescues until `VERIFIED` (BR-02) — enforced when matching exists; no verification workflow yet.

## 4. Identity schema and migration approach

- **ORM / migrations: Drizzle ORM + drizzle-kit.** Schema in TypeScript (`apps/api/src/db/schema.ts`); `drizzle-kit generate` emits plain SQL files in `apps/api/drizzle/`, committed and applied by `npm run db:migrate`. Chosen over Prisma because Drizzle treats raw SQL migrations and PostGIS-style custom types as first-class, and has no query-engine binary.
- Tables (Phase 1): `users`, `organizations`, `organization_members`, `volunteer_profiles`, `sessions`. Enums: `platform_role`, `user_status`, `organization_type`, `verification_status`, `member_role`, `member_status`, `availability_status`.
- IDs are server-generated UUIDs; timestamps are `timestamptz`. [Spec App. A]
- Email uniqueness is a unique index on `lower(email)`. [Spec §4.2]
- **PostGIS:** migration `0001_enable_postgis.sql` runs `CREATE EXTENSION IF NOT EXISTS postgis` when the server has PostGIS available and emits a NOTICE otherwise. Phase 1 stores no geometry, so the migration set applies on a server without PostGIS. **Phase 4 (matching) hard-requires PostGIS**; geometry columns/GiST indexes will be added by later migrations using hand-written SQL.
- Never edit an applied migration; add a new one.

## 5. Authentication and session/token handling

- Passwords: **bcrypt** (`bcryptjs`, cost 12 by default via `BCRYPT_COST`), 10–72 byte passwords with a letter and a number. Login runs a dummy comparison for unknown emails and returns one identical `INVALID_CREDENTIALS` error to avoid account enumeration.
- **Access token:** HS256 JWT (claims `sub`, `sid`), 15 min, in an `httpOnly`, `SameSite=Lax` cookie `fl_access` (`Secure` when `COOKIE_SECURE=true`, mandatory in production).
- **Refresh token:** opaque 256-bit random value in `httpOnly` cookie `fl_refresh`, path-scoped to `/api/v1/auth`, 14 days. Only its SHA-256 hash is stored in `sessions`. It is **rotated on every refresh** with compare-and-swap, so a replayed old token fails.
- **Immediate revocation:** the auth middleware checks the session row (not revoked, not expired, user `ACTIVE`) on every request. Logout sets `revoked_at`; the stale access JWT stops working at once.
- **No tokens in localStorage / JS-readable storage.** The browser holds only httpOnly cookies; on page load the SPA calls `GET /auth/me` to restore the session (and silently refreshes once on expiry).
- **CSRF:** `SameSite=Lax` cookies + an `Origin` allow-list check on all state-changing requests.
- **CORS:** explicit allow-list from `CORS_ALLOWED_ORIGINS`; `*` is rejected at startup. The web app proxies `/api/*` to the API (Next.js rewrite), so browsers talk to one origin and cookies stay first-party.
- **Rate limiting** on register/login/refresh (60 per 15 min per IP; configurable off for tests). Body limit 100 kB. `helmet` headers.
- **[Assumption]** Deviation from the spec's env list: there is no `JWT_REFRESH_SECRET` because refresh tokens are opaque and server-stored rather than signed. Password reset/recovery (spec §1.1) is **deferred** to a later phase (needs an email channel).

## 6. API versioning and response/error format

- Base path `/api/v1`; plural nouns; explicit command endpoints for domain transitions. [Spec §6]
- Success: `{ "success": true, "data": {...}, "meta": { "requestId": "req_..." } }`
- Error: `{ "success": false, "code": "UPPER_SNAKE", "message": "...", "details": {}, "meta": { "requestId": "req_..." } }`; validation errors put per-field messages in `details.fields`.
- Every response carries `X-Request-Id`. Unexpected errors return `INTERNAL_ERROR` with a generic message; details go to server logs only (never stack traces, SQL, secrets or hashes).
- Phase 1 endpoints: `GET /health`, `POST /auth/register|login|refresh|logout`, `GET /auth/me`, and `GET /access/{provider|ngo|runner|admin|admin-only}` (authorization probes, no business behavior).
- Health: `200` with `{api, database, realtime}` or `503 DATABASE_UNAVAILABLE` with no connection details.

## 7. Native local PostgreSQL / PostGIS setup

**Docker and containers are not used.** Use PostgreSQL installed on the host.

- Windows (detected: PostgreSQL 18.4 service running): install PostGIS for PostgreSQL 18 with **Stack Builder → Spatial Extensions → PostGIS**, then restart the service. macOS: `brew install postgresql@17 postgis`. Debian/Ubuntu: `sudo apt install postgresql postgis`.
- Create `.env` from `.env.example`, set `DATABASE_URL`/`TEST_DATABASE_URL` with your own credentials, then `npm run db:setup` creates the databases if missing and reports PostGIS availability. Full steps in the README.
- Tests run against a **separate** `*_test` database and refuse to run against a database whose name does not contain `test`.

## 8. Seed-data approach

- `npm run db:seed` (development only; refuses when `NODE_ENV=production`) upserts four demo accounts — one per role — plus a demo provider org ("Campus Canteen") and NGO org ("Hope Community Kitchen"), both pre-set to `VERIFIED` for later demo phases (spec §14).
- All four share one password read from `DEMO_PASSWORD`; there is **no default** and the command fails if it is unset or weak. Re-running re-syncs the password and does not duplicate rows.
- Demo emails use the reserved `.test` TLD: `provider@`, `ngo@`, `runner@`, `admin@demo.foodloop.test`.
- Each later phase extends the seed and adds at least one automated test for its critical rule (spec §11.2).

## Remaining assumptions to confirm

1. Admin does not implicitly access other roles' routes in Phase 1.
2. Registration creates an unverified organization for providers/NGOs.
3. Password recovery and Socket.IO events are deferred; Socket.IO is only attached and health-reported.
4. Redis/BullMQ, object storage, Leaflet and email are deferred (spec marks them optional/later).
