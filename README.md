# GeneMatch — Phase 1–2 build

Public website plus authentication and dashboard scaffold for GeneMatch, a
genetic relationship analysis platform. This build covers Phases 1–2 of the
full 13-phase roadmap in the original spec:

- **Phase 1 — Public website:** done, all 15 pages.
- **Phase 2 — Authentication & dashboard scaffold:** done (Firebase Auth,
  role storage in Firestore, role-gated dashboard nav).
- **Phase 3 onward** (case management, lab data import, QC, comparison
  engine, statistics, reporting, hardening, integration, validation,
  regulatory review, pilot) are **not built yet**. The dashboard shows the
  roadmap and stubs those sections out on purpose, rather than faking them.

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
  partials/
    header.html
    footer.html
  assets/
    layout.js               Injects header/footer, mobile menu, active-nav
    styles.css               Shared tokens/utilities Tailwind CDN doesn't cover
    firebase-config.js       PLACEHOLDER — fill in real project config
    auth.js                  Firebase auth helpers (login, register, role fetch)
  firestore.rules            Security rules backing the RBAC (Phase 2 scope only)
```

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

## What's next (Phase 3)

Case management: case IDs (`GM-2026-000001` format), case CRUD, sample
registration (`SMP-000001` format), and chain-of-custody tracking. That's
the natural next slice, since `request-test.html` and the dashboard's
"Cases" nav item are both already wired to expect it.
