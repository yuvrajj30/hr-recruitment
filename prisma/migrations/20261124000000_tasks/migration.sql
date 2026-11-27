-- Tasks, part 1 of 2 (CafeOS Milestone 4, Outlet Operations Part 1): tables, rights and row access.
-- Design: docs/superpowers/specs/2026-11-23-outlet-operations-design.md section 8 (draft). HR assigns an occasional task to one
-- employee with a linked, active login at one outlet (the task's outlet, independent of the employee's home outlet); the employee works on it and
-- submits proof; HR approves it (with a 1-5 rating) or requests changes. The app account only READS these tables;
-- every change is a database function (part 2, 20261124000100_task_functions) that writes the history itself.

-- New notification kinds (added first; nothing in this migration uses them).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_DUE';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "key", "module", "description") VALUES
  (gen_random_uuid(), 'task:manage', 'task', 'Assign, review and cancel tasks'),
  (gen_random_uuid(), 'self:task', 'self', 'See and work on my own tasks')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE (r."key" IN ('SUPER_ADMIN', 'HR_MANAGER') AND p."key" = 'task:manage')
   OR (r."key" IN ('SUPER_ADMIN', 'HR_MANAGER', 'EMPLOYEE') AND p."key" = 'self:task')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Types
-- ---------------------------------------------------------------------------
CREATE TYPE "TaskStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'CANCELLED');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "TaskProofKind" AS ENUM ('PHOTO', 'DOCUMENT', 'TEXT');
CREATE TYPE "TaskEventKind" AS ENUM ('ASSIGNED', 'EDITED', 'REASSIGNED', 'RESOURCE_ADDED', 'RESOURCE_REMOVED', 'STARTED', 'NOTE', 'SUBMITTED',
  'APPROVED', 'CHANGES_REQUESTED', 'CANCELLED');
CREATE TYPE "TaskResourceKind" AS ENUM ('FILE', 'LINK');
CREATE TYPE "TaskReminderKind" AS ENUM ('DUE', 'DUE_AFTER');

-- At least one proof kind, none twice (a CHECK cannot hold a subquery, so a small immutable helper does it).
CREATE FUNCTION "task_proof_ok"(p "TaskProofKind"[]) RETURNS BOOLEAN AS $$
  SELECT cardinality(p) >= 1 AND cardinality(p) = (SELECT count(DISTINCT x) FROM unnest(p) x);
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Tasks
-- ---------------------------------------------------------------------------
CREATE TABLE "tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  -- Where the work happens: independent of the owner's home outlet.
  "outlet_id" UUID NOT NULL,
  "owner_employee_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  -- Local date (and optional local time) in the organisation's time zone.
  "due_on" DATE NOT NULL,
  "due_time" TIME(0),
  "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
  "proof_kinds" "TaskProofKind"[] NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'ASSIGNED',
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "submitted_at" TIMESTAMPTZ(6),
  "decided_at" TIMESTAMPTZ(6),
  "decided_by_id" UUID,
  "decision_note" TEXT,
  "self_reviewed" BOOLEAN NOT NULL DEFAULT false,
  -- HR's judgement of the approved work, 1 (Poor) to 5 (Excellent). Never averaged or converted by the system.
  "rating" SMALLINT,
  "rating_comment" TEXT,
  "cancelled_at" TIMESTAMPTZ(6),
  "cancelled_by_id" UUID,
  "cancel_reason" TEXT,
  -- When the task became APPROVED or CANCELLED (evidence retention counts from here).
  "final_at" TIMESTAMPTZ(6),
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tasks_text_check" CHECK (
    "title" = btrim("title") AND char_length("title") BETWEEN 1 AND 120
    AND "description" = btrim("description") AND char_length("description") BETWEEN 1 AND 2000
    AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 1000)
    AND ("rating_comment" IS NULL OR char_length("rating_comment") BETWEEN 1 AND 1000)
    AND ("cancel_reason" IS NULL OR char_length("cancel_reason") BETWEEN 1 AND 500)),
  CONSTRAINT "tasks_proof_check" CHECK ("task_proof_ok"("proof_kinds")),
  CONSTRAINT "tasks_rating_check" CHECK ((("status" = 'APPROVED') = ("rating" IS NOT NULL)) AND ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
    AND ("rating_comment" IS NULL OR "rating" IS NOT NULL)),
  CONSTRAINT "tasks_final_check" CHECK (("status" IN ('APPROVED', 'CANCELLED')) = ("final_at" IS NOT NULL)
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX "tasks_organization_id_id_key" ON "tasks"("organization_id", "id");
CREATE INDEX "tasks_organization_id_status_due_on_idx" ON "tasks"("organization_id", "status", "due_on");
CREATE INDEX "tasks_owner_employee_id_status_idx" ON "tasks"("owner_employee_id", "status");
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_outlet_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_owner_fkey" FOREIGN KEY ("organization_id", "owner_employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "tasks_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. History, submissions, evidence, resources, reminders
-- ---------------------------------------------------------------------------
CREATE TABLE "task_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "kind" "TaskEventKind" NOT NULL,
  "from_status" "TaskStatus",
  "to_status" "TaskStatus" NOT NULL,
  "note" TEXT,
  -- For EDITED / REASSIGNED: {"field": [old, new], ...}.
  "changes" JSONB,
  "actor_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "task_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_events_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000)
);
CREATE INDEX "task_events_task_id_created_at_idx" ON "task_events"("task_id", "created_at");
CREATE INDEX "task_events_organization_id_idx" ON "task_events"("organization_id");

CREATE TABLE "task_submissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "text" TEXT,
  "submitted_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "task_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_submissions_text_check" CHECK ("text" IS NULL OR char_length("text") BETWEEN 1 AND 4000),
  CONSTRAINT "task_submissions_number_check" CHECK ("number" >= 1)
);
CREATE UNIQUE INDEX "task_submissions_task_id_number_key" ON "task_submissions"("task_id", "number");
CREATE UNIQUE INDEX "task_submissions_organization_id_id_key" ON "task_submissions"("organization_id", "id");
CREATE INDEX "task_submissions_organization_id_idx" ON "task_submissions"("organization_id");

CREATE TABLE "task_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "storage_key" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  -- Evidence is kept: automatic deletion after a retention period is a proposed setting, not built until the owner
  -- approves the period.
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "task_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_evidence_file_check" CHECK ("storage_key" ~ '^tasks/[0-9]{4}/[0-9a-f-]{36}$'
    AND "mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
    AND "size_bytes" BETWEEN 1 AND 10485760 AND "sha256" ~ '^[0-9a-f]{64}$'
    AND char_length("original_name") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "task_evidence_storage_key_key" ON "task_evidence"("storage_key");
CREATE INDEX "task_evidence_task_id_idx" ON "task_evidence"("task_id");
CREATE INDEX "task_evidence_organization_id_idx" ON "task_evidence"("organization_id");

CREATE TABLE "task_resources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "kind" "TaskResourceKind" NOT NULL,
  "storage_key" TEXT,
  "url" TEXT,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "sha256" TEXT,
  "added_by_id" UUID,
  "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "removed_by_id" UUID,
  "removed_at" TIMESTAMPTZ(6),
  CONSTRAINT "task_resources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_resources_kind_check" CHECK (COALESCE(CASE "kind"
    WHEN 'FILE' THEN "storage_key" ~ '^tasks/[0-9]{4}/[0-9a-f-]{36}$' AND "url" IS NULL
      AND "mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
      AND "size_bytes" BETWEEN 1 AND 10485760 AND "sha256" ~ '^[0-9a-f]{64}$'
    ELSE "storage_key" IS NULL AND "url" ~ '^https://' AND char_length("url") <= 500 AND "mime_type" IS NULL AND "size_bytes" IS NULL AND "sha256" IS NULL
  END, false) AND char_length("original_name") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "task_resources_storage_key_key" ON "task_resources"("storage_key");
CREATE INDEX "task_resources_task_id_idx" ON "task_resources"("task_id");
CREATE INDEX "task_resources_organization_id_idx" ON "task_resources"("organization_id");

-- One reminder of each kind per task, ever (the daily job may run more than once a day).
CREATE TABLE "task_reminders" (
  "organization_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "kind" "TaskReminderKind" NOT NULL,
  "sent_on" DATE NOT NULL,
  CONSTRAINT "task_reminders_pkey" PRIMARY KEY ("task_id", "kind")
);
CREATE INDEX "task_reminders_organization_id_idx" ON "task_reminders"("organization_id");

ALTER TABLE "task_events"
  ADD CONSTRAINT "task_events_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_submissions"
  ADD CONSTRAINT "task_submissions_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_evidence"
  ADD CONSTRAINT "task_evidence_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_evidence_submission_fkey" FOREIGN KEY ("organization_id", "submission_id") REFERENCES "task_submissions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_resources"
  ADD CONSTRAINT "task_resources_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "task_resources_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "task_resources_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_reminders"
  ADD CONSTRAINT "task_reminders_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Notifications can point at a task.
ALTER TABLE "notifications" ADD COLUMN "task_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_fkey" FOREIGN KEY ("organization_id", "task_id") REFERENCES "tasks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "notifications_task_id_idx" ON "notifications"("task_id");

-- ---------------------------------------------------------------------------
-- 5. Append-only history
-- ---------------------------------------------------------------------------
-- Rows are never changed. Only the user columns may be cleared by ON DELETE SET NULL when a user is deleted, and (for
-- resources) the removal columns may be set once, when HR removes a resource.
CREATE FUNCTION "block_task_history_updates"() RETURNS trigger AS $$
DECLARE
  v_free TEXT[] := CASE TG_TABLE_NAME
    WHEN 'task_events' THEN ARRAY['actor_id']
    WHEN 'task_submissions' THEN ARRAY['submitted_by_id']
    WHEN 'task_resources' THEN ARRAY['removed_at', 'removed_by_id', 'added_by_id']
    ELSE ARRAY[]::TEXT[] END;
BEGIN
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'task_events' AND NEW."actor_id" IS NOT NULL AND NEW."actor_id" IS DISTINCT FROM OLD."actor_id"
     OR TG_TABLE_NAME = 'task_submissions' AND NEW."submitted_by_id" IS NOT NULL AND NEW."submitted_by_id" IS DISTINCT FROM OLD."submitted_by_id" THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'task_resources' AND (OLD."removed_at" IS NOT NULL AND NEW."removed_at" IS DISTINCT FROM OLD."removed_at"
                                          OR OLD."removed_by_id" IS NOT NULL AND NEW."removed_by_id" IS NOT NULL AND NEW."removed_by_id" IS DISTINCT FROM OLD."removed_by_id") THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "task_events_append_only" BEFORE UPDATE ON "task_events" FOR EACH ROW EXECUTE FUNCTION "block_task_history_updates"();
CREATE TRIGGER "task_submissions_append_only" BEFORE UPDATE ON "task_submissions" FOR EACH ROW EXECUTE FUNCTION "block_task_history_updates"();
CREATE TRIGGER "task_evidence_append_only" BEFORE UPDATE ON "task_evidence" FOR EACH ROW EXECUTE FUNCTION "block_task_history_updates"();
CREATE TRIGGER "task_resources_append_only" BEFORE UPDATE ON "task_resources" FOR EACH ROW EXECUTE FUNCTION "block_task_history_updates"();
CREATE TRIGGER "task_reminders_append_only" BEFORE UPDATE ON "task_reminders" FOR EACH ROW EXECUTE FUNCTION "block_task_history_updates"();
CREATE TRIGGER "task_events_no_truncate" BEFORE TRUNCATE ON "task_events" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();
CREATE TRIGGER "task_submissions_no_truncate" BEFORE TRUNCATE ON "task_submissions" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();
CREATE TRIGGER "task_evidence_no_truncate" BEFORE TRUNCATE ON "task_evidence" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();

-- ---------------------------------------------------------------------------
-- 6. Row-level security and rights
-- ---------------------------------------------------------------------------
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_reminders" ENABLE ROW LEVEL SECURITY;

-- HR (task:manage) reads every task of its organisation; an employee (self:task) reads the tasks they own now.
CREATE POLICY "hr_reads" ON "tasks" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('task:manage')));
CREATE POLICY "own_rows" ON "tasks" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('self:task'))
  AND "owner_employee_id" = (SELECT "app_my_employee_id"()));
CREATE POLICY "hr_reads" ON "task_events" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('task:manage')));
CREATE POLICY "own_rows" ON "task_events" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('self:task'))
  AND EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_events"."task_id" AND t."owner_employee_id" = (SELECT "app_my_employee_id"())));
CREATE POLICY "hr_reads" ON "task_submissions" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('task:manage')));
CREATE POLICY "own_rows" ON "task_submissions" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('self:task'))
  AND EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_submissions"."task_id" AND t."owner_employee_id" = (SELECT "app_my_employee_id"())));
CREATE POLICY "hr_reads" ON "task_evidence" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('task:manage')));
CREATE POLICY "own_rows" ON "task_evidence" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('self:task'))
  AND EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_evidence"."task_id" AND t."owner_employee_id" = (SELECT "app_my_employee_id"())));
CREATE POLICY "hr_reads" ON "task_resources" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('task:manage')));
-- The owner sees resources still attached (a removed link or file is gone for them; HR keeps the history).
CREATE POLICY "own_rows" ON "task_resources" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('self:task'))
  AND "removed_at" IS NULL
  AND EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "task_resources"."task_id" AND t."owner_employee_id" = (SELECT "app_my_employee_id"())));
-- Reminders are internal to the daily job: no policy, no rights.

REVOKE ALL ON "tasks", "task_events", "task_submissions", "task_evidence", "task_resources", "task_reminders" FROM hr_runtime;
GRANT SELECT ON "tasks", "task_events", "task_submissions", "task_evidence", "task_resources" TO hr_runtime;
REVOKE ALL ON FUNCTION "block_task_history_updates"(), "task_proof_ok"("TaskProofKind"[]) FROM PUBLIC;

COMMIT;
