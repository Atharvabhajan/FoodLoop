# Phase 3 — Supply and Demand

Builds on [phase-0-decisions.md](phase-0-decisions.md) and [phase-2-organizations.md](phase-2-organizations.md). This phase adds time-bounded food listings (supply) and NGO requirements (demand). It deliberately has **no matching, ranking, acceptance, rescue record, notifications or WebSockets**.

## Listings

Table `food_listings`. A listing is always created with every core field (no half-empty drafts); future-ness is enforced when publishing.

| Field | Notes |
|---|---|
| `provider_org_id` | Owning Provider organization (set server-side from the caller's organization) |
| `title`, `description` | Title 3–120 chars; description optional |
| `food_category` | `COOKED_MEALS`, `BAKERY`, `PRODUCE`, `PACKAGED_FOOD`, `DAIRY`, `BEVERAGES`, `OTHER` |
| `servings`, `estimated_kg` | Servings: positive integer. Weight: optional, positive |
| `prepared_at`, `pickup_start`, `pickup_deadline` | `timestamptz`. `pickup_start < pickup_deadline`; `prepared_at` ≤ deadline and not in the future (5 min clock grace) |
| `address_line`, `city`, `latitude`, `longitude` | **Exact address is private.** Coordinates optional, both-or-neither, plain `double precision` |
| `packaging` | `INDIVIDUAL_BOXES`, `BULK_CONTAINERS`, `WRAPPED`, `LOOSE`, `OTHER` |
| `dietary_tags`, `allergen_notes` | Tags from a fixed list (vegetarian, vegan, halal, jain, gluten free, contains nuts/dairy/egg) |
| `transport_required` | Required yes/no |
| `image_key`, `image_mime` | Optional photo; server-side only |
| `status` | `DRAFT`, `AVAILABLE`, `CANCELLED`, `EXPIRED` |
| `declaration_accepted_at`, `published_at`, `cancelled_at`, `cancellation_reason`, `expired_at` | Set by the lifecycle |

Database `CHECK`s back the main rules (positive servings/weight, window order, coordinate pair/range, cancelled ⇒ reason). History lives in the append-only `listing_events` table (`PUBLISHED`, `CANCELLED`, `EXPIRED`; actor is null for automatic expiry; a trigger blocks UPDATE/DELETE).

### Lifecycle and rules

> Phase 5 adds two statuses, `RESERVED` and `COLLECTED`, set only by the rescue workflow: see [phase-5-rescue-logistics.md](phase-5-rescue-logistics.md).

```
DRAFT ──publish──▶ AVAILABLE ──deadline passes──▶ EXPIRED    (terminal)
  └──────cancel (reason)───────┴────────────────▶ CANCELLED  (terminal)
```

Pure rules: `apps/api/src/modules/listings/lifecycle.ts`.

- **Publish** (explicit action): the Provider organization must be `VERIFIED` (reuses the Phase 2 guard → `403 ORGANIZATION_NOT_VERIFIED`); the body must contain `declarationAccepted: true` (the food-safety declaration is stored as a timestamp; FoodLoop makes no safety guarantee); the pickup deadline must be **at least 15 minutes away** (`MIN_PICKUP_NOTICE_MINUTES`). Drafting is allowed for unverified organizations.
- **Edit**: allowed in `DRAFT` and `AVAILABLE`, re-validating the merged result; an available listing's deadline cannot be moved into the past. `CANCELLED`/`EXPIRED` return `409 LISTING_LOCKED` / `LISTING_EXPIRED`. `isListingEditable` is the single place a later phase will add "not reserved by a rescue"; no rescue concept exists yet.
- **Cancel**: `DRAFT` or `AVAILABLE`, with a required reason (3–500 chars); kept in history.
- **Expiry** is *automatic and idempotent* and never required for correctness:
  - Every read computes an **effective status**: an `AVAILABLE` listing whose deadline has passed is reported `EXPIRED`, and the feed, active/past lists and detail views all filter by deadline.
  - `expireListings(db, now)` does a conditional `UPDATE … WHERE status='AVAILABLE' AND pickup_deadline <= now` plus the history rows in one transaction, so repeated or overlapping runs expire each listing exactly once.
  - `startExpiryWorker` runs it at startup and then every `EXPIRY_INTERVAL_SECONDS` (default 60; `0` disables) with an in-process timer. Fine for one local API process; no Redis or queue.
- Urgency buckets (spec appendix A) are derived for display: `NORMAL` > 120 min, `PRIORITY` 60–120, `URGENT` 30–60, `CRITICAL` < 30.

## NGO requirements

Table `ngo_requirements`. **V1 keeps exactly one current requirement per NGO organization** (unique `ngo_org_id`): the simplest model that fits the schema, and enough for the matching inputs in spec §8. Multiple concurrent requirements can be added later by dropping that unique index.

| Field | Rule |
|---|---|
| `food_categories` | 1+ unique categories |
| `needed_servings` | positive integer |
| `capacity_servings` | positive integer, ≥ `needed_servings` |
| `service_radius_km` | > 0 and ≤ 100. **Stored only; no spatial logic uses it** |
| `available_from` / `available_to` | window; end after start and in the future on every write |
| `intake_enabled` | pause/resume without deleting the profile (both idempotent) |
| `updated_by`, timestamps | audit-light bookkeeping |

Derived flags: `active` = intake enabled and window not ended; `acceptingNow` = `active` and window started. Once the window ends the requirement stays stored but inactive until the NGO extends it.

## API (all under `/api/v1`, standard envelope)

| Method | Path | Who |
|---|---|---|
| POST | `/listings` | Provider (creates a draft) |
| GET | `/listings?scope=active\|past\|all` | Provider (own organization) |
| GET | `/listings/declaration` | Any signed-in user (declaration text) |
| GET | `/listings/feed?category=&limit=` | **Verified** NGO member |
| GET | `/listings/:id` | Provider members/admin: full view. Verified NGO: redacted view, live listings only. Others 404 |
| PATCH | `/listings/:id` | Active member of the owning Provider org |
| POST | `/listings/:id/publish` `{declarationAccepted:true}` | Active member, verified org |
| POST | `/listings/:id/cancel` `{reason}` | Active member |
| GET | `/listings/:id/history` | Owning members, admin |
| POST / DELETE | `/listings/:id/image` | Owning members (while editable) |
| GET | `/listings/:id/image` | Owning members, admin, verified NGOs while the listing is live |
| POST | `/ngo-requirements` | Verified NGO member (409 if one exists) |
| GET | `/ngo-requirements/current` | NGO member (null if none; works before verification) |
| PATCH | `/ngo-requirements/current` | Verified NGO member |
| POST | `/ngo-requirements/current/pause` · `/resume` | Verified NGO member |

Authorization notes: any **active member** of a Provider organization (owner, manager or operator) may manage its listings, since operational staff create them; organization *profile* edits remain owner/manager only. Non-members receive 404. Admins can read listings but never modify them. Provider users resolve to their current (non-rejected) Provider organization; NGO users to their current NGO organization.

### What NGOs can and cannot see (pre-acceptance)

The feed and NGO detail view return: provider name, title, description, category, servings, weight, prepared/pickup times, packaging, dietary tags, allergen notes, transport flag, urgency, and an **approximate area** (`city` plus coordinates rounded to two decimals, about 1 km). They never include the exact address, exact coordinates, provider contact details, declaration, cancellation data or storage keys. The exact address is reserved for a later authorized rescue step. Providers are warned not to type the address into the free-text description.

Sorted by soonest deadline; this is **not** a ranking or match. Optional `category` filter only.

## Food images

Optional, **PNG or JPEG**, **3 MB** max, one per listing (replace or delete). Implementation:
- Stored through the Phase 2 `FileStorage` interface in a separate namespace (`listing-<id>/`), never in PostgreSQL; the filename is server-generated and client path-style filenames are rejected.
- The type is detected from the file's bytes and must match the extension.
- **Metadata is stripped** before saving (JPEG APP1/EXIF/XMP and APP13, PNG `eXIf`/`tEXt`/`iTXt`/`zTXt`) so embedded GPS cannot reveal the exact pickup location. Structurally broken images are rejected. Pixel data is not re-encoded.
- Served only by `GET /listings/:id/image`, with the same visibility rule as the listing; `Cache-Control: private, no-store`, `nosniff`.

## PostGIS limitation

PostGIS is not installed and is not used. Listing and organization coordinates and the NGO `service_radius_km` are ordinary columns. **No distance, radius or nearby query exists.** Spatial matching (Phase 4) needs a later migration that enables PostGIS, adds `geography(Point,4326)` columns backfilled from the latitude/longitude pairs, and adds GiST indexes. Until then the feed is just "live listings, soonest deadline first".

## Native PostgreSQL commands

No Docker. With PostgreSQL running on the host and `.env` configured (see README):

```bash
npm run db:migrate    # forward-only; adds food_listings, listing_events, ngo_requirements (migrations 0004-0005)
npm run db:seed       # development only; repeatable
npm test
```

Existing Phase 1/2 rows are not touched by the migrations.

## Seed data and demo flow

`npm run db:seed` adds, to the verified demo accounts:
- `provider@demo.foodloop.test` (Campus Canteen, verified): one **live** listing ("Vegetable Biryani (demo)", pickup deadline about 8 h after seeding), one draft, one expired and one cancelled example.
- `ngo@demo.foodloop.test` (Hope Community Kitchen, verified): an **active requirement** (cooked meals + bakery, 40 needed / 60 capacity, 5 km, 30-day window).

Re-running creates a fresh live listing only after the previous one has expired or been cancelled, and refreshes the NGO window only if it has ended; nothing else is overwritten. The seed refuses to run when `NODE_ENV=production`.

Demo:
1. Sign in as `provider@`. **Listings** shows the live listing with time remaining, and **Past** shows the expired and cancelled examples.
2. **New listing**: try saving the empty form (field errors), then enter servings `0` (rejected), then a valid listing. Add a photo. Click *Publish* without ticking the declaration (blocked), then tick it and publish.
3. Sign in as `ngo@`. **Live food** shows both live listings with an approximate area only (no street address), and the photo. **Needs** shows the active requirement: pause and resume intake; set "servings needed" above capacity to see validation.
4. As `provider@`, cancel the new listing with a reason (required). It disappears from the NGO's Live food and appears under **Past** with the reason.
5. Gating: `ngo2@` (draft org) sees "only verified NGOs can see live listings"; `provider2@` (pending review) can draft but publishing returns "must be verified".
