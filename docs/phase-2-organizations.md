# Phase 2 — Organizations and Verification

Builds on [phase-0-decisions.md](phase-0-decisions.md). Status names follow the Phase 1 enum (`UNSUBMITTED`, `RESUBMISSION_REQUESTED`) rather than the `DRAFT` / `RESUBMISSION_REQUIRED` suggested in the brief.

## Verification lifecycle

```
UNSUBMITTED ──submit──▶ UNDER_REVIEW ──approve──────────────▶ VERIFIED            (terminal)
                           ▲   │  └───reject (reason)────────▶ REJECTED            (terminal)
        submit (again)     │   └──request resubmission (reason)──▶ RESUBMISSION_REQUESTED
                           └────────────────────────────────────────────┘
```

- **REJECTED is terminal.** The application cannot be edited, resubmitted or re-decided. The applicant may create a *new* organization (the "one open organization per type" rule ignores rejected ones).
- **VERIFIED is terminal** in this phase (revocation comes with later admin tooling). Contact fields stay editable; name, address and coordinates are locked.
- The applicant can edit the profile and documents only in `UNSUBMITTED` and `RESUBMISSION_REQUESTED`.
- Rules live in one pure module, `apps/api/src/modules/organizations/lifecycle.ts`.

## Submission requirements

Profile: name, contact name, contact email, contact phone, address, city. Documents: at least one `REGISTRATION_CERTIFICATE`. Missing items return `422 SUBMISSION_INCOMPLETE` with `details.missing`. Latitude/longitude are optional but must be given together.

## Authorization

| Action | Who |
|---|---|
| Create organization | Provider (creates `PROVIDER`), NGO (creates `NGO`); never Admin/Runner |
| Read organization, documents, history | Active member (any member role) or Admin |
| Edit profile, upload/delete documents, submit | Active member with role `owner` or `manager` (not `operator`); never Admin |
| Verification queue and decisions | Admin only |

Non-members receive **404** (not 403) for another organization's resources so ids cannot be probed. The applicant-facing history shows action, reason and time but not the reviewing admin's identity.

## Decision integrity

A decision runs in one transaction that locks the organization row (`SELECT … FOR UPDATE`). It must (a) find the organization `UNDER_REVIEW` (otherwise `409 INVALID_STATUS_TRANSITION`) and (b) carry the `submissionNumber` the admin reviewed (otherwise `409 STALE_REVIEW`, e.g. the applicant resubmitted meanwhile). Two admins deciding at once: exactly one succeeds. Reject and request-resubmission require a non-blank reason.

`verification_events` is append-only: a database trigger rejects `UPDATE`/`DELETE`, and its foreign keys are `RESTRICT`, so history cannot be deleted by deleting an organization or user.

## Documents and storage

- Bytes go to private storage, never PostgreSQL. `FileStorage` (`apps/api/src/storage/index.ts`) is the replaceable interface; `LocalDiskStorage` writes to `STORAGE_DIR` (default `<repo>/storage/uploads`, git-ignored, outside any web root). Keys are generated server-side (`org-<uuid>/<uuid>.<ext>`); a resolved path must stay inside the root.
- Accepted: **PDF, PNG, JPEG**, **5 MB** max, 10 documents per organization. The type is detected from the file's leading bytes and must agree with the extension; the client-declared MIME type is ignored.
- Filenames containing `/`, `\`, `..`, control characters, or longer than 120 characters are rejected (`INVALID_FILENAME`).
- Files are served only by `GET /organizations/:id/documents/:docId/file` after the membership/admin check, as an `attachment` with `Cache-Control: private, no-store`. API responses never include storage keys or hashes.

## API (all under `/api/v1`, standard envelope)

| Method | Path | Purpose |
|---|---|---|
| POST | `/organizations` | Create profile (Provider/NGO) |
| GET | `/organizations` | Organizations I belong to |
| GET / PATCH | `/organizations/:id` | Read / update profile |
| POST | `/organizations/:id/submit` | Submit or resubmit for review |
| GET | `/organizations/:id/verification-history` | Decisions and reasons |
| GET / POST | `/organizations/:id/documents` | List / upload (multipart: `documentType`, `file`) |
| DELETE | `/organizations/:id/documents/:docId` | Remove while editable |
| GET | `/organizations/:id/documents/:docId/file` | Authorized download |
| GET | `/admin/verifications?status=` | Queue (default `UNDER_REVIEW`; `ALL` or any status) |
| GET | `/admin/verifications/:id` | Application detail (owner, documents, history) |
| POST | `/admin/verifications/:id/decision` | `{decision: APPROVE\|REJECT\|REQUEST_RESUBMISSION, reason?, submissionNumber}` |

## Reusable verified-organization guard

`apps/api/src/modules/organizations/guards.ts` exports `assertOrganizationVerified`, `assertVerifiedMember` and the `requireVerifiedMember(db, getOrgId)` middleware. They return `403 ORGANIZATION_NOT_VERIFIED` unless the organization is `VERIFIED` (admins are not exempt). Phase 3+ listing, acceptance and matching code must call them (spec BR-02).

## PostGIS limitation

PostGIS is not installed, and nothing in this phase needs it. Latitude/longitude are ordinary `double precision` columns with range checks and a both-or-neither constraint. Spatial matching (Phase 4) will need a later migration that installs PostGIS, adds a `geography(Point,4326)` column backfilled from these coordinates, and a GiST index. No spatial query exists today.

## Demo flow

1. Seed: `npm run db:seed`. Sign in as `ngo2@demo.foodloop.test` (Care Foundation, **draft**) with `DEMO_PASSWORD`.
2. Open **Organization**. Click *Submit application*: it is refused because the registration certificate is missing. Upload a small PDF/PNG/JPEG, then submit. Status becomes **Pending review** and the form locks.
3. Sign out. Sign in as `admin@demo.foodloop.test`, open **Verification queue**. Both Care Foundation and Riverside Bakery (`provider2@`, seeded as pending) are waiting. Open Care Foundation, review details and the document, choose *Request resubmission* with no reason (validation blocks it), then add a reason and record it.
4. Sign back in as the NGO: status shows **Resubmission required** with the admin's feedback. Resubmit. As admin, approve. The NGO page now shows **Verified** (name/address locked) and the full history.
5. Access control: signed in as `provider@demo.foodloop.test`, `/admin/verifications` redirects home and `GET /api/v1/admin/verifications` returns 403. Another organization's id returns 404.

The draft/pending accounts are one-time demo states; to repeat the flow, register a new NGO or Provider at `/register`.
