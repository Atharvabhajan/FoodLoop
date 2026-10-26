# Escalation waves

Implements specification Workflow C (3.3), the escalation strategy (8.4), acceptance scenario FL-018 and Appendix B ("escalation timing: configuration values; use short intervals in demo mode, realistic intervals in pilot mode"). When no NGO accepts a listing, **who is told widens in controlled steps**, ending with an alert to the admins.

## What changed

Before: publishing a listing computed the candidate NGOs **and notified every eligible NGO at once**, and any NGO profile change re-notified. Now publishing creates a persisted schedule of steps. `recomputeListing` still computes, ranks and stores the candidates (the "Live food" feed and `/matches` views are unchanged), but notification is the escalation service's job, wave by wave. `ESCALATION_ENABLED=false` restores the old behaviour (everyone eligible is told at publish, no schedule).

What waves do **not** do: they decide who is *notified*, not who may accept. Every NGO that is currently eligible can still see the listing in "Live food" and accept it, as before (the accept path re-checks eligibility live and is unchanged). Radius-based hiding of the feed is deliberately not part of this change.

## The schedule

Each published listing gets five steps (spec Workflow C and 8.4 combined). Times are minutes after publication; the defaults are the specification's own example, which it calls a "proposed demo policy" and says must be configuration.

| # | Step | Default time | Default radius | Who is told |
|---|---|---|---|---|
| 1 | NGO wave 1 | T+3 | 3 km | the best-scoring eligible NGOs inside the radius |
| 2 | NGO wave 2 | T+15 | 6 km | **additional** eligible NGOs inside 6 km |
| 3 | Runner network | T+25 | 6 km | eligible, available runners (transport-requiring listings only) |
| 4 | NGO wave 3 | T+35 | 10 km | additional eligible NGOs inside 10 km |
| 5 | Admin alert | T+45 | none | every active admin, once |

Pilot and demo values (the actual defaults are the pilot column; the demo column is the commented profile in `.env.example`):

| Setting | Pilot (default) | Demo |
|---|---|---|
| `ESCALATION_WAVE1_MINUTES` / `_RADIUS_KM` | 3 / 3 | 0.1 (6 s) / 3 |
| `ESCALATION_WAVE2_MINUTES` / `_RADIUS_KM` | 15 / 6 | 0.2 (12 s) / 6 |
| `ESCALATION_RUNNER_MINUTES` / `_RADIUS_KM` | 25 / 6 | 0.3 (18 s) / 6 |
| `ESCALATION_WAVE3_MINUTES` / `_RADIUS_KM` | 35 / 10 | 0.4 (24 s) / 10 |
| `ESCALATION_ADMIN_MINUTES` | 45 | 0.5 (30 s) |
| `ESCALATION_BATCH_SIZE` | 5 NGO organizations per wave | 5 |
| `ESCALATION_RUNNER_BATCH_SIZE` | 10 runners | 10 |
| `ESCALATION_INTERVAL_SECONDS` | 30 | 3 |

Other settings: `ESCALATION_URGENT_SCALE` (0.5), `ESCALATION_CRITICAL_SCALE` (0), `ESCALATION_DEADLINE_MARGIN_MINUTES` (5), `ESCALATION_ENABLED` (true).

**Assumptions** (the spec leaves these open, so they are documented defaults and configurable):

- Workflow C (T+3, 15, 25, 35, 45) and section 8.4 (3, 6 and 10 km waves; wave 2 "additional NGOs + runner availability"; wave 3 "broader network + admin alert") are combined into the five steps above: NGO waves at 3, 6 and 10 km, a runner wave between wave 2 and wave 3, and the admin alert as its own final step at T+45 (Workflow C's "alert admin"), not at wave 3's moment.
- The runner wave's radius (6 km) and both batch sizes (5 NGO organizations, 10 runners) are not in the spec.
- The urgency compression factors (0.5 and 0) are my reading of "faster escalation" and "immediate operational escalation if still feasible".
- The 5-minute deadline margin, and the 30-second worker interval, are operational choices.

### Urgency and deadlines

Spec 8.4 and Appendix A: "urgent listings can skip slower waves", URGENT (under 60 minutes left) escalates faster, CRITICAL (under 30) is "immediate operational escalation if still feasible". At scheduling time the offsets are multiplied by `ESCALATION_URGENT_SCALE` (default 0.5) or `ESCALATION_CRITICAL_SCALE` (default 0: every step is due at once, so a CRITICAL listing is offered to everyone in range and the admins are alerted immediately). No step is ever scheduled later than `ESCALATION_DEADLINE_MARGIN_MINUTES` before the pickup deadline, and the order is preserved.

### Validation (at startup)

Loaded with the other settings, so a bad value stops the API with a message naming the setting: step times must not decrease (wave 1 ≤ wave 2 ≤ runner ≤ wave 3 ≤ admin), NGO radii must not shrink, batch sizes are integers 1 to 100, scales are 0 to 1, intervals are whole seconds. A wave radius larger than `MATCH_SEARCH_RADIUS_KM` is **capped** at it when the schedule is created (candidates are only looked up inside that radius) and the capped value is what the history records.

## Eligibility rules (re-checked when each step runs)

Nothing is trusted from when the listing was published. Immediately before an NGO wave the candidates are **recomputed from live data** by the same matching engine (verified and not suspended, accepting intake, food category and dietary rules, capacity, availability window, the NGO's own service radius, platform radius, and whether pickup is still feasible before the deadline given the straight-line travel estimate). Then, in one transaction:

- the listing must still be `AVAILABLE` and before its pickup deadline, else the step and all later ones are cancelled and **no one is notified**;
- recipients are the eligible candidates inside this wave's radius that no earlier wave told, ordered by the existing deterministic rank (match score, then distance, then id), limited to `ESCALATION_BATCH_SIZE`;
- an organization must have at least one active member to count as told. Each member gets one `LISTING_MATCH` notification, with the same deduplication key as the original match notification.

The **runner wave** applies the runner rules used for claiming a job: runner available, complete profile with a base position, within the smaller of their own radius and the platform radius, within this wave's radius, carrying capacity covers the load, can reach the pickup in time, not already holding a rescue. Nearest first, at most `ESCALATION_RUNNER_BATCH_SIZE`, each runner once per listing. It only runs for listings that request transport (otherwise it is recorded as skipped: "no transport needed"). Runners get a `LISTING_RUNNER_ALERT` explaining that no NGO has accepted yet and that a job appears in Available jobs if one accepts and asks for a runner.

The **admin alert** notifies every active admin (`ESCALATION_ADMIN`) with counts only (how many NGO organizations and runners were told, minutes left). Deduplicated per admin per round.

A wave with nobody to tell still runs and is recorded ("no eligible NGO in range"), and a later wave tells anyone who has become eligible since (for example an NGO that registered or changed its needs after the listing opened).

## Stopping

- **Accepted, cancelled, expired or collected:** a database trigger cancels the listing's pending steps **in the same transaction** as the status change, so it covers every code path (accept, cancel, the expiry sweep, release-to-expired). Reasons recorded: `LISTING_ACCEPTED`, `LISTING_CANCELLED`, `LISTING_EXPIRED`.
- **Defence in depth:** the executor also re-checks the listing before every step (`LISTING_NOT_AVAILABLE`, `DEADLINE_PASSED`). Tested with the trigger deliberately switched off.
- **Accept concurrency is untouched.** The accept transaction still locks the listing row (`FOR UPDATE`). The executor takes a shared lock on the same row and always takes locks in the same order (listing, then steps), so an accept and a wave cannot deadlock, and of many simultaneous accepts exactly one wins (tested).
- **A failed rescue releases the listing:** a **new round** is scheduled (timed from the release). NGOs already told are not told again, and the NGO whose rescue failed is excluded by the existing rule.

## Worker and idempotency

Reuses the existing in-process worker pattern: `startEscalationWorker` runs every `ESCALATION_INTERVAL_SECONDS`, guarded by a Postgres advisory lock (`WORKER_LOCKS.escalation`), so an overlapping second process skips a pass. The worker also **backfills** a schedule for any open listing that has none (inserted directly, published before waves existed, or whose scheduling failed). Steps already due at publish (for example CRITICAL listings, or wave 1 at minute 0) run immediately in the publish request's follow-up, without waiting for the worker.

Why nothing runs twice or tells anyone twice (each layer tested):

1. one worker pass at a time (advisory lock);
2. one executor per listing at a time (transaction advisory lock `escalation:<listing>`), and the live eligibility recompute happens *before* that transaction so racing runs never hold pool connections while waiting on each other;
3. a step leaves `PENDING` exactly once; a trigger refuses any later change to a finished step, and the schedule, radius and times are immutable;
4. `escalation_recipients` is unique per listing and recipient (partial unique indexes for NGOs and runners) and insert-only (trigger);
5. notifications carry deduplication keys (`listing-match:…`, `escalation-runner:…`, `escalation-admin:<listing>:<round>:<admin>`).

## Persisted history

- `escalation_steps`: per listing and round, the step, kind, radius, due time, status (`PENDING`, `DONE`, `SKIPPED`, `CANCELLED`), when it ran, how many recipients **qualified**, how many were **newly eligible**, how many organizations and users were notified, and a reason code. Counts only.
- `escalation_recipients`: who each wave told (organization or runner, position in the wave, distance). Append-only.
- The runtime database role may only insert steps, update their status and result columns, and insert recipients; it cannot delete or rewrite either (see Phase 7). Migration `0015_escalation_waves.sql`.

## Admin visibility

On **Operations board → Unaccepted listings** every listing shows its escalation: steps done of total, the last step, the next step and when it is due, an "Admin alerted" badge, and why it stopped if it did ("An NGO accepted the listing"). **Wave history** expands to a table (scheduled, ran, qualified, new, told) and, on demand, *who* was told (organization or runner names, position, distance). Closed listings keep their history. API (admin only; see the board doc):

- `GET /api/v1/admin/board/listings` now includes `escalation` on each listing.
- `GET /api/v1/admin/board/listings/:id/escalation`: all rounds, steps and recipients (names and ids; no contact details, addresses or codes).

## Real time

Same mechanism as before: authenticated Socket.IO, ids only. After a wave commits, the users it notified and every admin receive `listing.updated { listingId }`; the pages refetch over REST (notifications badge, the board). Polling (15 s on the board, 60 s for the badge) remains the fallback, and the notification is always available at `GET /notifications` without any socket. No addresses, contacts, pickup codes or locations are in any payload or in any notification text.

## Demo

1. Use the demo profile (`.env.example`) and restart the API; sign in as `admin@demo.foodloop.test` and open **Operations → Unaccepted listings**. (The seeded live listing gets a schedule on the next worker pass.)
2. As `provider@`, publish a listing (transport needed). On the board its escalation shows "first wave not yet due".
3. Watch it: after ~6 s `ngo@` (inside 3 km) is told; ~24 s `ngo3@` (about 6.3 km, so only wave 3 reaches it); ~18 s `runner@` is alerted; ~30 s the admin alert fires and the board shows "Admin alerted". Open **Wave history** for counts and who was told.
4. Publish another listing and, after its first wave, accept it as `ngo@`: its remaining steps show "Stopped: An NGO accepted the listing" and nobody is told later.

A repeatable browser version is `e2e/escalation.walkthrough.mjs` (see `e2e/README.md`).

## Limitations

- Waves control **notification**, not visibility or the right to accept (see above).
- Distances and times are straight-line estimates (Phase 4); there is no routing provider.
- An NGO that becomes eligible after the last NGO wave is not notified (it can still see and accept the listing in Live food).
- Editing a live listing's pickup deadline does not reschedule its steps (they stay clamped to the original margin); a step due after the new deadline is cancelled by the executor.
- Runner alerts are a heads-up: a runner cannot claim anything until an NGO accepts and asks for a runner.
- The admin alert is an in-app notification (no email, per the spec's V1 scope), once per round.
- Steps and notifications are not purged by the retention command.
- Single-node assumptions of Phase 7 still apply: sockets are in-process, though the worker and each step are safe if a second process runs (advisory locks, unique constraints).
