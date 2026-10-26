# Impact metrics

Implements the specification's impact requirement (1.1 "Impact metrics are derived from completed rescues rather than manually entered totals", BR-08, FL-014, `GET /api/v1/impact/me`). This is the only change in this task; the admin operations board, escalation waves and password recovery are separate work.

## What the data supports

Checked in the schema and services, not assumed:

| Field (table `rescues`) | Set by | Used for |
|---|---|---|
| `status = 'COMPLETED'` | NGO confirms receipt, or an admin resolution (`/admin/resolve`, or an incident resolved with `COMPLETE_WITH_QUANTITY`) | the only thing that makes a rescue count |
| `delivered_servings` | the NGO's confirmed quantity, or the admin's recorded quantity; database check: `delivered <= collected <= offered` | **servings delivered** |
| `completed_at` | every completion path | which period a rescue belongs to |
| `provider_org_id`, `ngo_org_id` | at acceptance | provider / NGO attribution |
| `transport_mode` + `rescue_assignments.status = 'COMPLETED'` | runner handover or completion; a released, replaced or failed assignment ends as `RELEASED` or `REVOKED` | runner attribution |

**Kilograms are not reported.** Weight exists only as `food_listings.estimated_kg`: optional, declared by the provider, for the whole offered quantity of a listing. No per-rescue weight is recorded and no servings-to-kilograms conversion is defined, so scaling it to the delivered quantity would be an invention. The API says so in `unavailable`, and the pages show "Kilograms: not available" with the reason.

## Metric definitions

- **Completed rescues**: rescues in status `COMPLETED`. Cancelled, expired, pickup-failed, delivery-failed and in-progress rescues are never counted (the platform's operational analytics for those belong to the admin board, not here).
- **Servings delivered**: the sum of `delivered_servings` of those rescues: what was confirmed as received. Not the offered quantity, not the collected quantity. A completion with 0 servings (possible only through an admin resolution) is a completed rescue with 0 servings.
- **Period**: a rescue belongs to the period of its `completed_at`, in UTC. `from` and `to` are whole UTC days and both inclusive. No dates means all time.
- **Provider**: completed rescues whose provider organization is one of the user's active organizations. **NGO**: the same for the receiving organization.
- **Runner**: completed rescues with `transport_mode = RUNNER` whose assignment **to that runner** ended `COMPLETED`. Never credited: direct NGO pickups, a runner who released the job, was replaced, or whose delivery failed (even if an admin later completed the rescue), and rescues that were never completed. Credit is via `EXISTS`, so replacing runners can never produce two credits for one rescue.
- **Platform**: all completed rescues; distinct provider organizations, NGO organizations and credited runners are counts only.

### Exactly once

There are **no stored counters**. Every request recomputes from the rescue rows, so a rescue contributes once because it is one row with one status; nothing is incremented, nothing can be replayed, and no join multiplies rows (runner credit uses `EXISTS`). Replaying the completing request is idempotent and changes nothing (tested). Corollary: totals follow the authoritative records, including admin corrections.

## API

Base `/api/v1`, standard `{ success, data, meta.requestId }` envelope. Optional `from=YYYY-MM-DD&to=YYYY-MM-DD` (UTC, inclusive; either may be omitted; a malformed, impossible (`2026-02-30`) or inverted range is `400 VALIDATION_ERROR` with a field message).

| Route | Who | Returns |
|---|---|---|
| `GET /impact/me` | provider, NGO, runner | the caller's own impact. Providers/NGOs: their active organization(s) (optionally `organizationId=` of one of their own; any other id, including another organization's, is `404 NOT_FOUND`). Runners: their own credited deliveries (`organizationId` is `400`) |
| `GET /impact/platform` | admin | platform-wide totals |

`/me` is `403` for admins, `/platform` is `403` for everyone but admins, and both are `401` signed out. A removed member no longer sees the organization.

Response `data`: `period` (`from`, `to`, `timeZone: "UTC"`, `basis`), `scope`, `metrics`, `byMonth` (`[{ month: "2026-04", rescues, servings }]`, UTC months, only months with rescues), `definitions` (the texts above, so the UI shows the server's wording), `unavailable` (kilograms, with the reason).

`metrics`: `completedRescues`, `servingsDelivered` for every scope; providers/NGOs/admin also `byTransport` (`directPickup` and `runnerAssisted`, each `{ rescues, servings }`); providers `recipientOrganizations` and NGOs `providerOrganizations` (counts); admin `providerOrganizations`, `ngoOrganizations`, `runners`.

### Privacy

Aggregates only. A provider sees how many recipient organizations, not which; the platform summary identifies no organization, person or rescue; no addresses, contacts, coordinates, pickup codes or incident text appear (asserted in tests).

## Pages

`/provider/impact`, `/ngo/impact`, `/runner/impact`, `/admin/impact` (a link in the main navigation and a card on each role's home). Each shows the period selector (all time, this month, last 30 / 90 days, custom dates), the period actually applied in words, completed rescues and servings delivered, the transport split, a per-month table, and the metric definitions. States: loading, error with a retry button, field errors on invalid dates, and an empty state per role. Keyboard and screen-reader friendly (labelled date inputs, `aria-pressed` presets, real tables with captions); layouts stack on small screens. The numbers refresh on the existing real-time nudge and every minute.

There is **no public impact page**: the specification marks it optional and ranks organization and admin impact higher.

## Database

Migration `0014_impact_completed_index.sql`: a partial index `rescues_completed_at_idx (completed_at) WHERE status = 'COMPLETED'` for date-filtered totals. Additive; no data touched. The runtime role needs no new grant (read-only queries).

## Demo

`npm run db:seed` (development only; repeatable) now also creates **one completed runner-assisted rescue**, "Veg Pulao Trays (demo runner rescue)": provider@ to ngo@, carried by runner@, 24 offered, 24 collected, **22 delivered**. Together with the existing direct rescue (30 offered, **29 delivered**):

1. `provider@` and `ngo@`: **Impact**: 2 completed rescues, 51 servings; one direct (29), one runner-assisted (22).
2. `runner@`: **Impact**: 1 completed rescue, 22 servings (the direct rescue is not credited to a runner). `runner2@`: 0.
3. `admin@`: **Impact**: platform totals (2 rescues, 51 servings, 1 runner).
4. Accept and complete another rescue (Phase 5/6 demos) and reload: the totals rise by exactly that rescue's confirmed quantity, once. Cancel or fail one and nothing changes.
5. Try **Custom dates** with an end before the start: the page shows the validation message.

## Limitations

- Totals count what recipients confirmed; there is no independent verification beyond the existing proof steps.
- No kilogram or meals-equivalent figure (see above); no CO2 or money figures.
- Months are UTC; a rescue completed late in the evening in India may fall in the next UTC day for date filters.
- Trends are a monthly table, not a chart; there is no export.
- Runner credit goes to the runner whose assignment ended `COMPLETED`. If an administrator resolves a rescue that was still in transit, the active runner is credited; if it had already failed (assignment revoked), no one is.
- Operational analytics of cancelled, expired and failed rescues (BR-08's second half) are not part of this task.
