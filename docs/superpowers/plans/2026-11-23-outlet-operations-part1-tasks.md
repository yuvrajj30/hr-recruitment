# Outlet Operations Part 1: Tasks and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HR assigns occasional tasks to an employee at an outlet; the employee works on it, submits written or file proof; HR approves or requests changes; everything is kept as history, with in-app notifications. On the TEST database.

**Architecture:** Same pattern as Leave. New tables with row-level security; the app account only reads them; every change goes through SECURITY DEFINER functions that take identity from the session, check the permission key, lock the task, validate the transition and write the history and notifications. Evidence files sit in the private file store under a new `tasks/` folder; their metadata is written by the functions. Pure `rules.ts`, a service `tasks.ts`, a small `notifications.ts`, Next.js 16 screens under `/tasks` and a notification bell.

**Tech Stack:** PostgreSQL 17, Prisma 7 with `@prisma/adapter-pg`, Next.js 16 App Router, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-outlet-operations-design.md` (draft, with the owner's revisions of 23 Nov 2026), sections 3, 8, 9 (task rows), 10, 11. Sales and stock (sections 6, 7) are NOT in this plan.

## Global Constraints
- **Databases:** TEST database only. Each test-DB migration is applied only after the owner's one-time approval; never edit an applied migration. Dry-run every migration (rolled back) first. Real DB only in a later release with its own approvals.
- **Commits:** nothing committed or pushed without the owner's OK; "Stage" steps mean staged for one milestone commit.
- **Roles:** exactly three; checks by permission key. New keys: `task:manage` ("Assign, review and cancel tasks", SUPER_ADMIN + HR_MANAGER) and `self:task` ("See and work on own tasks", all three roles). Add to `permission-keys.ts`, `roles.ts`, `prisma/seed.ts`, the migration and the roles/permissions tests.
- **Identity:** organisation and actor from the session (`app_org_id()`, `app_user_id()`, `app_my_employee_id()`, `app_has_permission()`); the only ids taken from forms are the task id, the owner employee id and the outlet id, each checked inside the organisation; a missing or foreign id gives `not_found`.
- **Rights:** every new table: `REVOKE ALL ... FROM hr_runtime`, then SELECT only. No direct INSERT/UPDATE/DELETE by the app on task tables. Definer functions: `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL FROM PUBLIC`, EXECUTE granted only on `app_*` entry points.
- **Statuses:** `ASSIGNED`, `IN_PROGRESS`, `SUBMITTED`, `CHANGES_REQUESTED`, `APPROVED`, `CANCELLED`. Allowed: ASSIGNED→IN_PROGRESS; IN_PROGRESS→SUBMITTED; CHANGES_REQUESTED→IN_PROGRESS; SUBMITTED→APPROVED or CHANGES_REQUESTED; any open status (not APPROVED/CANCELLED)→CANCELLED. APPROVED and CANCELLED are final.
- **Priorities:** `LOW`, `NORMAL`, `HIGH`, `URGENT` (default NORMAL).
- **Proof kinds:** `PHOTO`, `DOCUMENT`, `TEXT`; at least one required per task; a submission must include every required kind.
- **Evidence files:** photos JPEG/PNG/WebP/HEIC, documents PDF; checked by content (magic bytes); in the app at most 3 files, 5 MB each and 5 MB in total per submission, to fit the 6 MB request limit (owner decision, 24 Nov; the database keeps 5 files of 10 MB as an outer limit); stored under `tasks/<year>/<uuid>`; always downloaded as an attachment through an authorised route; every download audited.
- **Text limits:** title 1-120, description 1-2000, notes and review notes 1-1000, submission text 1-4000 characters (trimmed).
- **Due date:** a local DATE in the organisation's time zone, optional local time; may not be before today at assignment; overdue = open and past due.
- **Four-eyes:** a person cannot review (approve or request changes on) a task whose owner is their own employee record, unless no other active member holds `task:manage`; such a review is marked `self_reviewed`.
- **Linked login required (owner revision, 23 Nov):** a task owner must be an active employee with a linked, active login; assigning or reassigning to anyone else is refused (`employee_no_login`). Only the owner starts and submits (`task_not_owner` for HR); HR may add notes. No on-behalf flags.
- **Notifications:** to logins only (`recipient_user_id`), inserted only by definer functions; new `NotificationType` values `TASK_ASSIGNED`, `TASK_SUBMITTED`, `TASK_CHANGES_REQUESTED`, `TASK_APPROVED`, `TASK_CANCELLED`, `TASK_DUE`; a new nullable `task_id` column with composite FK to the task.
- **Reminders:** the daily job sends `TASK_DUE` once on the due date and once the day after if still open; never more (unique per task, kind and day).
- **Evidence retention (D10):** a proposed setting only. Nothing deletes evidence automatically until the owner approves a period; the daily job sends reminders only.
- **Employee ID:** owners are picked and shown by `employees.employee_code` plus name everywhere (lists, detail, notifications).
- **Resources:** HR may attach reference files (same types, checks and limits as evidence, max 5 per task) and https links (max 10, 1-500 chars) at assignment or later; stored under `tasks/`; removal keeps history; downloads audited.
- **Rating (owner addition, 23 Nov):** approving requires `rating` 1-5 (1 Poor, 2 Below expectations, 3 Meets expectations, 4 Good, 5 Excellent) and allows a comment (1-1000); requesting changes takes no rating; a rating exists only on APPROVED tasks. No averages, rankings or salary figures are computed anywhere. Employees see their own rating and comment unless the owner decides otherwise (D11).
- **No salary logic:** no automatic scores, aggregates or incentive fields anywhere.

## Review Focus
1. A submission whose database call fails after files were stored: the stored files are deleted again, so no orphan files remain. Test in **Task 4**.
2. Evidence download by someone who may not see the task (another employee, the previous owner after reassignment, HR of another organisation): refused as not found, and allowed downloads are audited. Tests in **Task 2** (row access) and **Task 4** (route/service).
3. Reassignment after work started: allowed only while ASSIGNED, IN_PROGRESS or CHANGES_REQUESTED; the previous owner loses sight of the task; history shows old and new owner. Test in **Task 2**.
4. An owner who leaves the company (EXITED) with open tasks: cannot start or submit, gets no reminders; HR can still cancel or reassign. Test in **Task 2**.
5. The daily job run twice on one day, or skipped a day: reminders are never duplicated and the "day after" reminder still comes at most once. Test in **Task 2**.

---

### Task 1: Schema, permissions, rights

**Files:**
- Create: `prisma/migrations/20261124000000_tasks/migration.sql`
- Modify: `prisma/schema.prisma`, `src/lib/auth/permission-keys.ts`, `src/lib/auth/roles.ts`, `prisma/seed.ts`, `tests/auth/permissions.test.ts`, `tests/auth/roles.test.ts`
- Test: `tests/db/tasks.test.ts` (new; describe "tasks schema")

**Interfaces:**
- Produces tables: `tasks` (id, organization_id, outlet_id, owner_employee_id, title, description, due_on DATE, due_time TIME NULL, priority, proof_kinds `TaskProofKind[]` (non-empty, distinct), status, created_by_id, created_at, updated_at, submitted_at, decided_at, decided_by_id, decision_note, self_reviewed, cancelled_at, cancel_reason, final_at), `task_events` (id, organization_id, task_id, kind, from_status, to_status, note, changes JSONB, actor_id, created_at; append-only), `task_submissions` (id, organization_id, task_id, number, text, submitted_by_id, created_at; unique (task_id, number); append-only), `task_evidence` (id, organization_id, task_id, submission_id, storage_key unique, original_name, mime_type, size_bytes, sha256, created_at; never changed), `task_reminders` (task_id, kind `DUE`/`DUE_AFTER`, sent_on DATE; PK (task_id, kind)), `task_resources` (id, organization_id, task_id, kind `FILE`/`LINK`, storage_key NULL unique, url NULL, original_name, mime_type, size_bytes, sha256, added_by_id, added_at, removed_by_id, removed_at). `tasks` also gets `rating` SMALLINT NULL CHECK 1-5, `rating_comment`, and a CHECK that a rating exists exactly when status = APPROVED.
- Enums: `TaskStatus`, `TaskPriority`, `TaskProofKind`, `TaskEventKind` (`ASSIGNED`, `EDITED`, `REASSIGNED`, `RESOURCE_ADDED`, `RESOURCE_REMOVED`, `STARTED`, `NOTE`, `SUBMITTED`, `APPROVED`, `CHANGES_REQUESTED`, `CANCELLED`); `NotificationType` gains the six task values; `notifications.task_id` added.
- RLS: HR rows (`task:manage`) see all of the organisation; an employee (`self:task`) sees tasks where `owner_employee_id = app_my_employee_id()` and their children through the task.

- [ ] **Step 1: Failing tests.** Auth: permission count +2; `task:manage` only SUPER_ADMIN and HR_MANAGER; `self:task` all three. DB "tasks schema": the five tables and enums exist with RLS on; `hr_runtime` has SELECT only (no INSERT/UPDATE/DELETE/TRUNCATE) on all five; `task_events`, `task_submissions` reject UPDATE/DELETE even by the owner account (append-only trigger); `task_evidence` allows only `removed_at` to change; check constraints refuse an empty `proof_kinds`, a 121-character title, a duplicate proof kind, a rating of 0 or 6, and a rating on a task that is not APPROVED.
- [ ] **Step 2: Run** `npx vitest run tests/auth tests/db/tasks.test.ts`. Expected: FAIL (keys and tables missing).
- [ ] **Step 3: Write the migration** (enum `ADD VALUE`s for `NotificationType` at the top, not used in this migration), schema models with mapped names, keys, roles, seed. Dry-run on the test DB (rolled back). **Stop for the owner's approval to apply.**
- [ ] **Step 4: After approval, apply and run** the Step 2 command. Expected: PASS. Also `npx prisma validate`, `npx tsc --noEmit`.
- [ ] **Step 5: Stage.**

### Task 2: Task functions, notifications and daily job (SQL)

**Files:**
- Create: `prisma/migrations/20261124000100_task_functions/migration.sql`
- Modify: `tests/db/tasks.test.ts`, `tests/db/security-hardening.test.ts` (new entry points true, helpers false)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces entry points (all `SECURITY DEFINER`, return as stated):
  - `app_assign_task(p_owner uuid, p_outlet uuid, p_title text, p_description text, p_due_on date, p_due_time time, p_priority "TaskPriority", p_proof "TaskProofKind"[]) → uuid` (`task:manage`)
  - `app_edit_task(p_task uuid, p_title text, p_description text, p_due_on date, p_due_time time, p_priority "TaskPriority", p_proof "TaskProofKind"[], p_outlet uuid, p_owner uuid, p_reason text) → void` (`task:manage`; open tasks only; owner change only in ASSIGNED/IN_PROGRESS/CHANGES_REQUESTED, event REASSIGNED; other changes event EDITED with `changes` = {field: [old, new]}; reason required when anything but the description changes)
  - `app_start_task(p_task uuid) → void` (owner only), `app_add_task_note(p_task uuid, p_note text) → void` (owner or `task:manage`)
  - `app_submit_task(p_task uuid, p_text text, p_evidence jsonb) → uuid` (submission id; `p_evidence` = array of {storage_key, original_name, mime_type, size_bytes, sha256}; checks required kinds, ≤5 files, mime whitelist, ≤10485760 bytes, key pattern `^tasks/\d{4}/[0-9a-f-]{36}$`)
  - `app_review_task(p_task uuid, p_approve boolean, p_rating smallint, p_note text) → void` (`task:manage`; approving requires rating 1-5 (`rating_required`), requesting changes requires a note and refuses a rating; four-eyes)
  - `app_add_task_resource(p_task uuid, p_kind text, p_storage_key text, p_url text, p_name text, p_mime text, p_size int, p_sha256 text) → uuid`, `app_remove_task_resource(p_resource uuid) → void` (`task:manage`; open tasks only; url must start with `https://`)
  - `app_cancel_task(p_task uuid, p_reason text) → void` (`task:manage`)
  - `app_task_housekeeping(p_today date DEFAULT NULL) → integer` (maintenance mode only; reminders sent; no deletion)
- Error codes (RAISE P0001 messages): `not_found`, `task_not_open`, `task_bad_transition`, `task_not_owner`, `employee_not_active`, `outlet_not_active`, `task_due_in_past`, `task_proof_missing`, `task_too_many_files`, `task_bad_file`, `own_task`, `note_required`, `reason_required`, `text_too_long`, `text_required`, `rating_required`, `rating_not_allowed`, `bad_link`, `too_many_resources`, `employee_no_login`.
- Notifications written: assign → owner `TASK_ASSIGNED`; submit → every active `task:manage` login except the submitter `TASK_SUBMITTED`; review → owner `TASK_APPROVED`/`TASK_CHANGES_REQUESTED`; cancel → owner `TASK_CANCELLED`; reassign → new owner `TASK_ASSIGNED`; job → owner `TASK_DUE`. Owner without a login: none.

- [ ] **Step 1: Failing tests** in `tests/db/tasks.test.ts` (two organisations; SA, HR, two employees with logins, one without; two outlets):
  - full happy path ASSIGNED→IN_PROGRESS→SUBMITTED→APPROVED with events in order and one notification per step to the right person;
  - changes requested then resubmitted (submission numbers 1 and 2 kept);
  - approve without a rating → `rating_required`; request changes with a rating → `rating_not_allowed`; approve with 4 stores rating 4 and the comment, visible to the owner;
  - HR adds a PDF resource and an https link, removes the link (events RESOURCE_ADDED/REMOVED; removed link hidden from the owner); `http://` or `javascript:` links → `bad_link`;
  - every forbidden transition raises `task_bad_transition`; APPROVED/CANCELLED edits raise `task_not_open`;
  - submit without a required kind → `task_proof_missing`; 6 files → `task_too_many_files`; `image/gif` or 10485761 bytes or a bad key → `task_bad_file`;
  - task outlet differs from the owner's home outlet and the employee's `outlet_id` is unchanged afterwards;
  - employee B cannot see A's task or evidence rows; HR of organisation B sees none; employee calling `app_assign_task` → not allowed;
  - four-eyes: HR reviewing a task owned by their own employee record → `own_task`; allowed (and `self_reviewed`) when they are the only `task:manage` member;
  - staff without a login: assigning or reassigning to them → `employee_no_login`; HR start/submit → `task_not_owner`; HR note allowed;
  - **Review Focus 3:** reassign during IN_PROGRESS → old owner sees nothing, new owner sees it, event has old and new owner; reassign after SUBMITTED → `task_bad_transition`;
  - **Review Focus 4:** owner EXITED → start/submit `employee_not_active`; HR cancel works; job sends no reminder;
  - **Review Focus 5:** job twice on the due date → one `TASK_DUE`; job on due+1 → one more; job on due+2 → none; skipping the due date and running on due+1 → one `DUE_AFTER` only;
  - no automatic deletion: a task closed 5 years ago keeps its evidence after the daily job.
- [ ] **Step 2: Run** `npx vitest run tests/db/tasks.test.ts tests/db/security-hardening.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the functions** (lock the task row FOR UPDATE; then the owner employee FOR SHARE). Dry-run. **Stop for the owner's approval to apply.**
- [ ] **Step 4: After approval, apply and run** Step 2. Expected: PASS; then `npx vitest run tests/db` (no regressions).
- [ ] **Step 5: Stage.**

### Task 3: Rules and evidence checks (pure)

**Files:**
- Create: `src/lib/tasks/rules.ts`, `src/lib/tasks/evidence.ts`
- Modify: `src/lib/recruitment/storage.ts` (`newStorageKey` folder type adds `"tasks"`; `KEY_PATTERN` adds `tasks`)
- Test: `tests/tasks/rules.test.ts`, `tests/tasks/evidence.test.ts`, existing storage tests

**Interfaces:**
- Produces: `TASK_LIMITS = { titleMax: 120, descriptionMax: 2000, noteMax: 1000, textMax: 4000, fileMaxBytes: 10485760, filesMax: 5 }`; `TASK_STATUS_LABELS`, `TASK_PRIORITY_LABELS`, `PROOF_LABELS`; `parseTaskInput(raw, today: string): Parsed<TaskInput>` (TaskInput = {ownerId, outletId, title, description, dueOn, dueTime|null, priority, proof: TaskProofKind[]}); `parseReview(raw): Parsed<{approve: boolean, rating: number|null, note: string|null}>`; `RATING_LABELS: Record<1|2|3|4|5, string>`; `parseLink(raw): Parsed<string>` (https only, max 500); `isOverdue(task: {status, dueOn, dueTime}, now: Date, timeZone: string): boolean`; `TASK_DB_MESSAGES` + `taskRefusal(message: string): string|null` (longest code first, as in Leave); `detectEvidenceKind(bytes: Uint8Array, fileName: string): {proof: "PHOTO"|"DOCUMENT", mimeType: string, extension: string} | null`; `checkEvidence(file: {name, size}, bytes): {ok: true, kind, safeName} | {ok: false, message}`.

- [ ] **Step 1: Failing tests:** parse limits (121-char title, empty proof, due yesterday refused, today allowed); `isOverdue` across midnight in Asia/Kolkata; magic bytes accepted for JPEG (`FF D8 FF`), PNG, WebP (`RIFF....WEBP`), HEIC (`ftypheic`/`ftypheix`/`ftypmif1`), PDF (`%PDF-`); a `.jpg` name with PDF bytes is detected as PDF by content; GIF, SVG, HTML and EXE refused; 10485761 bytes refused; `tasks/2026/<uuid>` keys accepted by storage; `tasks/../x` refused; a message for every Task 2 error code.
- [ ] **Step 2: Run** `npx vitest run tests/tasks tests/recruitment`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2. Expected: PASS.
- [ ] **Step 5: Stage.**

### Task 4: Services: tasks, evidence, notifications, daily job

**Files:**
- Create: `src/lib/tasks/tasks.ts`, `src/lib/notifications/notifications.ts`, `src/lib/tasks/housekeeping.ts`
- Modify: `scripts/privacy-retention.ts` (one more step: task reminders only; no file deletion)
- Test: `tests/db/tasks-service.test.ts`, `tests/db/notifications-service.test.ts`

**Interfaces:**
- Consumes: Task 2 functions, Task 3 rules, `getFileStorage()`, `staffDb`, `maintenanceDb`, `writeAudit`.
- Produces (each checks its permission key first, ForbiddenError otherwise; refusals mapped through `taskRefusal`):
  - `listTasks(db, ctx, filter: {status?: "OPEN"|"SUBMITTED"|"DONE"|"ALL", ownerId?, outletId?}) → TaskListItem[]` (`task:manage`), `listMyTasks(db, ctx) → TaskListItem[]` (`self:task`)
  - `getTask(db, ctx, id) → TaskDetail` (task, events with actor names, submissions with evidence metadata; `canReview`, `canEdit`, `canWork` flags)
  - `assignTask(deps, ctx, input: TaskInput) → string`, `editTask(deps, ctx, id, input: TaskInput, reason: string|null) → void`, `startTask`, `addTaskNote(deps, ctx, id, note)`, `reviewTask(deps, ctx, id, approve, rating: number|null, note)`, `cancelTask(deps, ctx, id, reason)`
  - `submitTask(deps, ctx, id, text: string|null, files: {name: string, size: number, bytes: Uint8Array}[]) → string` (checks each file, stores under `tasks/`, calls `app_submit_task`; on any failure deletes the files it stored, then rethrows)
  - `addTaskResource(deps, ctx, id, input: {file?: {name, size, bytes}, url?: string}) → string`, `removeTaskResource(deps, ctx, resourceId)`, `readResource(deps, ctx, resourceId) → {name, mimeType, bytes}` (same storage clean-up and audit rules as evidence)
  - `readEvidence(deps, ctx, evidenceId) → {name, mimeType, bytes}` (row visible through RLS, else not_found; audited `task.evidence_downloaded`)
  - `listMyNotifications(db, ctx, limit = 30)`, `unreadCount(db, ctx) → number`, `markRead(db, ctx, id)`, `markAllRead(db, ctx)` (`notification:read`)
  - `runTaskHousekeeping(db) → {reminders: number} | null` (null when the function does not exist yet; deletes nothing)
  - `listApprovedTasksForEmployee(db, ctx, employeeId) → TaskListItem[]` (`task:manage`; for the employee's HR page, no scores)

- [ ] **Step 1: Failing tests:** permissions per role (employee `listTasks` → Forbidden; `assignTask` → Forbidden); submit with a photo and a PDF stores two files under `tasks/` and the detail lists them; **Review Focus 1:** submit with one good and one GIF file → refused and NO file left in storage; submit that the DB refuses (`task_proof_missing`) → files removed; **Review Focus 2:** `readEvidence` by the owner works and writes an audit row, by another employee / the previous owner after reassignment / HR of org B → not_found; notifications: owner sees `TASK_ASSIGNED` with the task link, `unreadCount` drops after `markRead`, cannot mark someone else's; housekeeping sends reminders and deletes nothing.
- [ ] **Step 2: Run** `npx vitest run tests/db/tasks-service.test.ts tests/db/notifications-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (follow `src/lib/leave/leave.ts`: `run`/`friendly`/`audit`, transactions with `{ timeout: 30_000, maxWait: 10_000 }` where several statements run).
- [ ] **Step 4: Run** Step 2. Expected: PASS.
- [ ] **Step 5: Stage.**

### Task 5: Screens, evidence route, notification bell

**Files:**
- Create: `src/app/(app)/tasks/page.tsx` (employee: my tasks; HR: all tasks with filters by status, outlet, person, overdue), `src/app/(app)/tasks/new/page.tsx`, `src/app/(app)/tasks/[taskId]/page.tsx` (details, history timeline, submissions with evidence links, start/note/submit form for the owner or HR on behalf, review and cancel for HR, edit/reassign), `src/app/(app)/tasks/actions.ts`, `src/app/api/task-evidence/[evidenceId]/route.ts` and `src/app/api/task-resources/[resourceId]/route.ts` (attachment download, `private, no-store`, `nosniff`, as `/api/documents`), `src/app/(app)/notifications/page.tsx`, `src/components/tasks/*.tsx`, `src/components/notifications/notification-bell.tsx`
- Modify: `src/lib/navigation.ts` (new item `{ key: "tasks", label: "Tasks", href: "/tasks", section: "workspace", status: "available", requiresAny: ["self:task", "task:manage"] }`), the app header (bell with unread count, links to `/notifications`), `src/components/dashboard/employee-home.tsx` (latest notifications instead of "You have no notifications"), the employee HR page (`src/app/(app)/employees/[employeeId]/page.tsx`: "Approved tasks" list for `task:manage`), `tests/auth/navigation.test.ts`

**Interfaces:**
- Consumes: Task 4 service functions only. Pages check permissions on the server and render `<NoAccess/>`; client components get plain values; upload uses a server action with `FormData` files (limits from `TASK_LIMITS`, also enforced server-side).

- [ ] **Step 1:** Use the `frontend-design` skill for the task detail (status, due, proof checklist, timeline) and the task list; match the Leave and Attendance styling. Copy: plain, sentence case, buttons say what happens ("Start task", "Submit for review", "Approve", "Request changes", "Cancel task").
- [ ] **Step 2: Build and check:** `npx next typegen && npx tsc --noEmit && npm run lint && npx vitest run tests/auth`. Expected: all clean.
- [ ] **Step 3: Stage.**

### Task 6: Final review and checks
- [ ] Independent whole-branch review (read-only reviewers, findings verified before fixing); Critical/Important fixed with a failing test first.
- [ ] Full suite twice (`npx vitest run`), `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- [ ] Browser walkthrough on the test site (`npm run dev:testdb`, port 3001, test accounts only): HR picks the employee by ID, assigns a task at another outlet with photo + text proof, a PDF resource and a link; the employee sees the bell, starts, submits a photo; HR requests changes; the employee resubmits; HR approves with a rating of 4 and a comment, which the employee sees; the evidence downloads as an attachment; another employee cannot open the task URL or the evidence URL; the employee's home outlet is unchanged.
- [ ] Report (rulings, deferred minors, skills used) and ask the owner about committing.
