# Admin live operations board

Implements the specification's admin requirement (1.1 "Admin can view active, delayed, failed and completed rescues", 9.5 "Live Operations board"). The board is **read-only**: it never changes a rescue or listing. Interventions (cancel, reassign, mark failed, resolve, resolve an incident) stay on the existing audited admin actions, each needing a reason and recorded in the rescue's history.

Page: `/admin/board` (the first item in the admin navigation, and a card on the admin home). On each admin rescue page (`/admin/rescues/:id`) an **Operations** panel shows the same classification, next actor and deadlines above the existing actions and history.

## Classifications

| State | Rescues in it |
|---|---|
| **Completed** | status `COMPLETED` |
| **Failed** | `EXPIRED` (nobody confirmed, or no runner in time), `PICKUP_FAILED`, `DELIVERY_FAILED`. `DELIVERY_FAILED` is also flagged **needs an admin**, because only an admin can resolve it |
| **Cancelled** | `CANCELLED` (shown, but not counted as a failure) |
| **Delayed** | still in progress and meeting the rule below |
| **Active** | in progress and not delayed |

"In progress" is `RESERVED`, `AWAITING_RUNNER`, `PICKUP_ASSIGNED`, `PICKUP_CONFIRMED`, `IN_TRANSIT`, `DELIVERED` (and the transient `RECIPIENT_CONFIRMED`).

### The delayed rule

Rescue deadlines in this system are **hard**: when `providerConfirmBy`, `runnerBy`, `pickupBy` or `deliveryConfirmBy` passes, the existing lifecycle closes the rescue as expired or failed (on every read, and by the worker). So a rescue that is still in progress is never past its stage deadline, and "delayed" cannot mean "past the deadline". It is the **warning state before that**, derived from the existing deadlines plus one configurable threshold:

A rescue is **delayed** when it is in progress and **any** of these holds:

1. **`BLOCKED_BY_INCIDENT`**: it has an open blocking incident (HIGH or CRITICAL severity, or food safety: the existing BR-07 rule). Next actor: **admin**.
2. **`PICKUP_WINDOW_CLOSED`**: pickup is assigned and the listing's pickup deadline has passed (only the grace period to `pickupBy` remains). No threshold: both times already exist. Overdue action: pickup verification (the runner, or the NGO for direct pickup).
3. **`STAGE_BEHIND_SCHEDULE`**: at least `OPS_DELAYED_ELAPSED_PERCENT` (default **75**, allowed 1 to 99, inclusive) of the time allotted to the current stage has elapsed. The allotted time runs from when the stage began to the existing stage deadline:

| Stage (status) | Starts | Deadline | Overdue action shown |
|---|---|---|---|
| `RESERVED` | `reservedAt` | `providerConfirmBy` | Provider confirmation |
| `AWAITING_RUNNER` | latest event entering that status (falls back to `providerConfirmedAt`, then `reservedAt`) | `runnerBy` | Runner acceptance |
| `PICKUP_CONFIRMED` | `pickedUpAt` | `deliveryConfirmBy` | Receipt confirmation |
| `IN_TRANSIT` | `transitStartedAt` (falls back to `pickedUpAt`) | `deliveryConfirmBy` | Delivery handover |
| `DELIVERED` | `handedOverAt` | `deliveryConfirmBy` | Receipt confirmation |

`PICKUP_ASSIGNED` is deliberately **not** measured by percentage: its window can start hours before the pickup window opens, so a percentage would call normal waiting "late" (rule 2 covers it). A stage whose deadline is not after its start is never classed delayed by percentage.

Assumption, documented because the model does not otherwise provide it: 75% is a project default, set with the existing configuration pattern (`OPS_DELAYED_ELAPSED_PERCENT`, validated with the other `RESCUE_*` settings). Example with the default 15-minute provider window: delayed from minute 11.25. For each delayed rescue the board says **why** (the reason text, with the percentage used and the time left before the rescue fails) and **which action is overdue**.

Boundaries (tested): the threshold is inclusive (exactly 75% is delayed, one second earlier is not); the pickup window closes exactly at the listing's pickup deadline; finished rescues are never delayed, however old.

Overdue rescues are settled before every board read (the same idempotent, row-locked settlement every other read of a rescue performs), so a rescue past a hard deadline appears under **Failed**, not under Active.

## API

All routes are under `/api/v1/admin/board`, **admin only** (401 signed out, 403 for provider, NGO and runner), `GET` only (any other method is 404). Standard `{ success, data, meta.requestId }` envelope. Unknown query parameters and malformed values are `400 VALIDATION_ERROR` with a field message.

| Route | Purpose |
|---|---|
| `GET /rescues` | counts and one page of rescues |
| `GET /rescues/:id` | one rescue's operational view plus a brief incident list and the audit-event count (404 for unknown ids) |
| `GET /options` | organizations and runners that appear in rescues, for the filter pickers (at most 300 each; names and ids only) |
| `GET /listings` | live unaccepted listings, or recently closed ones |

### `GET /rescues` parameters

| Parameter | Meaning |
|---|---|
| `state` | `active`, `delayed`, `failed`, `completed`, `cancelled` (none = all) |
| `providerOrgId`, `ngoOrgId`, `runnerUserId` | organization or runner (a runner matches any rescue they were ever assigned to) |
| `transportMode` | `NGO_PICKUP` or `RUNNER` |
| `q` | up to 100 characters: matches listing title, provider or NGO name, or a rescue id fragment (`%` and `_` are literal) |
| `from`, `to` | `YYYY-MM-DD`, UTC, inclusive: when the rescue **started** (`reservedAt`) |
| `olderThanMinutes` | only rescues that started more than this long ago (1 to 525600) |
| `blocked=true`, `needsAdmin=true` | only blocked by an open blocking incident / only delivery failures awaiting an admin |
| `sort` | `attention` (default), `newest`, `oldest` |
| `page`, `pageSize` | default 1 and 25; page size 1 to 100 |

`attention` order: needs-admin, delayed, active (soonest stage deadline first), failed, completed, cancelled (most recently ended first), ties broken by id, so paging is stable.

Response: `generatedAt`; `delayedRule { elapsedPercent }`; `counts { active, delayed, failed, completed, cancelled, total, needsAdmin, blocked }`; `page { number, size, total, pages }`; `rescues[]`. **The counts follow every filter except `state`**, so the tabs always add up for the current filters; `page.total` also applies `state`, `blocked` and `needsAdmin`.

Each rescue: `id`, `state`, `status`, `needsAdmin`, `transportMode`, `listing { id, title }`, `provider`/`ngo { id, name }`, `runner { id, name } | null`, `servings { offered, collected, delivered }`, `stage { status, nextActor, nextAction, deadline { label, at, remainingMs }, startedAt, elapsedMs }`, `delay { reason, text, overdueAction } | null`, `openIncidents`, `blocked`, `startedAt`, `ageMs`, `pickupWindow`, `completedAt`, `closedAt`, `outcomeCode`, `links { rescue, incidents }`.

### `GET /listings` parameters

| Parameter | Meaning |
|---|---|
| `scope` | `live` (default): published, still `AVAILABLE`, pickup deadline not reached, so nobody has accepted it. `closed`: expired or cancelled without ever being rescued (including an `AVAILABLE` listing past its deadline the sweep has not marked yet) |
| `q`, `providerOrgId` | search by listing or provider name; one provider |
| `urgency` | live only: `CRITICAL` (under 30 minutes), `URGENT` (under 60), `PRIORITY` (60 to 120), `NORMAL` |
| `noEligible=true` | live only: listings with no eligible NGO |
| `from`, `to` | closed only: when it closed (default: the last 7 days) |
| `page`, `pageSize` | as above |

Each listing: title, category, servings, provider, transport flag, `urgency`, pickup window, `remainingMs`, `publishedAgoMs`, `matching { evaluated, eligibleNgos, notifiedNgos }` (counts only), `flags` (`NO_ELIGIBLE_NGO`, `NOT_YET_EVALUATED`) and **`actionable`**: `true` for live listings, always `false` for closed ones (which carry no urgency, countdown or flags). Live results are ordered by soonest deadline; the response also carries `counts { total, noEligibleNgo, byUrgency }`. Drafts and accepted (reserved or collected) listings never appear.

## Real time and fallback

The existing authenticated Socket.IO channel is used; nothing new is trusted from the client.

- `rescue.updated { rescueId }`: now also sent to **every admin** after each rescue transition (admins are placed in an admin-only room by their server-side role at connection; a non-admin cannot join it). Parties still receive their own nudges as before.
- `listing.updated { listingId }`: sent to admins when a listing is published, cancelled or released.
- Events carry only an id. The page refetches over REST, which is the source of truth.
- **Fallback:** the board also polls every 15 seconds, and refetches when a socket reconnects, so it converges when sockets are blocked (verified by blocking `/socket.io` in the browser walkthrough). Rapid changes are coalesced by the "latest request wins" rule on the page. Listings that merely lapse (their deadline passes) are noticed by the next poll, not by a nudge.

## Page behaviour

State tiles (All, Delayed, Active, Failed, Completed, Cancelled) with counts act as filters; extra chips appear when something needs an admin or is blocked. Filters: search (debounced), provider, NGO, runner, transport, started from/until, older-than, order, with **Clear filters** (filters are remembered for the browser session). Pagination with a page-size selector. Each rescue card shows stage, next responsible actor, deadline with a countdown, time in the stage, the delayed reason and overdue action, incident badges, and links to the rescue (with its history and admin actions), its audit history and the incident queue. An **Unaccepted listings** tab shows live supply with urgency and matching counts, and a "closed, not actionable" view. Loading, empty (with and without filters), error-with-retry and validation states are explicit. Layout stacks on narrow screens.

## Privacy and security

- Every route requires the Admin role on the server; the page's role guard is only a convenience.
- Responses contain organization and runner **names and ids**, listing titles, quantities and timestamps. They contain no pickup codes or hashes, emails, phone numbers, street addresses, precise coordinates, tokens, storage keys or incident descriptions (asserted in tests).
- No counters are stored: everything is computed from the rescue and listing records on each request, with filtering, counting and paging in SQL. Indexes used: the existing rescue indexes, `rescue_events (rescue_id, created_at)`, `incident_reports (rescue_id, status)`, `food_listings (status, pickup_deadline)`.
- **Impact is separate.** Operational counts (active, delayed, failed, cancelled) never enter rescued-meal totals: `/impact/*` still counts only `COMPLETED` rescues and delivered servings (tested), and the board says so.

## Configuration

`OPS_DELAYED_ELAPSED_PERCENT` (default 75; 1 to 99). The stage deadlines themselves remain governed by the existing `RESCUE_*` settings.

## Demo

1. `npm run db:seed` (development; repeatable). Sign in as `admin@demo.foodloop.test` and open **Operations**: 2 completed, nothing in progress; the **Unaccepted listings** tab shows the live biryani listing with its eligible-NGO count, and the closed view shows the seeded expired/cancelled listings as not actionable (the seed's lapsed ones fall inside the 7-day window).
2. As `ngo@`: accept the live listing; as `provider@`: confirm. The board (without a reload) shows an **Active** rescue.
3. To see **Delayed** quickly: set `RESCUE_PROVIDER_CONFIRM_MINUTES=2`, accept as `ngo@` and leave it for 90 seconds (75% of 2 minutes). The card says "Provider confirmation is behind schedule: 75% of the allowed time has passed ... left before the rescue fails". A few seconds later it moves to **Failed** (expired).
4. Open a rescue from the board: the Operations panel, incidents and History are on its page. Report a HIGH incident as `ngo@`: the board shows "Blocking incident" and the rescue becomes **Delayed** (next actor: admin).
5. Sign in as `provider@` and open `/admin/board`: you are sent home; the API answers 403.

A repeatable browser version of this is in `e2e/` (see `e2e/README.md`).

## Limitations

- The board does not itself intervene or reassign; it links to the existing admin actions. There is no export.
- "Delayed" before a hard deadline needs the configured percentage (75% is a project default, not from the specification); PICKUP_ASSIGNED has no percentage rule by design.
- Counts and pages are computed live (no cache). Tested with about 6,000 rescues and 250 in progress, each request under 2.5 seconds on the development machine; very large histories would want a date window or a cache.
- Updates for listings that only lapse arrive by the 15-second poll, and the single-node assumption of Phase 7 (in-process sockets) still applies.
- Admin rescue pages show the Operations panel; there is no separate admin listing page, so unaccepted listings are shown on the board only.
- Escalation waves, account recovery and the other audit findings are not part of this change.

## Operations map (coarse positions)

The board's **Map** tab draws open rescues and live unaccepted listings. For that, `GET /admin/board/rescues` and `/admin/board/listings` return an `area` (`city`, `latitude`, `longitude`) and, for rescues, an `ngoArea` (`latitude`, `longitude`). These are **rounded to 2 decimals (about 1 km)** in SQL; the exact address, exact pin, contacts and the runner's live position are never in these responses (the tests assert that nothing more precise than 2 decimals appears). Each popup and list row links to the rescue's own page, where the existing rules decide what an admin may see.
