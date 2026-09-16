# GeneMatch — Phase 1–6 build

Public website, authentication, case/sample management, laboratory data
import, profile normalization, and quality-control review for GeneMatch.
This build covers Phases 1–6 of the full 13-phase roadmap in the original
spec:

- **Phase 1 — Public website:** done, all 15 pages.
- **Phase 2 — Authentication & dashboard scaffold:** done (Firebase Auth,
  role storage in Firestore, role-gated dashboard nav).
- **Phase 3 — Case & sample management:** done. `request-test.html` creates
  a real case (`GM-2026-000001` format); staff can register samples
  (`SMP-000001` format) against a case and log chain-of-custody events;
  customers see a simplified status stepper, staff see the full case/sample/
  custody view.
- **Phase 4 — Laboratory data import:** done. An instrument-adapter layer
  parses lab output, validates it, and writes a normalized profile to
  `genetic_profiles`.
- **Phase 5 — Genetic profile normalization:** done. The marker schema is
  generalized beyond STR loci (STR/SNP/variant-aware, reference-build
  handling), and a viewer page reads either format version into one common
  shape.
- **Phase 6 — Quality control engine:** done. Sample/profile mismatch
  detection runs at import time, a case-level QC summary aggregates status
  across all of a case's profiles, and a FAIL no longer blocks a profile
  forever — a qualified reviewer can clear or reject it, with every
  decision recorded permanently. See "Phase 6 details" below.
- **Phase 7 onward** (the comparison/statistical engine, reporting,
  hardening, integration, validation, regulatory review, pilot) are **not
  built yet**.

## Stack

Single-file HTML pages, Tailwind CDN, vanilla JS, Firebase (Auth +
Firestore), deployed as a static site (Vercel). No build step. This is a
deliberate scope decision to move faster now; a FastAPI/PostgreSQL backend
is the more scalable path for Phase 3+ (case management, lab data ingestion,
the comparison/statistics engine) and can be introduced without touching
this front end — it would just start calling a real API instead of Firestore
directly.

## Project structure

```
genematch/
  index.html               Home
  about.html
  how-it-works.html
  services.html             DNA testing / relationship / parentage / comparison (combined, anchored)
  laboratory-partners.html
  faq.html
  contact.html
  privacy.html
  terms.html
  consent.html
  request-test.html
  login.html
  register.html
  dashboard.html            Authenticated shell, Phase 2
  cases.html                 Case list — Phase 3
  case.html                  Case detail: status, samples, custody, profiles — Phase 3/4
  import.html                 Genetic profile import — Phase 4
  profile.html                 Normalized profile viewer — Phase 5
  partials/
    header.html
    footer.html
  assets/
    layout.js               Injects header/footer, mobile menu, active-nav
    styles.css               Shared tokens/utilities Tailwind CDN doesn't cover
    firebase-config.js       PLACEHOLDER — fill in real project config
    auth.js                  Firebase auth helpers (login, register, role fetch)
    case-data.js             Phase 3: case/sample CRUD, chain of custody, ID generation
    profile-import.js         Phase 4/5/6: adapters, validation, marker model, QC review
  firestore.rules            Security rules backing the RBAC (Phases 2–6)
```

## Phase 6 details

**Sample/profile mismatch detection:** `checkSampleProfileConsistency()`
runs at import time, before a profile is written. It confirms the sample
record actually exists, confirms it belongs to the case the import claims
(a genuine integrity check, not just trusting the URL), and warns — without
blocking — if the sample already has a profile using a different testing
method, since that's sometimes an intentional re-test and sometimes a sign
something's wrong. Its findings are merged into the same PASS/WARNING/FAIL
decision as the marker-level checks from Phase 4/5, not tracked separately.

**Review, not permanent blocking:** spec section 11 says a failed check
should block analysis "until reviewed" — not forever. A `FAIL` profile
stores `analysisStatus: 'blocked'`. On `profile.html`, a reviewer-capable
role (`reviewer`, `scientist_analyst`, `laboratory_admin`, `super_admin`)
sees a form to **clear for analysis** or **reject**, with a required note.
Whoever imported the profile can't review their own FAIL — that's enforced
in `firestore.rules` (`isReviewerRole()`), not just hidden in the UI.

**Decision trail:** every review writes to `qc_reviews` (append-only, like
`custody_events`), logs a `REVIEW` chain-of-custody event on the sample, and
logs a `QC_COMPLETED` audit event. `profile.html` shows the full review
history — decision, reviewer note, timestamp — for any profile that's been
reviewed.

**Surfaced consistently, not just at import:** `case.html` now shows a
case-level QC summary (profiles / ready / blocked / rejected, aggregated
across every sample in the case) above the sample list, and each profile's
row shows both its original import status and its current, possibly
reviewed, analysis status — so "blocked" doesn't silently disappear once
you're looking at anything other than the import result itself.

**What's still simplified:** this is the QC engine, not the comparison
engine. There's still no cross-case quality dashboard (each case shows its
own summary; nothing rolls up across the whole platform), and "unexpected
values" / "low-quality data" from spec section 11 are covered by the
existing allele-format and metrics checks rather than anything
method-specific (e.g. no per-locus expected-range checking for STR kits).
Both are reasonable next steps once there's real lab data to calibrate
against, rather than something worth guessing at now.

## Phase 5 details

**What changed:** the marker schema from Phase 4 was `{ locus, allele1,
allele2 }` — implicitly STR-only, which spec section 10 explicitly warns
against ("do not hard-code the system to one testing technology"). It's now:

```js
{ markerId, markerType: 'STR' | 'SNP' | 'VARIANT', genotype: [allele1, allele2], raw }
```

`markerId` is a locus name for STR, an rsID for SNP, or a coordinate for a
future variant-based adapter. `raw` keeps the original field names for
traceability back to what was actually imported.

**New adapter:** `adaptSnpCsv` (`rsid,allele1,allele2` header) sits alongside
the existing STR adapter, so the import form now offers three format
options. SNP and variant markers require a `referenceBuild` (e.g. `GRCh38`)
— validation fails the import without one, since a SNP genotype only means
something relative to a stated genome build. STR loci don't need one; they're
defined by the testing kit, not genome coordinates.

**Versioning in practice:** `PROFILE_FORMAT_VERSION` is now `2`. Existing
Phase 4 profiles are untouched — they keep their v1 shape in Firestore
forever, since rewriting historical lab data isn't something a client should
do silently. `normalizeForDisplay()` in `profile-import.js` reads a profile
of either version into the same shape, and `profile.html` (new this phase)
uses it to show any profile, regardless of when it was imported, in one
consistent marker table.

**What's simplified for this pass:** `profile.html` is a read-only viewer,
not the comparison engine — it shows what one profile contains, not how two
profiles relate (that's Phase 7). There's still no cross-profile or
cross-case aggregation; each profile is inspected on its own page, reached
from its sample's card on the case detail page.

## Phase 4 details

**Flow:** on a case's detail page, staff click "Import profile" next to a
sample, which opens `import.html?caseId=...&sampleId=...`. They pick a
format, name the laboratory, and upload a file. The pipeline runs entirely
client-side for this MVP:

```
raw file -> adapter (adaptStrCsv / adaptSnpCsv / adaptJson) -> validateProfile() -> genetic_profiles doc
```

**STR CSV format:** a header row with `locus,allele1,allele2` columns, one row
per marker — the standard shape for STR (short tandem repeat) genotyping
output, which is what parentage and relationship testing is actually built
on. **JSON format:** `{ testingMethod, instrument, referenceBuild, markers:
[{locus, allele1, allele2}] }`.

**Validation** checks for what spec section 11 calls out: missing loci,
duplicate loci, and malformed allele values. It rolls up to `PASS` /
`WARNING` / `FAIL`:
- `FAIL` (no markers found, or a row with no locus name) sets
  `analysisStatus: 'blocked'` on the profile — it's stored, visible, and
  flagged, but can't move into analysis until a reviewer resolves it.
- `WARNING` (missing alleles, duplicates, bad formatting on otherwise usable
  data) still sets `analysisStatus: 'ready_for_analysis'`, but the warnings
  stay attached to the profile for whoever reviews it later.

A successful (non-`FAIL`) import also logs a `DATA_UPLOADED` chain-of-custody
event on the sample automatically.

**Versioning:** every profile stores `profileFormatVersion` (currently `1`).
If the internal schema changes later, code reading a profile can branch on
that field instead of guessing.

**What's simplified for this pass — and why it's still called Phase 4, not
Phase 5/6:** the spec splits "laboratory data import" (Phase 4), "genetic
profile normalization" (Phase 5), and "the quality-control engine" (Phase 6)
into separate phases. What's built here is the adapter -> validate ->
normalize pipeline from spec section 9, plus just enough content-level
validation to gate whether a profile can be used at all. It is **not** the
full QC engine from spec section 11 — there's no sample/profile mismatch
detection, no cross-case quality-metrics dashboard, and the validation rules
are intentionally simple (regex-level allele format checking, not
locus-specific expected-range checking). Only STR CSV, SNP CSV, and JSON
adapters exist; TSV, XML, FASTA, VCF, and laboratory-specific adapters are stubbed as a
comment in `profile-import.js` for when there's a real instrument sample
file to build them against.

## Phase 3 details

**Flow:** a signed-out visitor fills out `request-test.html`, gets bounced to
`register.html?redirect=/request-test.html` on submit, and lands back with
their answers restored (via `sessionStorage`) once they've signed up — then
submitting actually calls `createCase()`.

**Data model:**
- `cases/{caseId}` — `GM-{year}-{seq}`, one per test request. Customers can
  create their own (`createdBy` locked to their own uid, `status` locked to
  `submitted` at creation) and read it back; only staff can change status or
  any other field.
- `samples/{sampleId}` — `SMP-{seq}`, linked to a case. Staff-only, per spec
  section 6 ("never expose unnecessary personal information through sample
  labels") — customers see case-level status, not sample-level detail.
- `custody_events/{eventId}` — append-only log per sample (`COLLECTED`,
  `RECEIVED`, `TRANSFERRED`, `STORED`, `LABORATORY_PROCESSING`, `TESTING`,
  `DATA_UPLOADED`, `ANALYSIS`, `REVIEW`, `REPORT_GENERATED`). Registering a
  sample automatically logs its `COLLECTED` event. `firestore.rules` blocks
  `update`/`delete` entirely on this collection — the history can only grow.
- `counters/{id}` — sequence counters for ID generation, incremented inside
  a Firestore transaction so concurrent submissions can't collide.

**What's simplified for this pass:**
- No case-manager/technician *assignment* UI yet — cases show status, but
  "assigned to" fields exist in the data model without a way to set them
  from the UI. That's a natural next addition once there's a staff directory
  to pick from.
- `counters/*` documents are writable by any signed-in user, not locked down
  to a server-side function — flagged in `case-data.js` and `firestore.rules`
  as something to revisit in Phase 9 (security hardening). Low risk here
  since a counter value has no access-control weight of its own.
- Status transitions are a free-form dropdown for staff, not a validated
  state machine (e.g. nothing stops jumping from `submitted` straight to
  `closed`). Worth tightening once the real operational flow is confirmed.

### Why one page combines four spec pages

The spec lists DNA Testing, Relationship Testing, Parentage Testing, and
Genetic Profile Comparison as four separate pages. They're built here as one
`services.html` with anchored sections (`#dna-testing`, etc.) instead, since
they describe the same underlying process from four angles rather than four
distinct products. If you'd rather have four standalone pages (better for
SEO on that specific language, worse for maintenance), splitting them out is
mostly copy-paste from the existing sections.

## Setup

1. **Create a Firebase project** at console.firebase.google.com.
2. Enable **Authentication → Email/Password**.
3. Enable **Firestore** in production mode.
4. Copy your web app config into `assets/firebase-config.js`, replacing every
   `REPLACE_WITH_...` placeholder.
5. Deploy the rules in `firestore.rules`:
   ```
   firebase deploy --only firestore:rules
   ```
6. Deploy the static site to Vercel:
   ```
   vercel deploy
   ```
   (or drag the `genematch/` folder into the Vercel dashboard for a static
   import — no build command needed).

## Test credentials

None are seeded. Register a real account through `/register.html` — it will
be created with role `customer`. To test staff-role views (Case Manager,
Analyst, Reviewer, Laboratory Admin, Super Admin), manually edit that user's
`role` field in the Firestore console after registering, since staff
accounts are intentionally not self-service (see the "Why staff can't
self-register" note in `assets/auth.js`).

## Role model implemented so far

`super_admin`, `laboratory_admin`, `laboratory_technician`, `case_manager`,
`scientist_analyst`, `reviewer`, `customer`, `auditor` — stored on
`users/{uid}.role` in Firestore, enforced in `firestore.rules`, and reflected
in the dashboard's nav via the `ROLE_NAV` map in `dashboard.html`. The nav
hiding is a UX convenience only; `firestore.rules` is the actual boundary.

## Security notes for this phase

- No real genetic, case, or sample data exists yet — those collections are
  intentionally not created until Phase 3+, so there's nothing sensitive to
  protect prematurely.
- `firestore.rules` closes every collection by default (`allow read, write:
  if false`) except `users`, which is scoped to owner-or-staff. Extend this
  file collection by collection as each phase adds one; don't loosen the
  default-closed fallback.
- MFA is stubbed in `login.html` (`#mfa-field`) but not wired to a provider
  yet — decide between Firebase's built-in multi-factor auth, a TOTP
  library, or SMS before Phase 9 (security hardening).
- Contact and request-test forms are UI-only placeholders; they don't submit
  anywhere yet. Wire `request-test.html` to `POST /api/cases` once Phase 3's
  case-management API exists.

## What's next (Phase 7)

The comparison engine: taking two or more `ready_for_analysis` /
`cleared_by_review` profiles and actually comparing them marker by marker —
matching/non-matching markers, missing data, quality warnings surfaced
per-comparison rather than per-profile. Spec section 12 is explicit that
this should not collapse into a single "DNA Match: 98%" style number unless
that has a real statistical meaning for the specific test; the output is
concordant/discordant markers and informative-marker counts, with the actual
likelihood-ratio statistics landing in Phase 8's dedicated statistical
engine right after. Comparison should also be the first place that actually
*enforces* `analysisStatus` — refusing to compare a `blocked` or `rejected`
profile — rather than just displaying it, which is the natural next tightening
after this phase's QC work.
