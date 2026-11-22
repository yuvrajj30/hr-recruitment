# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

HR recruitment / HRMS app (internally "CafeOS"): Next.js 16 (App Router, React 19), Prisma 7 + PostgreSQL via `@prisma/adapter-pg`, Zod, Tailwind 4. `AGENTS.md` warns this Next.js version has breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (e.g. `src/proxy.ts` is the renamed middleware).

## Commands

```bash
npm run dev                 # next dev
npm run dev:testdb          # test site on :3001 against hr_recruitment_test only (refuses any other DB; uploads in storage/test-private)
npm run build               # next build
npm run lint                # eslint
npm test                    # vitest run (all of tests/**)
npx vitest run tests/interviews/rules.test.ts   # single file
npx vitest run -t "name"    # single test by name
npm run test:db             # only tests/db
npx prisma generate         # regenerates src/generated/prisma (gitignored; run after schema changes / fresh clone)
npx prisma migrate dev|deploy   # uses MIGRATION_DATABASE_URL (owner account)
npm run db:verify-roles / db:verify-extra   # sanity checks of DB roles / extra constraints
npm run auth:list-users | auth:set-password | auth:cleanup   # ops scripts
```

Env: copy `.env.example` to `.env`. Tests read **only** `.env.test` (`TEST_OWNER_URL`, `TEST_RUNTIME_URL`), never `.env`; `tests/global-setup.ts` aborts unless both point at a `*_test` database and the runtime account is neither superuser nor BYPASSRLS. Without `.env.test`, DB tests skip themselves.

## Database safety (project rules)

- Two accounts: `hr_app` (owner, migrations/seed only, `MIGRATION_DATABASE_URL`) and `hr_runtime` (restricted, the app's only connection, `DATABASE_URL`). `src/lib/env.ts` requires the runtime account.
- Freely use the test DB; only touch the real `hr_recruitment` database when the user says so. Migration files must stay byte-for-byte as applied (see `.gitattributes`/line endings); never edit an applied migration, add a new one. Never rerun the 2026-11-17 production timestamp correction (`scripts/tz-ops`).
- Timestamps: the Prisma pg adapter drops offsets, so connections use session `TimeZone=UTC` (`createDb` in `src/lib/db.ts`; the app opts in via `DB_SESSION_TIME_ZONE`).
- The user also runs Codex in this repo; check for its changes/logs before acting.

## Architecture

**Tenant isolation is enforced by PostgreSQL row-level security, not just app code.** Every company-owned table has `organization_id`; child tables use composite FKs `(organization_id, parent_id)`. App code never queries with a bare client: it gets a context-bound client from `src/lib/db-context.ts`:
- `staffDb(db, ctx)` – signed-in member. Only the session token is sent (`set_config('app.session_token', …)` per transaction); the *database* resolves user, organisation and role from the session. Nothing user/org-related from the app is trusted.
- `publicApplyDb(db, orgId)` – anonymous careers pages (`/careers`), limited to published public jobs.
The wrapper proxies every Prisma call into a `[set_config, query]` transaction, so use `db.$transaction` for multi-step work. Policies live in migrations (`row_level_security`, `user_management_rls`, `security_hardening`, …); `prisma/extra-constraints.sql` holds checks Prisma can't express (partial unique indexes, append-only tables). Schema changes usually need a hand-edited SQL migration plus a matching test in `tests/db/`.

**Auth** (`src/lib/auth/`): custom sessions (token fingerprint stored in DB, cookie via `cookies.ts`, idle + absolute expiry), login throttling, org switching, audit log. `src/proxy.ts` is only a cookie-presence gate; every page/API/Server Action re-validates via `getCurrentAuth()`/`getAuthContext()`. Authorization asks for permission keys (`job:create`, …), never role names. Exactly three roles (`SUPER_ADMIN`, `HR_MANAGER`, `EMPLOYEE`); `src/lib/auth/roles.ts` is the single source of truth, mirrored by `prisma/seed.ts` and the three-roles migration (a test compares them; same for `permission-keys.ts`). Nav items are gated in `src/lib/navigation.ts`.

**Feature modules** follow one layout: domain logic in `src/lib/<module>/` (`recruitment`, `interviews`, `users`) with pure `rules.ts`/validation separated from DB code, taking injected deps (`AppDeps`, built in `runtime.ts`); UI under `src/app/(app)/<module>/` (authenticated area), components in `src/components/<module>/`. Server Actions start with `signedInAction()` and convert errors with `actionFailure()` (`src/lib/recruitment/action-helpers.ts`) into safe `FormState` messages. API route handlers use `src/lib/http/`. Pipeline: job openings → applications → candidates → interviews/feedback; candidate privacy (consent notice, age confirmation, retention/removal) in `recruitment/privacy*.ts`. Resumes are stored on disk under `storage/`.

Tests (`tests/`): `db/` hits the real test database (including RLS behaviour as `hr_runtime`); `auth/`, `recruitment/`, `interviews/`, `security/` are mostly pure/unit. `server-only` is stubbed and `@/` aliased in `vitest.config.ts`.
