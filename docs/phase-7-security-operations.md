# Phase 7: Production security and operational hardening

This phase adds no product features. It removes the shared PostgreSQL superuser from runtime use and hardens the operational edges of what already exists (rate limits, retention, uploads, logging, workers, sockets).

> **Scope note.** The product specification (section 11) numbers its own phases differently: its Phase 7 is "Real-time and operations" (Socket.IO, in-app notifications, admin live board, incidents), Phase 8 is "Impact and polish" and Phase 9 is "Hardening" (tests, security checks, deployment, backups, observability). Sockets, notifications and incidents already exist from Phases 5 and 6. This work follows the explicit hardening brief and is a **subset of the spec's Phase 9**. Still not built: the admin live board, impact metrics, automated backups, deployment and observability (see [Remaining blockers](#remaining-pre-deployment-blockers)).

## 1. Two database connections

| | Runtime | Privileged |
|---|---|---|
| Variable | `DATABASE_URL` | `MIGRATION_DATABASE_URL` |
| Login | `foodloop_runtime` (least privilege) | table owner / superuser (for example `postgres`) |
| Used by | the running API only | `db:setup`, `db:migrate`, `db:seed`, `db:roles`, `db:check-postgis`, `retention` |
| Can change schema / rewrite audit history | **no** | yes |

Rules the code enforces:

- The API reads **only** `DATABASE_URL`. It never reads `MIGRATION_DATABASE_URL` and never falls back to another login (a test scans the API sources for this).
- Privileged commands use `MIGRATION_DATABASE_URL`. In **production it is mandatory**. Outside production, if it is unset, they fall back to `DATABASE_URL` **with a printed notice**, so the original single-credential development setup keeps working until you migrate it.
- Production config refuses to load if `DATABASE_URL` and `MIGRATION_DATABASE_URL` (when visible to the API process) log in as the same user on the same server.
- Commands print the connection as `user@host:port/database` only. Passwords and connection strings are never printed.

## 2. The runtime role

Created by `npm run db:roles` (privileged, idempotent, safe to re-run after every migration):

- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, connection limit 20, member of no other role. Attributes are **forced back** on every run, so an accidental elevation is corrected.
- `statement_timeout = 30s`, `idle_in_transaction_session_timeout = 60s`.
- Owns nothing; `CREATE` on the `public` schema and on the database is revoked; no access to the `drizzle` migration schema.
- The password is stored as a **SCRAM-SHA-256 verifier computed locally**, so the plaintext is never sent to the server or appears in its statement logs.

### Runtime permissions

| Table | Runtime privileges |
|---|---|
| `users`, `sessions`, `organizations`, `organization_members`, `ngo_requirements`, `food_listings`, `notifications`, `rescues`, `rescue_assignments`, `volunteer_profiles` | SELECT, INSERT, UPDATE (no DELETE, no TRUNCATE) |
| `verification_documents`, `match_candidates`, `rescue_locations` | SELECT, INSERT, UPDATE, DELETE (the app deletes these by design) |
| `incident_reports` | SELECT, INSERT, UPDATE on the five resolution columns only (`status`, `resolved_by`, `resolved_at`, `resolution_code`, `resolution_note`) |
| `rescue_events`, `listing_events`, `verification_events`, `incident_evidence` | **SELECT, INSERT only** (append-only audit history) |
| `retention_runs` | none (operator only) |
| `spatial_ref_sys` (PostGIS) | read via PostGIS's own default; PostGIS functions are executable through `PUBLIC` |
| sequences | USAGE, SELECT |

No role gets `TRUNCATE`, `TRIGGER` or `REFERENCES` on anything. Every table must appear in `RUNTIME_GRANTS` (`apps/api/src/db/roles.ts`): a migration that adds a table fails `db:roles`, `db:migrate` and a test until someone decides what the API may do with it.

### Layers protecting audit history

1. **Privileges:** the runtime role cannot UPDATE, DELETE or TRUNCATE the audit tables, drop or disable their triggers, or replace their functions (it owns nothing), and cannot set `session_replication_role`.
2. **Triggers:** reject UPDATE and DELETE on `rescue_events`, `listing_events`, `verification_events`, `incident_evidence`; make incident report content immutable and resolution one-way. These hold even for the table owner.
3. **No TRUNCATE trigger.** Earlier phase notes claimed `TRUNCATE` was rejected by triggers; that was inaccurate (the triggers cover UPDATE and DELETE). Today `TRUNCATE` is stopped by **privileges** for the runtime role; the owner/superuser can still truncate, which is why the privileged credential must be guarded (and why the test suite can reset data).

### Startup validation

On start the API inspects the connection it actually has (not its configuration) and checks: superuser, createrole, createdb, replication, bypass-RLS, membership in `pg_read_all_data`, `pg_write_all_data`, `pg_execute_server_program`, `pg_read/write_server_files`, `pg_signal_backend`; `CREATE` on schema/database; ownership of any table or function; and `TRUNCATE`/`TRIGGER`/`REFERENCES` anywhere, `UPDATE`/`DELETE` on audit tables, `DELETE` on `incident_reports`.

- `DB_PRIVILEGE_CHECK=enforce` (the **default and only allowed value in production**): any finding stops startup with a short, secret-free message that names the fix.
- `warn` (default elsewhere): starts, and logs a warning with the finding codes **on every start**, so the legacy setup is never silent.
- Also refused at startup: a missing/invalid required setting; production without `COOKIE_SECURE=true` or with `RATE_LIMIT_ENABLED=false`; an unreachable database (message contains no credentials).

## 3. Setting it up

### New installation

1. Create `.env` from `.env.example`. Set `MIGRATION_DATABASE_URL` to the privileged login and `RUNTIME_DB_PASSWORD` to a new random value of at least 16 characters (for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
2. `npm run db:setup` then `npm run db:migrate` (privileged).
3. `npm run db:roles`: creates the role, applies grants, and **verifies by logging in as the role**.
4. Set `DATABASE_URL=postgres://foodloop_runtime:<that password>@host:5432/foodloop` and delete `RUNTIME_DB_PASSWORD` from `.env`.
5. `npm run db:seed` (development only; privileged), then run the app.

### Migrating from the shared-superuser setup (existing data kept)

No data is dropped, reset or reseeded. Roughly one minute:

1. **Back up first** (section 8).
2. `npm run db:migrate` — applies `0013_retention_and_purge.sql` (new `retention_runs` table; purge-aware incident triggers) using your current credential (you will see the "legacy single-credential" notice).
3. In `.env` add `MIGRATION_DATABASE_URL=` with the **current** `DATABASE_URL` value, and add `RUNTIME_DB_PASSWORD=` (new random value).
4. `npm run db:roles` — expect `Created role "foodloop_runtime"` and `Verified: connecting as ... holds no excessive privileges`.
5. Change `DATABASE_URL` to the runtime login; remove `RUNTIME_DB_PASSWORD`.
6. Start the API. In production the log line `FoodLoop API listening` includes `"dbRole":"foodloop_runtime","dbRoleClean":true`.

**Rollback:** set `DATABASE_URL` back to the value stored in `MIGRATION_DATABASE_URL` (the API then warns on every start in development, and refuses in production). The role and migration are harmless to leave in place. Migrations are forward-only.

**Rotation:** set `RUNTIME_DB_PASSWORD` to a new value, run `npm run db:roles`, update `DATABASE_URL`, remove the variable, restart the API.

**After every migration** run `npm run db:migrate` (it re-applies grants automatically if the role exists) so new tables are decided before the API uses them.

### Production notes

Run the API with `NODE_ENV=production`, `COOKIE_SECURE=true`, `DATABASE_URL` (runtime) and **not** `MIGRATION_DATABASE_URL` in its environment; run privileged commands from an operator shell that has the privileged URL. Use `?sslmode=require` (or stronger) in both URLs for any non-local database; this repository does not configure database TLS for you.

## 4. Rate limits

Fixed-window limits, counted **per signed-in user** (from the signature-verified access token) or **per client IP** before sign-in. A forged or expired token falls back to the IP bucket, so it cannot pick its own bucket. Only state-changing requests are counted. Defaults, all overridable with `RATE_LIMIT_<NAME>_MAX` and `RATE_LIMIT_<NAME>_WINDOW_SECONDS`:

| Limiter | Covers | Default |
|---|---|---|
| `AUTH` | register, login, refresh | 60 per 15 min per IP |
| `UPLOAD` | verification documents, listing images, incident evidence | 20 per 10 min |
| `RESCUE_ACTION` | accept, confirm, verify, hand over, release, cancel, admin rescue actions, claim | 120 per 5 min |
| `INCIDENT` | incident reports | 10 per 15 min |
| `LOCATION` | runner position updates (the existing per-rescue minimum interval still applies) | 60 per 1 min |

A limited request gets `429` with the standard error body (`code: RATE_LIMITED`, `details: { limiter, retryAfterSeconds }`), a `Retry-After` header and draft-7 `RateLimit` headers, and is refused **before** any upload body is read. Each request is counted by exactly one limiter. Defaults leave ordinary workflows untouched (a complete runner rescue is tested with limiting on). Limits are off by default only in the test configuration; production refuses `RATE_LIMIT_ENABLED=false`.

`TRUST_PROXY_HOPS` (default 0) controls whether `X-Forwarded-For` is trusted. Behind the Next.js rewrite or a load balancer set the real hop count (usually 1), otherwise every client looks like one IP; leave it 0 when the API is directly exposed so the header cannot be spoofed to escape a limit.

## 5. Retention and purge

Policy, set in `.env` (all unset by default, which means **nothing is ever deleted**):

| Variable | Minimum | Meaning |
|---|---|---|
| `RETENTION_EVIDENCE_DAYS` | 7 | evidence photos (file and row) of resolved incidents, counted from the day of resolution; the report text stays |
| `RETENTION_INCIDENT_DAYS` | 30, and not shorter than the evidence period | the whole resolved incident (report and any remaining photos) |
| `RETENTION_ORPHAN_FILE_HOURS` | 1 | files in storage that no row references and that are older than this (debris from failed uploads) |

Only **resolved** incidents on **closed** rescues (`COMPLETED`, `CANCELLED`, `EXPIRED`, `PICKUP_FAILED`) are eligible; open incidents and incidents on rescues still in progress or awaiting admin follow-up are never touched. The rescue's own event history is never deleted.

Operator procedure (privileged connection, run from an operator shell):

1. `npm run retention` — **dry run (default)**. Prints counts only (never file names or text) and changes nothing.
2. Review the counts. Take a backup (section 8).
3. `npm run retention -- --execute` — applies it. Exit code 1 if any item failed; re-running is safe.
4. Schedule it yourself if you want it regular (cron or Task Scheduler). Nothing runs it automatically.

Behaviour: files are removed first, then rows, per incident in its own transaction; a file that cannot be removed keeps its row and is reported (the next run finishes it); an already-missing file counts as removed. Each purge appends a `RETENTION_PURGED` event to the rescue (ids and counts only) and each executed run adds a counts-only row to `retention_runs`. `--execute` with no period configured refuses and exits 1.

How the database allows it: migration `0013` lets the incident triggers permit a DELETE only inside a transaction that sets `foodloop.retention_purge = 'on'` **and** only for `RESOLVED` incidents (and their evidence). The runtime role has no DELETE privilege on those tables at all, so it cannot use the switch. Anyone holding the privileged credential can, which is why that credential stays with operators. **Purges are irreversible**; recovery is from a backup.

## 6. Uploads

Reviewed and unchanged unless noted:

- **Validation:** content sniffing (PDF/PNG/JPEG magic bytes; the declared type and filename are ignored), extension must match the sniffed type, size limits (5 MB documents, 3 MB images), EXIF/text metadata stripped from images, malformed images rejected. Client file names never reach the disk; keys are server-generated UUIDs; keys resolving outside the storage root are refused.
- **Authorization** happens before the body is read; files are served only through authorized routes with `Cache-Control: private, no-store` and `nosniff`.
- **Failure cleanup:** a stored file is removed when its database write fails (verified for evidence and enforced for documents and listing images). Changed in this phase: the 3-photo limit on incident evidence is now enforced **inside the insert transaction under a row lock** (it was a check-then-insert race); six concurrent uploads keep exactly three and leave no files from the refused ones.
- Storage failures return a generic `500` with no paths. Orphans left by a crash or a failed `remove()` are found and removed by `npm run retention` with `RETENTION_ORPHAN_FILE_HOURS` set (dry run first).
- **There is no malware scanning.** Nothing in the upload path scans content, and this phase does not add it. Uploaded documents are visible to admins and (for evidence) the rescue's parties; treat them as untrusted files.

## 7. Single node by design

The application is **explicitly a single-instance deployment**. Do not run two API processes behind a load balancer.

| Component | Behaviour with a second process |
|---|---|
| Expiry and rescue sweeps | now guarded by Postgres advisory locks: an overlapping process skips a sweep another is running, and the sweeps were already idempotent. This protects the sweeps only |
| Socket.IO rooms | in memory; nudges reach only sockets on the process that handled the change (REST polling still converges, but it is not "safe" multi-node) |
| Rate-limit counters | in memory per process; the effective limit multiplies with the instance count |
| Uploaded files | local disk; a second host would not see them |

Database-backed coordination was used where it was cheap and testable (the sweeps). Making sockets, counters and files multi-node needs shared infrastructure (an adapter or pub/sub, a shared store, object storage), which this phase deliberately does not add; Redis and Docker were not introduced. Socket.IO additionally now caps concurrent sockets per user (10) and bounds its buffer and handshake time.

## 8. Logging, errors and recovery

**Logging.** All structured logs go through `src/log.ts`: sensitive field names (passwords, tokens, cookies, pickup codes, coordinates, emails, phones, addresses, free-text descriptions, storage keys, SQL parameters, connection strings) are replaced wholesale, and every string is scrubbed for connection strings, JWTs, bearer tokens, session cookies, emails, high-precision decimals, rejected input values and the SQL/parameters that Drizzle appends to failed-query messages. Unexpected request errors log only a name, a driver error code and a scrubbed message; clients receive a generic `500`. There is no request-body or access logging. Database server logs are outside the application's control: if the server runs with `log_statement=all`, statements and bound parameters (including coordinates) are recorded there, so do not enable it on a production database.

**Backups (not automated).** Back up the database with the privileged login and the storage directory together (evidence and documents live on disk): `pg_dump -Fc -f foodloop.dump "<privileged url>"` plus a copy of `STORAGE_DIR` (default `storage/uploads/`). Roles are cluster-level and not in a `pg_dump`; after restoring into a new cluster run `npm run db:roles` to recreate the runtime role and grants. Restore into an empty database with `pg_restore`, then `npm run db:migrate`. Test a restore before relying on it.

**Recovery quick reference**

| Situation | Action |
|---|---|
| API refuses to start with "excessive privileges" | `DATABASE_URL` is a privileged login. Run `npm run db:roles`, use the runtime login |
| Runtime role missing or over-privileged | `npm run db:roles` (re-run; forces attributes and grants back) |
| `db:migrate` fails with "No runtime grant decision for table" | add the table to `RUNTIME_GRANTS` in `apps/api/src/db/roles.ts`, then re-run |
| Lost runtime password | rotate (section 3) |
| Retention removed too much | restore database and storage from the backup taken before `--execute` |
| Orphan files or rows pointing at missing files after a crash | `npm run retention` (dry run, then `--execute`) with the orphan period set |

## 9. Verification performed

See the final report for exact command output. Automated: the existing suite now runs the **whole application as the least-privilege role** (random per-run password, created by test global setup), plus new tests for: least privilege and schema/audit protection (37), connection selection and configuration (19), real server-process startup in production and development (6), rate limits (12), retention dry run, guarded deletion, failures, orphans and the CLI (22), upload failure cleanup and validation (10), and logging redaction (22).

## Remaining pre-deployment blockers

These are not done, and the project must **not** be called production-ready until they are:

1. **Not yet exercised on a real production topology.** The runtime role, startup refusal and retention were verified on a local PostgreSQL 18 cluster only, not on the deployment database, host or network.
2. **No automated backups, restore test, monitoring, alerting, or log shipping** (spec Phase 9). Retention is operator-run, not scheduled.
3. **TLS** to the database and in front of the app is not configured by this repository; `COOKIE_SECURE=true` requires HTTPS.
4. **Secrets management:** credentials live in `.env`. Use your platform's secret store in deployment; rotate `JWT_ACCESS_SECRET` and the runtime password on a schedule.
5. **Privileged credential still exists and is powerful** (superuser locally). It must be restricted to operators; the runtime separation protects against application compromise, not against whoever holds it. Prefer a dedicated non-superuser owner role in production.
6. **No malware scanning** of uploads; evidence and documents sit on local disk.
7. **Single node only** (section 7); no horizontal scaling story.
8. Defaults left to PostgreSQL's `PUBLIC` grants: the runtime role can still create temporary tables and use `PUBLIC`-executable functions. Revoke further at the cluster level if your policy requires.
9. Not part of this phase and still open from earlier phases: admin live board, impact metrics, admin MFA/account recovery, dependency vulnerability audit, external tile server terms for the map.
