# Maps, profiles and dashboards

## Maps

One component draws every map: [MapView](../apps/web/src/components/MapView.tsx) (Leaflet + OpenStreetMap tiles, no new dependency). It offers zoom buttons, "Fit all markers", a legend, popups (built from text nodes, never HTML), optional service-radius circles, and a visible message when tiles cannot load or the browser is offline. Every map has the same information as text or typed fields beside it, so a map failure never blocks a workflow. All distances are **straight-line estimates**; FoodLoop has no road-routing service and the UI never implies one.

| Where | What the map does | Privacy rule it follows |
|---|---|---|
| Provider listing form (`LocationPicker`) | click the map or drag the pin; type latitude/longitude; nudge buttons (keyboard friendly); "Use my current location" (the browser asks only when pressed; denial leaves manual entry) | the exact pin is visible to the provider and admins only; NGOs see an area rounded to about 1 km until a rescue is confirmed |
| Provider listing, matches | the pickup pin plus one ring per matched NGO at its straight-line distance | NGO positions are not given to the provider, so rings (not pins) are drawn |
| NGO organization page | pick or correct the organization position; the dashed circle is the service radius | other users see an approximate area; the exact point is only for people in a rescue the NGO accepted |
| NGO needs page | the radius field redraws the circle live | same |
| NGO live feed | approximate listing pins (urgent ones darker), the NGO's own pin and radius; popups with distance estimate, urgency and match reasons; "Show on map" and "Jump to this listing" link list and map | listing pins are the server's rounded area; no address or contact |
| Rescue page | pickup and destination (exact only when the server authorizes it for that role and stage), runner position when shared | decided by the server per stage |
| Runner sharing | explicit start, a persistent "Sharing is ON" banner with Stop, manual position fallback; stopping calls `DELETE /rescues/:id/location` and the point is also deleted when the stage ends or the page is left | about 100 m precision, latest point only, no trail |
| Admin board, **Map** tab | open rescues, destinations and unaccepted listings, filters, links to rescue pages | coarse (2 decimals) positions only, see the board doc |

Runner job cards stay text-only on purpose: the jobs API returns cities and distance estimates, not coordinates, so there is nothing safe to draw before a job is accepted.

## Profiles

`/profile` (every role, also reachable from the account menu and the nav):

- **Account**: name and phone, saved with `PATCH /auth/me`. Email, role and status are read-only and the endpoint rejects them (strict schema). Initials are shown instead of a photo; there is no photo upload.
- **Provider / NGO**: organization card with verification status badge and the member role (owner, manager or operator) with what it allows, linking to `/organization` (details, map location, documents) and, for NGOs, the needs and service radius page. The API enforces owner/manager for edits; the UI mirrors it.
- **Runner**: the full transport profile (availability, vehicle, capacity, radius, base area with map and radius circle) and a plain statement of the sharing rules. There is deliberately no stored "always share" preference: every rescue asks again.
- **Admin**: role and permissions, with a note that there is no self-service role change.

## API changes in this pass

| Change | Why | Tests |
|---|---|---|
| `PATCH /auth/me` (name, phone) | there was no way to edit the account | `tests/account.test.ts` |
| `DELETE /rescues/:id/location` (assigned runner) | a runner can stop sharing and have the stored point removed at once | `tests/locations.test.ts` |
| `PATCH /organizations/:id` may now change `latitude`/`longitude` of a **verified** organization (owner or manager; still a complete pair; name, street address and city stay locked) | a verified NGO could never correct its map position; matching is re-evaluated from the new point; verification status and audit history are untouched | `tests/matching.test.ts` |
| `area` / `ngoArea` (2-decimal) on the admin board responses | the operations map | `tests/board.test.ts` |

No migration was needed.

## Dashboards (workspaces)

Each role's home is a workspace, not a grid of links (`NgoWorkspace`, `ProviderWorkspace`, `RunnerWorkspace`, `AdminWorkspace`, with shared pieces in `ops.tsx`). The old "Signed in as" panel and the server access probe line are gone from every screen.

- **NGO**: welcome band with organization name, verification status, intake state and real Pause/Resume intake; four API-backed figures (active rescues, servings received, available capacity = receiving capacity minus servings in active rescues, urgent nearby); a live-food list with photos beside an interactive map. Selecting a list item (or a map pin) highlights the pin, selects the row and opens a detail panel (photo, food, servings, deadline, approximate distance, urgency, match reasons, Accept). Search and "Urgent only" filter the list. On a phone the list and the map/detail are two tabs; choosing a listing opens the detail.
- **Provider**: "Post surplus food" is the primary action; listings with filters and search, a map of pickup points, rescues needing the provider first.
- **Runner**: availability toggle (saved through the runner profile API), the assigned rescue with its next step and map first, then open jobs.
- **Admin**: counts, delayed/blocked rescues, open incidents and verification items beside the live operations map.

`/profile` has tabs (Account, Organization, Needs and capacity for NGOs, Transport and availability for runners). The sign-in email is masked until the person presses Show. The password cannot be changed in the app yet, and the page says so.


The role home pages ([Today](../apps/web/src/components/Today.tsx)) show tasks and live data from the API: provider (rescues waiting for you, live listings), NGO (best matches, active rescues with "your next step"), runner (active rescue, open job count), admin (delayed/blocked/needs-admin counts, unaccepted food, verification queue), plus recent notifications. Impact numbers come from the impact endpoints and only animate when a value changes.

## Photos

Listings with no uploaded photo show a bundled stock photo chosen from words in the title and then the category (`stockPhoto` in `lib/supply.ts`), always labelled "Illustrative photo". A provider-uploaded photo replaces it and is never labelled that way. The seed adds no photos. See [design-system.md](design-system.md) for sources and licences.

## One page system for every screen

- **Shell**: a single-row espresso header (logo, role navigation as pills, notification bell with unread count, account menu, sign out); on a phone the navigation moves into the Menu panel. Navigation per role: Dashboard plus the role's work areas (provider: Listings, Rescues, Impact; NGO: Live food, Rescues, Impact; runner: Available jobs, My rescues, Impact; admin: Operations, Rescues, Incidents, Verification queue, Impact). Organization, needs and transport settings live in Profile; the old `/organization`, `/ngo/requirements` and `/runner/profile` addresses redirect to the matching profile tab.
- **PageHeader** (in `Shell.tsx`): back link, eyebrow, serif title, one-line explanation, primary actions and tabs/filters, then a divider. Every inner page uses it; content width is the same everywhere (`PAGE_W`).
- **Two-column work pages**: rescue detail (summary with photo, progress and next step; then actions, food and history beside map, transport and contacts), listing detail (form beside photo, matches map and history), verification review and incident review (evidence beside a sticky decision panel).
- **Shared explorers**: `FoodExplorer` (NGO dashboard and Live food), `ListingExplorer` (provider dashboard and Listings). Lists, filters, maps and empty states look and behave the same wherever they appear.
