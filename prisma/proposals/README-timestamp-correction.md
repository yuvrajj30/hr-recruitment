# Timestamp correction and migrations — production runbook (FOR REVIEW, NOT APPROVED TO RUN)

Nothing in this document may be run against the real database (`hr_recruitment`) without the owner's explicit,
written approval for that specific run. Everything here has been rehearsed only on restored copies.

## What is wrong and what this fixes

The PostgreSQL server's time zone is Asia/Calcutta. The Prisma pg adapter sends instants without their offset, so
while the app's sessions used that zone, every application-written timestamp was stored **5 h 30 min early**.
The app looked right (the error cancelled out on read), but raw data, reports, and every database-side comparison
with `now()` (invitation expiry, application deadline, session expiry) were wrong.

The fix has two parts that must go together:

1. **Code (already in this branch):** the app opens UTC sessions when `DB_SESSION_TIME_ZONE=UTC` is set.
2. **Data (this runbook):** move existing app-written timestamps forward by exactly 5 h 30 min, once.

If (1) is switched on without (2), existing times display 5 h 30 min early. If (2) runs and the old app keeps
writing, new rows are wrong again. So the app is stopped between the two.

The seven pending migrations run straight after the correction, in the same window. From the sixth on (security
hardening) the database itself checks session deadlines against its own clock, so they **depend on** both parts above.

## Approved approach (in principle)

| Data | Treatment |
|---|---|
| All app-written timestamps (users, organizations, members, roles, permissions, sessions, login attempts, jobs, applications, notes, candidates, documents) | +5 h 30 min. NULLs stay NULL. |
| `permissions.created_at` for `document:read` | Unchanged (stamped by the database's own clock, already correct). |
| `audit_logs` (Option A) | **Not modified.** One note per row in `audit_log_time_corrections`; `audit_logs_display.display_created_at` shows the corrected time. |
| `application_status_history.created_at`, `application_assignments.created_at` | One-time documented exception: only this column shifted, every other field kept, append-only triggers disabled for the transaction only and re-enabled before commit. |
| Record of the correction | One row in `timestamp_corrections`; one `maintenance.timestamps_corrected` audit record per organization. |

## Files

- `prisma/proposals/timestamp-correction.sql` — the correction. Not a migration; refuses to run in any state other than the expected one.
- `scripts/tz-ops/tz-backup.cjs`, `scripts/tz-ops/storage-backup.cjs` — database and file backups, each with checksums.
- `scripts/tz-ops/tz-restore-verify.cjs` — restores a backup into a new database and proves it is an exact copy.
- `scripts/tz-ops/tz-ops.cjs` — `preflight` (read-only), `apply` (guarded, one transaction, verifies every value, commits only if all checks pass), `post` (read-only).
- `prisma/migrations/` — the seven pending migrations, applied by `npx prisma migrate deploy` in this order:

| # | Migration | What it changes |
|---|---|---|
| 1 | `20261115120000_three_roles` | The three roles and their permissions; former Recruiters/Interviewers become suspended Employees; invitations table. **Changes data** (see "Expected changes" below). |
| 2 | `20261115140000_row_level_security` | Row-level security on recruitment, member and audit tables. No data changes. |
| 3 | `20261115160000_user_management_rls` | Who may change memberships, roles and organisation settings. No data changes. |
| 4 | `20261115180000_invitation_acceptance` | Functions for accepting an invitation. No data changes. |
| 5 | `20261116000000_timestamp_correction_objects` | The correction's tables/view/triggers, idempotently (changes nothing on a corrected database). |
| 6 | `20261116010000_security_hardening` | Session-bound identity, sign-in and passwords inside the database, least privilege. No data changes. Installs `pgcrypto`. |
| 7 | `20261117000000_candidate_privacy` | Privacy-notice settings and 12-month retention per organisation, the age confirmation, no applicant IP address, candidate removal (`app_remove_candidate`); HR Managers get `candidate:delete`. Adds columns and one role permission; changes no existing value. |

Each migration runs inside its own transaction: one that fails leaves **nothing** of itself behind.

## Safeguards built into the tool

- **Nothing else may be connected.** `preflight` fails if any other connection to the database exists, and names it.
  `apply` checks again after it has locked every table. Someone active in the app during the last 15 minutes is
  also a failure; `--allow-recent-sessions` accepts that only after you have stopped the app yourself.
- **Every table is locked** (exclusively) before the "before" values are read, so nothing can change underneath
  the comparison. The tool waits at most 5 seconds for the locks; if they are not free, it stops.
- **All or nothing.** Every stored timestamp is compared before and after inside one transaction. Any surprise →
  `ROLLBACK`.
- **The post-check ignores nothing.** A missing row, a missing timestamp column or a changed value is a failure
  unless it is in the list of expected changes recorded on the same day's rehearsal copy.

## Procedure (real database, only after approval)

Run from `C:\Projects\hr-recruitment` in a **new** terminal (the tools refuse if `MIGRATION_DATABASE_URL` is set in the shell).

1. **Stop the app** (every `next dev` / `next start` using the real database) and close every other tool connected
   to the database (pgAdmin, psql, reports). Nobody signs in during the window.
2. **Fresh backups** (both must verify):
   - Database: `node scripts/tz-ops/tz-backup.cjs` — `pg_dump -Fc` of `hr_recruitment` (read-only) to `~/hr-recruitment-backups/hr_recruitment-before-tz-correction-<timestamp>.dump` with a `.sha256` next to it, then `pg_restore --list` to prove it is readable.
   - Files: `node scripts/tz-ops/storage-backup.cjs` — copies `storage/private` to a new folder with a SHA-256 manifest and verifies copy and originals (originals only read).
3. **Prove the backup restores:** `node scripts/tz-ops/tz-restore-verify.cjs` → must end with `RESTORE VERIFIED`.
   See "Restore verification" below. It leaves a verified copy named `hr_recruitment_restore_verify_<timestamp>`.
4. **Same-day rehearsal on that verified copy** (it is today's data, so it shows exactly what will happen):
   1. `node scripts/tz-ops/tz-ops.cjs apply --database <copy> --confirm "CORRECT TIMESTAMPS IN <copy>"`
   2. `node scripts/tz-ops/tz-ops.cjs post --database <copy> --report <copy's report>` (strict: must pass)
   3. Apply the seven migrations to the copy (the same command as step 9, pointed at the copy).
   4. `node scripts/tz-ops/tz-ops.cjs post --database <copy> --report <copy's report> --write-expected <expected file>`
      — records the changes the migrations make to the corrected values. **Read that list**: it must be what
      "Expected changes" below describes, nothing else.
   If any of these fails, stop: nothing has touched the real database.
5. **Preflight** (read-only): `node scripts/tz-ops/tz-ops.cjs preflight` → must end with `ALL CHECKS PASSED`.
   It checks: UTC session; last migration is `20261115090000_m3_applications_pipeline`; later migrations not
   applied; correction not applied before; the one exception exists; append-only triggers enabled; **nothing else
   connected**; nobody active in the last 15 minutes; a verified backup from the last 6 hours; and, for the
   migrations: the owner account owns the database, `pgcrypto` is available, the server does not log query
   parameters, and which members the role migration will suspend.
6. **Apply the correction:** `node scripts/tz-ops/tz-ops.cjs apply --database hr_recruitment --confirm "CORRECT TIMESTAMPS IN hr_recruitment"`.
   Locks every table, re-checks that nothing else is connected, snapshots every timestamp, runs the SQL, and checks
   that every value moved by exactly +5 h 30 min except the listed exceptions, that audit rows are unchanged with
   one note each, that only the expected audit records were added, that the sets of tables and timestamp columns
   are unchanged, that all five append-only triggers are enabled and that the display view is `security_invoker`.
   Any failure → `ROLLBACK`, nothing changes. A before/after report (JSON) is saved in `~/hr-recruitment-backups`.
7. **Post-check, strict** (read-only): `node scripts/tz-ops/tz-ops.cjs post --report <report from step 6>` → must pass.
   Nothing may be missing or changed at this point.
8. **Switch the app to UTC sessions:** add `DB_SESSION_TIME_ZONE=UTC` to `.env`. (Must happen before the app writes anything again.)
9. **Apply the pending migrations** (three roles, row-level security, user management, invitation acceptance, correction objects, security hardening, candidate privacy — seven in all): `npx prisma migrate deploy`. This is the separate, also-unapproved migration step; the correction is designed to run immediately before it.
   If it stops, see "Rollback": do not start the app.
10. **Post-check against the expected changes** (read-only): `node scripts/tz-ops/tz-ops.cjs post --report <report from step 6> --expected <expected file from step 4>` → must pass. **The app is not started until it does.**
11. **Start the app**, sign in, check a few known times (job created / application received / member since) against what users remember.
12. Later re-checks, once people are using the app: add `--allow-later-activity` to the command of step 10. Values written after the correction are then accepted; a missing row or a value that moved backwards still fails.

### Expected changes (what the role migration does to the corrected data)

Recorded on a rehearsal copy of the 15 Nov 2026 backup (13 values); the same-day rehearsal of step 4 must show the
same kinds of change:

- `roles`: the rows of the old roles `RECRUITER` and `INTERVIEWER` are gone (2).
- `permissions`: the 8 removed permissions are gone (`application:read_assigned`, `candidate:read_assigned`, `interview:read_assigned`, `member:assign_role`, `member:invite`, `member:read`, `member:remove`, `member:update`).
- `organization_member_roles`: the old role row of each member whose role changed is replaced by a new one (1: the Test Recruiter).
- `organization_members.updated_at`: each member the migration suspends (1: the Test Recruiter).
- `applications.updated_at`: each application whose responsible person was cleared (1: APP-2026-4ECR2D).
- `sessions.revoked_at`: open sessions of suspended members (none in the 15 Nov data).

The other six migrations change no existing timestamp value, so the list is the same with all seven applied
(confirmed in the 17 Nov rehearsal below). After the cut-over, set the real organisation's privacy-notice name and
privacy contact on Recruitment → Privacy before the careers pages are announced (Super Admin only):
notice name `TheTrustCoffee`, privacy contact `admin.support@thecrushcoffeeofficial.com` (both confirmed by the
owner on 17 Nov 2026).

## Restore verification

Checksums prove a backup file was not damaged; they do not prove it can be restored. `tz-restore-verify.cjs` does:

1. checks the dump against its `.sha256`;
2. restores it into a **new** database (it never reuses a name) with `pg_restore --exit-on-error`;
3. compares the copy with the source database, which is only read, in one consistent snapshot:
   - the same tables, and for every table the same number of rows **and the same content** (every row is turned
     into text and hashed, so one changed value anywhere is found);
   - the same migration history, triggers, functions, row-level-security policies, constraints, indexes, views,
     sequences, extensions and rights of the app's account;
4. checks the newest file backup: its manifest is intact, every copied file matches its checksum, and every
   original is still present and unchanged. Files newer than the file backup are reported.

The comparison is only meaningful while the source has not changed since the backup, which is why it runs with the
app stopped (steps 1–3). The verified copy is kept (it is used for step 4); it holds real data, so remove it once
the cut-over has been checked (`--drop` removes it at the end of a verification that is not followed by a rehearsal).

## Rollback and recovery

General rules: the app stays **stopped** until the database is in a known good state; a database that went wrong is
**renamed, never dropped**, until it has been reviewed; `storage/private` is not touched by any step.

"Restore the backup" below always means:

1. Stop the app; make sure nothing is connected.
2. `ALTER DATABASE hr_recruitment RENAME TO hr_recruitment_failed_<timestamp>;`
3. Create a new `hr_recruitment` owned by `hr_app` and `pg_restore --exit-on-error` the step-2 dump into it.
4. Prove it: the restored database must match the verified copy from step 3 / the dump's contents (same row counts and content checksums).
5. Remove `DB_SESSION_TIME_ZONE` from `.env` and run the **previous** version of the app (the restored database is the old, uncorrected one).

| Where it went wrong | State of the database | What to do |
|---|---|---|
| Steps 1–5 | Unchanged. | Fix the cause and start again. |
| Step 6 (`apply`) fails or a check fails | Unchanged (transaction rolled back). | Read the tool's output and the report; nothing to undo. |
| Step 7 (strict post-check) fails | Corrected, no migrations. | Do not continue. Restore the backup. (No valid activity can exist: the app is stopped.) |
| Step 9: migration **1** fails | Corrected; migration 1 left nothing. Old roles still in place. | Either fix the migration, `npx prisma migrate resolve --rolled-back 20261115120000_three_roles`, and deploy again; or restore the backup. The **old** app version still matches this database, but its sessions must stay non-UTC: prefer restoring. |
| Step 9: migration **2, 3 or 4** fails | Corrected; three roles in place; the failed migration left nothing; row-level security incomplete. | The new app must not be started on this state. Fix + `migrate resolve --rolled-back <name>` + deploy again; or restore the backup. |
| Step 9: migration **5** fails | As above, with all access rules of migrations 2–4. | Same: fix and redeploy, or restore the backup. |
| Step 9: migration **6** fails | As above, without the hardening. | Same. Do **not** start the app "temporarily" without migration 6: its code expects the database's sign-in functions. |
| Step 9: migration **7** fails | Fully hardened, without the privacy changes. | Same. Do not start the app on this state either: its forms send the age confirmation the database expects from migration 7. |
| Step 10 (post-check with expected changes) fails | Fully migrated, app not started. | Compare the unexpected differences with the rehearsal. If they cannot be explained, restore the backup. |
| After step 11: a problem while people are using the app | Fully migrated **plus new records the backup does not contain**. | See below. |

### A problem found after the app is in use again

A restore now would lose every record created since the backup. So:

1. **Stop the app. Back up the current state first** (`tz-backup.cjs` writes a new dump; run `storage-backup.cjs` too).
2. **List what was created or changed since the correction** (the moment recorded in `timestamp_corrections.applied_at`):
   applications, candidates, documents, notes, stage changes, assignments, users, memberships, invitations,
   sessions and audit records created or updated after it; and the files in `storage/private` newer than the
   step-2 file backup. `post --report … --expected … --allow-later-activity` shows which **pre-existing** values
   changed; rows added later are counted there and listed by their own `created_at`.
3. **Decide with the owner:**
   - **Fix forward (the default):** keep the database, correct the specific problem with a reviewed change. No record is lost.
   - **Restore** (for damage that cannot be repaired in place, or a security problem): restore the backup as
     described above, then re-enter the listed records by hand, or copy them with a script reviewed for that
     purpose. Nothing is merged automatically. Uploaded files stay where they are; files whose application was not
     carried over are listed, never deleted.
4. Keep the renamed failed database and the "current state" backup until the owner has confirmed nothing is missing.

## Rehearsal evidence

All on restored copies of the real database's backups; the real database has only been read (counts, `pg_dump`,
restore comparison).

- Correction alone: `hr_recruitment_tz_rehearsal`, `hr_recruitment_tz_rehearsal_pkg` (15 Nov 2026).
- Role migration before/after (copy since removed; report `roles-rehearsal-report-20261115T153620.json` kept); full
  production order with the first six migrations: `hr_recruitment_hardening_rehearsal` (identical in structure to the test database).
- Full production order with all seven migrations (17 Nov 2026): `hr_recruitment_rehearsal_seven_test`, restored from the
  15:05 backup (see the rehearsal report of that date).
- Restore verification of the 15:05 backup against the real database (read-only): exact copy, 256 rows in 47 tables
  (copy since removed).
- Safeguards (16 Nov 2026): refusal while another connection is open; a transaction or an idle connection that
  appears after preflight stops the run with nothing changed; expected changes
  recorded on one copy and accepted on another (copies since removed); a deleted row and a value
  moved backwards are caught and named.
