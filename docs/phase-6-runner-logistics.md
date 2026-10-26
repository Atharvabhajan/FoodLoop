# Phase 6: Runner-assisted rescue logistics

A verified NGO can ask a volunteer **runner** to collect surplus food from the provider and deliver it. Direct NGO pickup (Phase 5) is unchanged and remains the default. This phase adds runner profiles and eligibility, a concurrency-safe claim, transit tracking with optional shared position, maps, incident reporting and admin resolution, and the failure paths around all of them.

## Lifecycle

Direct pickup (unchanged): `RESERVED → PICKUP_ASSIGNED → PICKUP_CONFIRMED → RECIPIENT_CONFIRMED → COMPLETED`.

Runner mode (`transport_mode = RUNNER`, only allowed when the listing requests transport):

```
RESERVED ──provider confirms──▶ AWAITING_RUNNER ──runner claims──▶ PICKUP_ASSIGNED
   (pickup code issued to provider; runner search starts)            │ runner verifies code
                                                                      ▼
COMPLETED ◀─NGO confirms quantity─ DELIVERED ◀─runner hands over─ IN_TRANSIT  (PICKUP_CONFIRMED is passed through in the same step)
```

- **Release / reassign:** the runner releases (with a reason) or an admin reassigns: back to `AWAITING_RUNNER`. A runner who released a rescue is never offered it again.
- **NGO collects instead:** while no runner holds the job, the NGO can choose "Collect it myself" (`AWAITING_RUNNER → PICKUP_ASSIGNED`, mode `NGO_PICKUP`), and then verifies the code itself as in Phase 5.
- **Terminal:** `COMPLETED`, `CANCELLED`, `EXPIRED`, `PICKUP_FAILED`. `DELIVERY_FAILED` needs admin follow-up (`ADMIN_RESOLVE`).
- **Who completes a rescue:** only the NGO confirming the received quantity, or an admin entering a verified quantity. A runner can never mark a rescue delivered-and-complete, and a failed or disputed delivery is never turned into a success by a runner.

### Failure paths

| Situation | Result |
|---|---|
| No runner accepts before the search deadline (`RESCUE_RUNNER_SEARCH_MINUTES`, capped by the pickup deadline) | `EXPIRED` (`NO_RUNNER_FOUND`), listing released, admins notified |
| Runner declines/releases/cancels or admin reassigns | back to `AWAITING_RUNNER`, search window restarts, that runner excluded |
| Pickup not verified in time | `PICKUP_FAILED`, listing released |
| In transit longer than `RESCUE_TRANSIT_MINUTES` | `DELIVERY_FAILED` (admins notified) |
| Delivery not confirmed by the NGO in time | `DELIVERY_FAILED` (admins notified) |
| Blocking incident reported | normal forward steps stop until an admin resolves it |
| Admin intervention | `ADMIN_CANCEL`, `ADMIN_FAIL`, `ADMIN_RESOLVE` (all audited, reason required) |

Expiry is settled on every read and transition under row locks, plus an idempotent in-process worker, so a delayed timer is harmless.

## Permissions

| Action | Who |
|---|---|
| Request a runner (accept with `transportMode: RUNNER`) | NGO member, listing must request transport |
| Confirm hand-off, issue/regenerate pickup code | provider |
| See and claim available jobs, release, hand over, share position | runner (`runner` role) |
| Verify pickup | runner in runner mode; NGO in `NGO_PICKUP` mode |
| Confirm quantity received | NGO |
| Read runner position | provider and NGO parties, admins |
| Report an incident | any party to an in-progress rescue (not admins; runners only while they hold it) |
| Resolve incidents, reassign, fail | admin |

Non-parties get `404` (existence is not revealed); parties acting outside their role get `403`. A runner is a party only to rescues they hold or have held.

## Runner profile and assignment rules

`PUT /runner/profile`: availability (`OFFLINE`/`AVAILABLE`), vehicle (`FOOT`, `BICYCLE`, `SCOOTER`, `CAR`, `VAN`), capacity (kg), travel radius (km) and a base location. A runner can only be set `AVAILABLE` with all of them. The base location is **rounded to 2 decimals (about 1 km)** before storing.

A runner is offered or can claim a job only if **all** hold, evaluated live in PostGIS at claim time (what the list shows is never trusted):

1. available, complete profile with a base location, not already holding an active rescue, and has not previously released this rescue;
2. within `min(runner radius, platform radius)` of the pickup;
3. capacity ≥ load (`estimatedKg`, else servings × `RUNNER_KG_PER_SERVING`);
4. can reach the pickup in time (same estimate model as matching: straight-line distance, no routing provider).

Claim safety: the rescue row is locked (`FOR UPDATE`), and partial unique indexes allow **one active assignment per rescue and one per runner**. Eight simultaneous claims produce exactly one winner (tested). Losers receive `409`.

## Privacy and proof

- **Staged disclosure:** a runner sees only areas and estimates until they hold the job; the exact pickup/delivery addresses and organization **phone numbers** appear only for the holder during `PICKUP_ASSIGNED`/`IN_TRANSIT`/`DELIVERED`. Runners never receive provider/NGO emails or the pickup code (the provider reads it out at pickup). Parties see the runner's name, and the phone number only while the food is moving.
- **Proof of pickup** is the provider's one-time code (hashed, attempt-limited, as in Phase 5). **Proof of delivery** is the NGO confirming the quantity. No signatures, ID documents or customer photos are collected.
- Notifications, events and sockets never contain addresses, codes or incident text.

## Location handling

- Sharing is **opt-in**, per session, offered only to the runner holding the job while collecting or delivering. The browser throttles updates to one per 15 s; the server enforces a minimum interval (`RUNNER_LOCATION_MIN_INTERVAL_SECONDS`, default 5 s, `429` otherwise).
- Stored **rounded to 3 decimals (about 100 m)**, as a **single latest row per rescue** (no trail). The row is deleted when tracking stops: handover, release, cancel, reassign, expiry, failure or completion.
- Reads (`GET /rescues/:id/location`) are limited to the provider, NGO and admins, only while tracking, and never return a position older than `RUNNER_LOCATION_MAX_AGE_MINUTES` (default 10). The response carries no identity, accuracy or speed. Runners cannot read positions back.
- A manual "send this position" form is provided for devices without geolocation and for demos.
- Maps use **Leaflet** with OpenStreetMap tiles (attribution shown). Markers are circles plus a text list, so the page is complete when tiles cannot load. Positions are straight-line, not routes.

## Incidents

Categories: `FOOD_SAFETY`, `QUANTITY_MISMATCH`, `PICKUP_PROBLEM`, `DELIVERY_PROBLEM`, `RUNNER_UNAVAILABLE`, `OTHER`; severity `LOW`…`CRITICAL`. A report is **blocking** when severity is `HIGH`/`CRITICAL` or the category is `FOOD_SAFETY`: it pauses the rescue's forward steps (`409 RESCUE_BLOCKED_BY_INCIDENT`) until an admin resolves it, and everyone involved plus admins are notified.

- Report content is immutable (database trigger). Repeating an identical report within two minutes returns the original.
- Evidence: up to 3 PNG/JPEG photos (≤ 3 MB) per incident from the reporter only, metadata stripped, stored privately, readable only by parties and admins; the table is append-only.
- Admin resolutions (`POST /incidents/:id/resolve`, note required, recorded once with the admin's identity and mirrored into the rescue history): `NO_ACTION`, `REASSIGN_RUNNER`, `CANCEL_RESCUE`, `FAIL_DELIVERY`, `COMPLETE_WITH_QUANTITY` (admin enters the verified quantity).

## Audit

`rescue_events` is append-only at the database level (update and delete rejected by triggers; the runtime role also holds no UPDATE/DELETE/TRUNCATE privilege on it, see [phase-7-security-operations.md](phase-7-security-operations.md)) and now includes runner assignment, search, incident and resolution events with their actor and role.

## Notifications and real time

Runners with a matching available profile get a `RUNNER_JOB` notification when a search starts; parties, runners and admins are notified of assignment, release, handover, failure and incidents. Socket.IO is an **id-only nudge** (`rescue.updated` with the rescue id) sent to authorized rooms; clients refetch over REST, and every page also polls (30 s; jobs 20 s), so it stays correct if sockets are blocked.

## API

All under `/api/v1`.

| Route | Role | Purpose |
|---|---|---|
| `POST /listings/:id/accept` `{transportMode?}` | NGO | `NGO_PICKUP` (default) or `RUNNER` |
| `GET /rescues/available-runs` | runner | jobs this runner could accept |
| `POST /rescues/:id/assign-self` | runner | claim a job |
| `POST /rescues/:id/runner/release` `{reason}` | runner | give the job back |
| `POST /rescues/:id/pickup/verify` | runner / NGO | verify the code (per mode) |
| `POST /rescues/:id/delivery/handover` `{note?}` | runner | record the handover |
| `POST /rescues/:id/delivery/confirm` | NGO | confirm quantity, completes |
| `POST /rescues/:id/transport/self` | NGO | collect it myself |
| `POST` / `GET /rescues/:id/location` | runner / parties+admin | share / read position |
| `POST /rescues/:id/admin/reassign`, `/admin/fail`, `/admin/resolve`, `/admin/cancel` | admin | exception handling |
| `POST /rescues/:id/incidents`, `…/:incidentId/evidence`, `GET …/evidence/:evidenceId` | parties | report and attach, view photo |
| `GET`/`PUT /runner/profile` | runner | availability and vehicle |
| `GET /incidents?status=OPEN\|RESOLVED\|ALL`, `GET /incidents/:id`, `POST /incidents/:id/resolve` | admin | incident queue and resolution |

## Migrations

`0011_runner_logistics.sql` (new statuses and enums, runner profile columns, `rescue_assignments`, `rescue_locations`, `incident_reports`, `incident_evidence`) and `0012_runner_integrity.sql` (partial unique indexes, the active-rescue index redefined by terminal states, `volunteer_profiles` geography column and trigger, incident immutability triggers). Both are forward-only and additive. They are split because a new enum label cannot be used in the same transaction that adds it.

## Demo flow

Seeds provide `runner@demo.foodloop.test` (bicycle, 25 kg, 8 km) and `runner2@demo.foodloop.test` (scooter, **2 kg**, deliberately too small for the 18 kg demo listing).

1. `ngo@`: **Live food → Accept this food**, keep "Ask a volunteer runner", confirm.
2. `provider@`: open the rescue, **Confirm hand-off**, note the pickup code. Status: "Looking for a runner".
3. `runner2@`: **Available jobs** is empty (not eligible; a forced claim returns `NOT_ELIGIBLE`).
4. `runner@`: **Available jobs → Accept this job**. Exact addresses appear; no code or emails. **Verify pickup** (try a wrong code first), then optionally share a position.
5. `ngo@`: follow the map and runner. `runner@`: **Hand over to the NGO**; the stored position is deleted.
6. `ngo@`: **Confirm food received** with a quantity. Completed.
7. Incident path: repeat to "on the way", then as the runner **Report a problem…** (Food safety, High, with a photo). The rescue pauses for everyone. `admin@`: **Incidents → open → Resolve** (e.g. "Record the delivery as failed"). The rescue ends as `DELIVERY_FAILED` with the resolution visible to the parties.

Set `RESCUE_RUNNER_SEARCH_MINUTES=1` to see the no-runner expiry quickly.

## Known limitations

- Distances and times are straight-line **estimates**, not routes; no routing or ETA provider.
- OpenStreetMap's public tile server is used for the demo map. Production needs a tile provider or self-hosted tiles under its usage policy; tiles reveal the viewing IP to that server.
- Runner choice is first-come among eligible runners: no ranking, waves, ratings or reliability scoring. One active rescue per runner; no batching.
- Runner identity/background checks are out of scope; the runner role is self-registered. Providers and NGOs see the runner's name and phone while food is moving.
- Position sharing relies on the page staying open in the foreground; there is no background tracking or offline queue.
- Incident handling is manual by admins; there is no SLA, escalation or reporter-visible chat.
- The in-process expiry worker assumes a single API process (correctness never depends on it).
- Uploaded evidence photos are stored on local disk, with no malware scanning.

## Unresolved security and operational risks

- **Shared superuser database credential (status at the end of Phase 6; superseded by Phase 7, which separates the runtime and privileged connections: see [phase-7-security-operations.md](phase-7-security-operations.md)):** migrations, seed and the running API all use one `DATABASE_URL`, which locally is the `postgres` superuser. Before any deployment, create a least-privilege runtime role (no DDL, no `TRUNCATE`, no superuser) with a separate migration connection and verify it. Until then, append-only triggers protect against application bugs but not against anyone holding the database credential.
- PostGIS privileges were not separated for the same reason (Phase 7: the runtime role has only the PostGIS access it needs).
- Rate limiting was not extended in Phase 6 beyond the per-rescue location interval and the duplicate-incident guard; review per-user and per-IP limits for claims, incident reports and uploads before exposure.
- Evidence and location data retention is by design short for locations (deleted when tracking ends), but there is no scheduled purge for old evidence photos or resolved incidents.
- Socket.IO and the in-process worker are single-node; scaling out needs a shared adapter and a distributed worker lock.
