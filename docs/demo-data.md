# Demo data guide

How to fill the development app with realistic, repeatable data covering every role, and how to demo it. Everything here is fictional.

## Two seeds, two jobs

| Command | What it does | Safe to re-run? |
|---|---|---|
| `npm run db:seed` | Creates the eight base demo accounts, their organizations, the first listings and two completed rescues. **It re-syncs those accounts' password hash, role and status** (so changing `DEMO_PASSWORD` takes effect) and re-creates the Vegetable Biryani listing when it has expired. | Yes, but it resets those account fields. Use it for a first setup or after changing the demo password. |
| `npm run db:seed:demo-fixtures` | **Adds only what is missing** (found by name) on top of whatever is there. It never updates or deletes an existing user, organization, listing, rescue, requirement or notification. | Yes: a second run adds and changes nothing (checked by hashing every table before and after). |

```bash
npm run db:seed:demo-fixtures -- --dry-run   # target database, counts, and the plan; writes nothing
npm run db:seed:demo-fixtures                # add what is missing
npm run db:seed:demo-fixtures -- --live      # also re-create short-lived stages whose previous copy has run its course
```

Requirements: PostgreSQL migrated, `npm run db:seed` run once (the base accounts must exist), `DEMO_PASSWORD` in `.env`, and **the API running against the same database** (`npm run dev`). The command first checks that the running API sees the same Campus Canteen organization it found in the database and stops otherwise. It prints the database name and role (never the connection string), the record counts and the plan before it writes anything. It never runs with `NODE_ENV=production`.

How it works: account and verification-state fixtures, a third runner and two historic outcomes that only time can produce (an expired rescue and a pickup-failed rescue) are written with the privileged connection, with consistent timestamps and audit events. Everything with a live lifecycle (listings, matching, escalation waves, rescues at each stage, incidents, evidence, notifications) is driven **through the API as the demo accounts**, so every rule, deadline, audit event and notification is the application's own. Pickup codes exist only in memory for the calls that need them; they are never printed or stored in clear.

Re-running after a failure is safe: a listing that an interrupted run published but could not finish is resumed, not duplicated.

## Accounts

All accounts use the password in `DEMO_PASSWORD` (`.env`). Emails end in `@demo.foodloop.test`.

| Role | Email | Who |
|---|---|---|
| Provider | `provider@` | Campus Canteen (verified) |
| Provider | `provider2@` | Riverside Bakery: application **under review** |
| Provider | `demo.greenfield@` | Demo • Greenfield Caterers: **resubmission requested** (with the admin's reason) |
| NGO | `ngo@` | Hope Community Kitchen (verified, 5 km radius, cooked meals and bakery) |
| NGO | `ngo3@` | Helping Hands Trust (verified, 8 km radius, cooked meals and produce) |
| NGO | `ngo2@` | Care Foundation: **draft**, not submitted |
| NGO | `demo.sunrise@` | Demo • Sunrise Relief Society: **rejected** (with the reason) |
| Runner | `runner@` | Aarav: bicycle, 25 kg |
| Runner | `runner2@` | Meera: scooter, 2 kg |
| Runner | `demo.runner3@` | Demo • Kabir: car, 60 kg, carries the in-transit rescue |
| Admin | `admin@` | FoodLoop Operations |

### Tester accounts

`npm run db:seed:test-accounts` adds a separate, clean set: `tester.admin@`, `tester.provider@` (Test • Green Bowl Kitchen), `tester.ngo@` (Test • Open Hands Shelter) and `tester.runner@` (Test • Riya). The organizations are onboarded through the API and approved by `tester.admin`, so their verification history is real. Data: two live listings (*Test • Veg Biryani Trays*, runner needed; *Test • Morning Bakery Basket*, NGO pickup), *Test • Fresh Fruit Bowls* handed over by the runner and waiting for the NGO to confirm, and *Test • Dal Khichdi Pot* completed (30 of 32 servings). See the README for the full test path.

## What each role sees

**Provider (`provider@`)**
- Three live listings with photos and different categories and dietary tags: *Demo • Paneer & Dal Meal Boxes* (cooked, vegetarian, contains dairy), *Demo • Fresh Bread & Buns* (bakery, vegetarian, Jain), *Demo • Seasonal Vegetable Crates* (produce, vegan, gluten free). The listing detail shows matching NGOs with distance and score: Hope 80.8 at 1.1 km and Helping Hands 60.8 at 7.1 km for the cooked listing; only Hope for bakery; only Helping Hands for produce, with the other NGO listed as "Food category not accepted".
- A draft (*Seasonal Fruit Boxes*), a cancelled listing with its reason (*Leftover Soup* and *Demo • Soup Cans*), and expired listings, under Listings, Past.
- Rescues at every stage under Rescues.
- The photos are the app's bundled demo images, uploaded through the normal photo API. The descriptions say so; they are not real provider evidence.

**NGOs**
- `ngo@` and `ngo3@` each have an active requirement, capacity, radius and availability window, recommendations ranked differently, notifications from the escalation waves, and impact (Hope: 3 completed rescues before the walkthrough; Helping Hands: one completed rescue, 18 servings).
- Dietary must-have and must-avoid are empty on both verified NGOs. They are existing records and the fixtures do not edit them; set them live on Profile, Needs and capacity to demonstrate the filters.

**Runner**
- `runner@` (Aarav): one eligible open job, *Demo • Rice & Sambar Trays* (16 kg), and a delivered-and-waiting rescue.
- `runner2@` (Meera, 2 kg): the same job is **not offered** because it is over her capacity.
- `demo.runner3@` (Kabir): an in-transit rescue (*Demo • Pulao & Raita Boxes*) with the map and next step.
- No live location is invented: sharing is explicit and temporary, so start it yourself on an active rescue.

**Admin**
- Operations board with active, delayed, failed, completed and cancelled rescues; the **delayed** one is the rescue with an open blocking incident (*Demo • Veg Sandwich Platters*, reason "blocked by an incident").
- Unaccepted live listings with escalation progress and, after about 75 seconds with the demo timings, full wave history (who was told at each step).
- Incidents: one open and blocking (open it for the resolve form), one resolved with a note and a photo of evidence (*Demo • Evening Meal Share*).
- Verification queue: pending (Riverside Bakery), resubmission requested (Greenfield), rejected (Sunrise), draft (Care Foundation), verified (Campus Canteen, Hope, Helping Hands), each with matching audit history.

### Rescues the fixtures leave in each state

| State | Record | Notes |
|---|---|---|
| `RESERVED` | Demo • Fruit & Salad Cups | Helping Hands accepted; waiting for the provider (15 minutes by design) |
| `AWAITING_RUNNER` | Demo • Rice & Sambar Trays | Hope, runner-assisted; open job for Aarav (30 minutes) |
| `PICKUP_ASSIGNED` + open blocking incident | Demo • Veg Sandwich Platters | Hope, direct pickup; admin must act |
| `PICKUP_CONFIRMED` | Demo • Khichdi Bulk Pot | Helping Hands collected it; waiting for receipt (12 hours) |
| `IN_TRANSIT` | Demo • Pulao & Raita Boxes | Carried by Kabir (about 2 hours) |
| `DELIVERED` | Demo • Idli & Sambar Boxes | Handed over by Aarav; waiting for Hope to confirm the quantity (12 hours) |
| `COMPLETED` | Demo • Evening Meal Share | Helping Hands, 18 of 20 delivered, with a resolved incident and evidence |
| `CANCELLED` | Demo • Soup Cans (NGO cancelled) | NGO reason recorded; provider then cancelled the listing |
| `DELIVERY_FAILED` | Demo • Wrapped Meals (delivery failed) | Admin recorded lost custody |
| `EXPIRED` | Demo • Evening Curry Boxes (provider did not respond) | Historic |
| `PICKUP_FAILED` | Demo • Roti & Sabzi Packs (pickup not verified) | Historic |

`RECIPIENT_CONFIRMED` is a moment, not a place to wait: the system completes the rescue immediately, so it cannot be left in that state. The two older completed rescues (*Lunch Boxes*, *Veg Pulao Trays*) are kept as they were.

The short stages are short on purpose: the application's own deadlines close them (a reserved rescue expires after 15 minutes, a runner search after 30). **Run `npm run db:seed:demo-fixtures -- --live` shortly before a demo**: it re-creates only the stages whose previous copy is no longer active, as new records with the same names. The durable fixtures (verification states, cancelled, failed, completed, resolved incident) are never repeated.

## Walkthrough

1. **Provider** (`provider@`): Post surplus food (use dietary tag Vegetarian), pin the pickup on the map, publish. The listing page shows the matched NGOs with distance and score.
2. **Admin** (`admin@`): Operations, Unaccepted listings. The new listing shows its escalation steps; open Wave history to see who was told as the waves run (about every 15 seconds with the demo timings in `.env`).
3. **NGO** (`ngo@`): the dashboard lists the listing with match reasons; select it, read the detail panel and Accept (choose the runner option).
4. **Provider**: open the rescue, Confirm hand-off, and note the one-time pickup code (shown once).
5. **Runner** (`runner@`): Available jobs, Accept this job, Verify pickup with the code, Hand over to the NGO. Optionally start location sharing and stop it.
6. **NGO**: open the rescue, Confirm food received, enter the quantity.
7. **Admin**: the board shows the rescue as Completed; Impact shows one more completed rescue and the confirmed servings. Provider, NGO and runner impact pages agree.
8. **Incident path**: on any active rescue, Report a problem; then as admin open Incidents and resolve it with a note. For a ready-made example open the open blocking incident and the resolved one under Incidents.
9. **Verification**: as admin open the queue and switch the status filter through pending, resubmission requested, rejected and verified; sign in as `demo.greenfield@` or `demo.sunrise@` to see the applicant's side with the admin's reason.

## What is preserved, and what changed on this development database

The fixtures added only rows; nothing existing was updated or deleted. Before and after (database `foodloop`):

| | Before | After fixtures | After the walkthrough |
|---|---|---|---|
| Completed rescues (platform impact) | 3 | 4 | 5 |
| Servings delivered | 79 | 97 | 125 |
| Users / organizations | 11 / 8 | 14 / 10 | 14 / 10 |
| Listings | 8 | 22 | 23 |
| Rescues | 3 | 14 | 15 |

The existing accounts, the two verified NGOs and their audit history, the original completed rescues (29 + 22 servings), the *Rehearsal Tray* rescue (28) and every earlier notification are untouched. The fixtures add one completed rescue (18 servings). The walkthrough run added a second one (*Demo • Live Walkthrough Tray*, 28 servings), which is ordinary demo progress.

To undo a demo run you have to remove the rows by hand or restore a backup: this guide deliberately has no reset command for the development database. To experiment destructively use the test database (`foodloop_test`, `node --env-file=.env e2e/reset-test-db.mjs` refuses any other name) and point the command at it by setting `MIGRATION_DATABASE_URL` to the test URL and starting the API against the test database for that run.

## Limits

- Dietary must-have/must-avoid filters, and a runner located far outside every radius, are not pre-filled because that would mean editing existing records; set them in the app.
- Live runner positions are never seeded; they are temporary by design.
- Unaccepted live listings, like all listings, expire at their pickup deadline (about 26 to 36 hours after the run); the `--live` flag adds fresh copies.
