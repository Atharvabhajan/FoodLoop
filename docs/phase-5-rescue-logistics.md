# Phase 5: Rescue Acceptance and Logistics

Builds on [phase-4-matching.md](phase-4-matching.md). An eligible verified NGO can **accept** a live listing; the provider **confirms** the hand-off; the NGO **verifies pickup** with a one-time code and **confirms what it received**; the rescue completes. This phase implements the spec's **direct NGO pickup** workflow (spec 3.1, state machine in section 7). Runner-assisted transport (spec 3.2), incident reports and impact totals are **not** built (Phase 6 onward).

## Lifecycle

```
(accept) ─▶ RESERVED ──provider confirms──▶ PICKUP_ASSIGNED ──NGO verifies pickup code──▶ PICKUP_CONFIRMED
              │                                  │                                            │
              │ provider declines / NGO or       │ NGO / provider / admin cancels             │ NGO confirms quantity received
              │ admin cancels ─▶ CANCELLED       │  ─▶ CANCELLED                              ▼
              │ confirm deadline ─▶ EXPIRED      │ pickup deadline + grace ─▶ PICKUP_FAILED   RECIPIENT_CONFIRMED ─(system)─▶ COMPLETED
                                                                                              │ delivery-confirm deadline
                                                                                              ▼
                                                                          DELIVERY_FAILED ─(admin resolves with reason)─▶ COMPLETED
```

Rules are one pure table in `modules/rescues/lifecycle.ts`; a test checks every (state, command) pair. Terminal states (`COMPLETED`, `CANCELLED`, `EXPIRED`, `PICKUP_FAILED`) never change. `DELIVERY_FAILED` can only be resolved by an admin (spec 1.1: completion needs recipient confirmation or an explicit admin resolution).

### Listing status while a rescue exists

`food_listings.status` gains `RESERVED` (an active rescue holds it) and `COLLECTED` (food left the provider). Only the rescue service sets them.

| Event | Rescue becomes | Listing becomes | Other candidates |
|---|---|---|---|
| NGO accepts | `RESERVED` | `RESERVED` | disappears from every NGO feed and recommendation; matching refresh refused; their match notifications stop being actionable |
| Provider confirms | `PICKUP_ASSIGNED` | `RESERVED` | unchanged |
| Provider declines / NGO cancels / admin cancels / provider silent past deadline | `CANCELLED` / `EXPIRED` | back to `AVAILABLE` if its pickup deadline is still ahead (else `EXPIRED`) | matching is recomputed, so other NGOs see it again; **the NGO whose rescue ended is not offered it again** (`PREVIOUSLY_DECLINED`) |
| Provider withdraws the food | `CANCELLED` | `CANCELLED` | none |
| Pickup verified | `PICKUP_CONFIRMED` | `COLLECTED` | none |
| Pickup not verified by the deadline | `PICKUP_FAILED` | `EXPIRED` | none |

While `RESERVED`, the listing cannot be edited or cancelled through the listing endpoints (`409 RESCUE_ACTIVE`/`LISTING_LOCKED`); the provider uses the rescue's own actions.

## Deadlines (configuration, see `.env.example`)

| Deadline | Default | Applies to |
|---|---|---|
| `RESCUE_PROVIDER_CONFIRM_MINUTES` | 15 | provider must confirm or decline after acceptance (never later than the listing's pickup deadline) → `EXPIRED` |
| `RESCUE_PICKUP_GRACE_MINUTES` | 30 | after the listing's pickup deadline, an unverified pickup → `PICKUP_FAILED` |
| `RESCUE_PICKUP_EARLY_MINUTES` | 30 | how early before the pickup window opens the NGO may verify pickup |
| `RESCUE_DELIVERY_CONFIRM_HOURS` | 12 | after pickup, the NGO must confirm receipt, else `DELIVERY_FAILED` (admin follow-up) |
| `RESCUE_MAX_CODE_ATTEMPTS` | 5 | wrong pickup codes before the code locks |

**Expiry is correct without the timer.** Every read and every transition locks the rescue and *settles* any overdue expiry first (inclusive deadlines), so an overdue rescue is never actionable even if the in-process worker is late or the API restarted. The worker (`startRescueWorker`, same interval as listing expiry, no Redis) only keeps stored state tidy. It is idempotent and safe to run concurrently (tested).

## Concurrency and idempotency

- **Accepting** locks the listing row (`SELECT … FOR UPDATE`) in one transaction, settles any overdue rescue, re-checks eligibility **live** (`matching.evaluateForAccept`: every Phase 4 hard filter against current data, because stored candidate rows may be stale), then inserts the rescue and flips the listing.
- **Database backstop:** a partial unique index `rescues_one_active_per_listing` (migration `0009`) makes a second active rescue for a listing impossible, even if application locking were bypassed (spec 4.2).
- Two NGOs accepting simultaneously: exactly one `201`, the other `409 LISTING_ALREADY_RESERVED` (tested, including 5-way races with retries).
- **Retries are safe:** the same NGO accepting again gets `200` with the same rescue; repeating confirm/decline/cancel/verify/receipt returns the current state with `changed: false`. Audit events and notifications carry unique/dedupe keys, so retries never duplicate rows.
- **Stale clients:** actions may send `expectedVersion`; a mismatch is `409 STALE_RESCUE`. Invalid transitions are `409 INVALID_RESCUE_TRANSITION` with the current status.

## Authorization and privacy

| Action | Who |
|---|---|
| Accept a listing | Verified NGO member, eligible right now |
| Confirm / decline / issue a new pickup code | Provider members of the listing's organization |
| Cancel before pickup | Provider members (withdraws the food, listing cancelled) or the accepting NGO's members (listing released) |
| Verify pickup, confirm receipt | The accepting NGO's members |
| Admin cancel, admin resolve | Admin only, reason required; audited |
| Read | Parties to the rescue and admins; everyone else gets `404` (no existence leak) |

- **Staged disclosure:** before the provider confirms, the NGO sees only the approximate area and **no** provider contact, and the provider sees **no** NGO contact. After confirmation (`PICKUP_ASSIGNED`, `PICKUP_CONFIRMED`) each party gets the exact pickup address (NGO) and the other party's contact (both). When the hand-off stage ends (completed, cancelled, expired) these are **no longer shown** again to the other party. Admins always see them.
- **Pickup code:** 6 digits, generated server-side, stored only as `SHA-256(rescueId:code)` (bound to the rescue, spec BR-06), compared in constant time, cleared once used. The provider sees it once, at issue; the NGO, events, notifications and logs never contain it. Wrong attempts are counted and audited; at the limit the code locks until the provider issues a new one.
- Notification text never contains addresses, contacts or codes. Socket events carry only a rescue id.

## Audit history and notifications

- `rescue_events` is **append-only** (database trigger rejects UPDATE/DELETE; foreign keys `RESTRICT`). Each row records actor, role (`system` for expiry), from/to status, reason and metadata. A `seq` column (migration `0010`) gives strict insertion order, because rows written in one transaction share a timestamp.
- `rescues` stores outcome fields for later reliability scoring: `outcome_code` (`COMPLETED`, `PROVIDER_REJECTED`, `PROVIDER_WITHDREW`, `NGO_CANCELLED`, `ADMIN_CANCELLED`, `PROVIDER_NO_RESPONSE`, `PICKUP_NOT_VERIFIED`, `DELIVERY_NOT_CONFIRMED`, `ADMIN_RESOLVED`), `outcome_reason`, offered/collected/delivered servings and timestamps. **Reliability is still the neutral default** (Phase 4 passes no history); no score is derived from these yet.
- In-app notifications (`RESCUE_UPDATE`) go to the other party's members on each change, deduplicated by event and user. `GET /notifications` now returns `actionable`: a match notification stops being actionable once the listing is reserved/closed or the NGO is no longer eligible, and a rescue notification once the rescue is finished.
- **Real-time:** Socket.IO now authenticates with the session cookie (revoked or missing sessions are refused), puts each socket in its own user room only, and emits `rescue.updated {rescueId}` after commit. The UI re-fetches over REST on each event and also polls every 30 s, so it stays correct if the socket is blocked. Client and server use the slash-less path `/socket.io` because Next strips trailing slashes when proxying.

## API (under `/api/v1`)

| Method | Path | Notes |
|---|---|---|
| POST | `/listings/:id/accept` | NGO. `201` new, `200` repeat. `409`: `LISTING_ALREADY_RESERVED`, `LISTING_NOT_AVAILABLE`, `NOT_ELIGIBLE` (with `details.reasons`) |
| GET | `/rescues?scope=active\|past\|all&listingId=` | own organization's rescues (admin: all) |
| GET | `/rescues/:id` | role-specific view: allowed actions, next step, deadlines, history |
| POST | `/rescues/:id/confirm` | provider; returns the pickup code once |
| POST | `/rescues/:id/reject` | provider, `{reason}` |
| POST | `/rescues/:id/pickup-code` | provider; new code, resets attempts |
| POST | `/rescues/:id/cancel` | provider or NGO, `{reason}` |
| POST | `/rescues/:id/pickup/verify` | NGO, `{code, collectedServings}` |
| POST | `/rescues/:id/delivery/confirm` | NGO, `{deliveredServings, notes?}` (completes) |
| POST | `/rescues/:id/admin/cancel`, `/admin/resolve` | admin, reason required |

## Migrations (forward-only, additive)

`0008_rescues` (types, `rescues`, `rescue_events`, two new `listing_status` values) · `0009_rescue_integrity` (one-active-rescue index, append-only trigger) · `0010_rescue_events_seq`. Nothing from Phases 1 to 4 was edited or removed.

## Demo (after `npm run db:migrate && npm run db:seed`)

No new accounts. `provider@` and `ngo@` share one seeded **completed** rescue ("Lunch Boxes (demo completed rescue)") so history is not empty.

1. As `ngo@demo.foodloop.test`: **Live food → Recommended for you → Accept this food** (confirm). You land on the rescue page: "Awaiting provider confirmation", approximate area only.
2. As `provider@demo.foodloop.test`: **Rescues**, open it, **Confirm hand-off**. A 6-digit pickup code is shown once.
3. Back as `ngo@`: the rescue shows the exact address and provider contact. **Verify pickup** (try a wrong code first), then **Confirm food received** with a quantity. The rescue completes; the provider is notified.
4. Cancellation: accept another listing and **Cancel rescue…** with a reason. It returns to the market for other NGOs, but not to you.
5. Expiry: accept as one NGO and leave the provider's confirm window (15 min) to pass; the rescue expires and the listing is released (set `RESCUE_PROVIDER_CONFIRM_MINUTES=1` to see it quickly).
6. Access: `ngo3@` or `provider2@` opening that rescue gets "not found".

Accepting consumes the seeded live listing for that demo; re-running the seed re-creates a live listing only after the previous one has expired or been cancelled. To repeat the demo immediately, create a new listing as the provider.

## Known limitations

- **Direct NGO pickup only (superseded):** runner-assisted rescues, maps and tracking were added in Phase 6, see [phase-6-runner-logistics.md](phase-6-runner-logistics.md).
- **No incident reports (superseded):** added in Phase 6.
- **No reliability scoring.** Outcomes are recorded but unused; Phase 4 stays neutral.
- **Single accept, no escalation waves, no partial or split acceptance.**
- A provider must withdraw or decline through the rescue page; admins cancel only via the audited admin route.
- The exact address and contacts are not shown again after the hand-off stage ends (a deliberate privacy minimum; the history keeps the facts).
- **PostGIS privileges are not separated (superseded by Phase 7, see [phase-7-security-operations.md](phase-7-security-operations.md)):** at the end of Phase 5, migrations, seed and the running API still used one `DATABASE_URL` (the `postgres` superuser locally). A least-privilege runtime role plus a separate migration URL is recommended before any deployment.
- The in-process worker assumes a single API process; correctness never depends on it.
