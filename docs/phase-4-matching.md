# Phase 4: Geospatial Matching, Scoring and Ranking

Builds on [phase-3-supply-demand.md](phase-3-supply-demand.md). Matching produces **recommendations only**. It never accepts, reserves or assigns anything. Acceptance is Phase 5, which re-checks eligibility live at accept time instead of trusting stored candidates (see [phase-5-rescue-logistics.md](phase-5-rescue-logistics.md)); runners belong to a later phase. No email, SMS or push is sent.

## PostGIS

PostGIS is **required** from this phase. Installation and verification (native, no Docker) are in [postgis-setup.md](postgis-setup.md); `npm run db:check-postgis` is the gate.

Verified on this machine: PostgreSQL 18.6 (the installer updated 18.4 in place; data untouched) with PostGIS 3.6.2. Migration `0007` runs `CREATE EXTENSION IF NOT EXISTS postgis`. It fails loudly when PostGIS is missing, so a half-working geospatial setup is never created. The dev (`foodloop`) and test (`foodloop_test`) databases are the only ones touched.

## Migrations (forward-only, additive)

| File | What it does |
|---|---|
| `0006_matching_tables.sql` | New `match_candidates` and `notifications` tables; two new `ngo_requirements` columns (`dietary_must_have`, `dietary_must_avoid`, default `{}`) |
| `0007_postgis_geography.sql` | Enables PostGIS; adds `geog geography(Point, 4326)` to `organizations` and `food_listings`; backfills them from the existing `latitude`/`longitude` (only when **both** are present and valid; `ST_MakePoint(longitude, latitude)`, i.e. longitude is X and latitude is Y); adds GiST indexes `organizations_geog_gist` and `food_listings_geog_gist`; adds a trigger that keeps `geog` in step with the plain columns |

No existing column, row or index is changed or dropped. The plain latitude/longitude columns stay the source of truth that the API reads and writes; `geog` is derived, so no code path can leave them inconsistent. The `geog` columns are maintained by SQL and are intentionally not modelled in the Drizzle schema.

## Hard eligibility filters

Evaluated per (listing, NGO). A candidate must pass **all**; every failing reason is recorded.

| Code | Rule |
|---|---|
| (not evaluated) | NGO organization must be `VERIFIED`; other NGOs are never evaluated or shown |
| `NO_REQUIREMENT` / `INTAKE_PAUSED` / `WINDOW_ENDED` | NGO has a requirement, intake enabled, availability window not ended |
| `WINDOW_NO_OVERLAP` | requirement window overlaps the listing's pickup window (`from < deadline` and `to > pickup start`) |
| `CATEGORY_NOT_ACCEPTED` | listing's food category is in the NGO's accepted categories |
| `DIETARY_MISSING_REQUIRED` / `DIETARY_EXCLUDED` | listing has every tag the NGO requires and none it excludes (new requirement fields) |
| `INSUFFICIENT_CAPACITY` | capacity covers the **full** quantity (no splitting) |
| `NGO_NO_COORDINATES` | NGO has valid coordinates (a listing without coordinates is not matchable at all) |
| `OUTSIDE_SERVICE_RADIUS` | within the NGO's own service radius (`ST_DWithin`, inclusive) |
| (not evaluated) | within the platform search radius `MATCH_SEARCH_RADIUS_KM` (`ST_DWithin` in the candidate lookup, which uses the GiST index) |
| `TIME_INFEASIBLE` | estimated travel + dispatch fits before the listing deadline |

Listings must be `AVAILABLE` with a future deadline. Drafts, cancelled and expired listings are never matched; refreshing them returns `409 LISTING_NOT_MATCHABLE`, and reads filter by deadline even if the expiry worker has not run.

`ST_Distance` supplies the reported distance, and `ST_DWithin` does all radius checks. The candidate lookup SQL is in `modules/matching/service.ts`; a test confirms the planner uses `organizations_geog_gist`/`food_listings_geog_gist`.

## Travel-time estimate (not a route)

There is no routing provider. Travel is an **estimate**, labelled as such in the API (`estimate` block, `estimated*` field names) and UI:

```
roadKm      = straightLineKm x MATCH_ROAD_DISTANCE_FACTOR        (default 1.4)
travelMin   = ceil(roadKm / MATCH_AVG_SPEED_KMH x 60)            (default 25 km/h)
earliest    = max(now + travelMin + MATCH_DISPATCH_BUFFER_MINUTES, pickupStart)   (default 20 min)
margin      = deadline - earliest          (must be >= 0)
```

The factor, speed and buffer are conservative urban defaults, not measured values. Real road routing would replace this.

## Score (0 to 100)

`score = sum(weight_i x component_i) / 100`, with the specification weights (configurable via `MATCH_WEIGHT_*`; they must add up to 100):

| Component | Weight | Formula (each 0 to 100) |
|---|---|---|
| Distance | 35 | `100 x (1 - distance / min(NGO radius, platform radius))` |
| Urgency feasibility | 25 | `100 x margin / MATCH_TARGET_MARGIN_MINUTES` (default 60), capped at 100 |
| Quantity fit | 20 | `100 x min(offered, needed) / max(offered, needed)` |
| Active need | 10 | 100 if the requirement window has started, otherwise 60 (every eligible NGO has an explicit requirement) |
| Reliability | 10 | **neutral default 50** (`MATCH_NEUTRAL_RELIABILITY`) |

**Reliability assumption:** there are no rescues yet, hence no completed/failed history. Every NGO therefore gets the documented neutral value. `reliabilityScore()` already supports real history (success rate smoothed toward neutral with 5 pseudo-observations) for when rescue outcomes exist; nothing is invented today.

Ranking is deterministic: **score descending, then distance ascending, then organization id**. Repeated runs on unchanged data give the same order. Scores are rounded to two decimals; the breakdown (score, weight, points per component) and human-readable reasons are stored with each candidate.

## Persistence and recomputation

- `match_candidates` holds one row per (listing, NGO) with a unique index, so recomputation **upserts**. Eligible rows carry score, rank, breakdown and explanation; ineligible rows (NGOs within the search radius, or without coordinates) keep their failure reasons.
- `notifications` is a minimal in-app inbox. Each eligible NGO member gets one `LISTING_MATCH` record per listing, deduplicated by a unique `dedupe_key`, so retries never duplicate. The text contains no address or contact details. `GET /api/v1/notifications` returns the caller's own.
- Recomputed automatically when: a Provider publishes a listing; an available listing is edited; an NGO requirement is created, updated, paused or resumed; an NGO is approved; a verified NGO adds missing coordinates. A failed refresh is logged and never undoes the user's change; the refresh endpoints retry it.
- Each recomputation runs in one transaction under a per-listing advisory lock, so concurrent runs are safe.

## API (under `/api/v1`)

| Method | Path | Who |
|---|---|---|
| GET | `/listings/:id/matches` | Owning provider members, Admin. Ranked candidates, aggregate exclusion reasons (Admin also sees which organizations) |
| POST | `/listings/:id/matches/refresh` | Owning provider members, Admin. `409 LISTING_NOT_MATCHABLE` for non-live or coordinate-less listings |
| GET | `/listings/recommended` | **Verified** NGO. Ranked live listings with score, breakdown, reasons and estimates; `state` is `ACTIVE`, `NO_REQUIREMENT`, `PAUSED`, `WINDOW_ENDED` or `NO_COORDINATES` (empty list otherwise) |
| POST | `/listings/recommended/refresh` | Verified NGO |
| GET | `/notifications` | Any signed-in user, own notifications only |
| GET | `/health` | adds `spatial: up \| unavailable` |

Errors follow the existing envelope. Unverified NGOs get `403 ORGANIZATION_NOT_VERIFIED`; non-members get `404`; `503 SPATIAL_UNAVAILABLE` if PostGIS is somehow missing at request time.

### Privacy

NGOs never receive the provider's exact address, exact coordinates or contact details (the redacted view from Phase 3: city plus coordinates rounded to about 1 km). Providers never receive NGO contact details, addresses or coordinates; they see the organization name, city, score and estimates. Aggregate exclusion messages are generic per reason code so one NGO's private numbers cannot leak.

## Configuration (validated at startup; see `.env.example`)

`MATCH_SEARCH_RADIUS_KM` (10), `MATCH_ROAD_DISTANCE_FACTOR` (1.4), `MATCH_AVG_SPEED_KMH` (25), `MATCH_DISPATCH_BUFFER_MINUTES` (20), `MATCH_TARGET_MARGIN_MINUTES` (60), `MATCH_WEIGHT_DISTANCE|URGENCY|QUANTITY|NEED|RELIABILITY` (35/25/20/10/10, sum must be 100), `MATCH_NEUTRAL_RELIABILITY` (50).

## Related changes

- NGO requirements gained dietary "must have / must avoid" tags (validated; a tag cannot be in both).
- A verified NGO with **no** coordinates may add them once (existing coordinates, name and address stay locked), so the "location missing" state is actionable.
- Seed adds `ngo3@demo.foodloop.test` (Helping Hands Trust, verified, about 6 km away) and recomputes the live demo listing.

## Demo

```bash
npm run db:check-postgis   # PostGIS gate
npm run db:migrate
npm run db:seed            # also computes recommendations
npm run dev
```

1. Sign in as `provider@demo.foodloop.test`, open **Listings**, then the live "Vegetable Biryani (demo)". **Matching NGOs** ranks Hope Community Kitchen (about 1.8 km) above Helping Hands Trust (about 6.3 km), with estimates, reasons and a score breakdown. The unverified Care Foundation is not shown.
2. Sign in as `ngo@demo.foodloop.test`, open **Live food**. **Recommended for you** shows the listing with score, estimated distance/time and urgency. Try **Needs**: pause intake and the recommendation disappears (with an explanation); resume and it returns. Adding "must avoid: vegetarian" removes it.
3. Sign in as `ngo3@`: the same listing appears with a lower score.
4. Create a listing without coordinates: the provider sees "no pickup coordinates, so no matching".

## Limitations

- **No road routing.** Distances are straight-line; travel time and feasibility are estimates from a road factor, speed and buffer. They are not routes or arrival guarantees.
- **Reliability is neutral** until rescue outcomes exist.
- **No acceptance, notifications beyond in-app records, escalation waves or real-time updates** yet (later phases). Single platform search radius, not the spec's 3/6/10 km waves.
- Recomputing after an NGO-side change refreshes every live listing (capped at 500), which is fine at pilot scale.
- Candidates are stored for listings that later expire or are cancelled; they are filtered out at read time.
