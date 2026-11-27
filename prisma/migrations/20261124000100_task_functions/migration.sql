-- Tasks, part 2 of 2: the only way to change tasks. Every entry function finds out who is asking from the session,
-- checks the permission key in SQL, resolves every id within the caller's organisation (a missing and a foreign id give
-- the same 'not_found'), locks the task row, checks the step is allowed, and writes the history and notifications.
-- Every task owner has a linked, active login (so they receive notifications); only the owner starts and submits a task.
-- Evidence is never deleted automatically (retention is a proposed setting, not built until the owner approves it).
-- Design: docs/superpowers/specs/2026-11-23-outlet-operations-design.md section 8 (draft); plan Task 2.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Helpers (internal: not callable by the app account)
-- ---------------------------------------------------------------------------
-- The caller holds this permission (an active member of an active organisation); returns their organisation.
CREATE FUNCTION "task_require"(p_permission TEXT) RETURNS UUID AS $$
BEGIN
  IF "app_staff_role"() IS NULL OR NOT "app_has_permission"(p_permission) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN "app_org_id"();
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- The task, locked, if the caller may see it: HR (task:manage) any task of the organisation; an employee (self:task)
-- only the tasks they own now. Anything else: not_found.
CREATE FUNCTION "task_lock"(p_task UUID) RETURNS "tasks" AS $$
DECLARE
  v_org UUID := "app_org_id"();
  v_task "tasks";
BEGIN
  IF v_org IS NULL OR "app_staff_role"() IS NULL THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.* INTO v_task FROM "tasks" t WHERE t."id" = p_task AND t."organization_id" = v_org FOR UPDATE;
  IF NOT FOUND OR NOT ("app_has_permission"('task:manage')
                       OR ("app_has_permission"('self:task') AND v_task."owner_employee_id" = "app_my_employee_id"())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_task;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Only the owner works on their task (start, submit). Anyone else who can see it (HR): task_not_owner.
CREATE FUNCTION "task_require_owner"(p_task "tasks") RETURNS void AS $$
BEGIN
  IF NOT ("app_has_permission"('self:task') AND p_task."owner_employee_id" = "app_my_employee_id"()) THEN
    RAISE EXCEPTION 'task_not_owner' USING ERRCODE = 'P0001';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- An active employee of the organisation (locked for share), else not_found / employee_not_active.
CREATE FUNCTION "task_active_employee"(p_org UUID, p_employee UUID) RETURNS "employees" AS $$
DECLARE
  v_emp "employees";
BEGIN
  SELECT e.* INTO v_emp FROM "employees" e WHERE e."id" = p_employee AND e."organization_id" = p_org FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_emp."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_emp;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "task_active_outlet"(p_org UUID, p_outlet UUID) RETURNS void AS $$
DECLARE
  v_active BOOLEAN;
BEGIN
  SELECT o."is_active" INTO v_active FROM "outlets" o WHERE o."id" = p_outlet AND o."organization_id" = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'outlet_not_active' USING ERRCODE = 'P0001';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Trimmed text within limits: NULL/empty -> p_missing (or NULL when p_missing is NULL), too long -> text_too_long.
CREATE FUNCTION "task_text"(p_value TEXT, p_max INTEGER, p_missing TEXT) RETURNS TEXT AS $$
DECLARE
  v TEXT := NULLIF(btrim(COALESCE(p_value, '')), '');
BEGIN
  IF v IS NULL THEN
    IF p_missing IS NOT NULL THEN
      RAISE EXCEPTION '%', p_missing USING ERRCODE = 'P0001';
    END IF;
    RETURN NULL;
  END IF;
  IF char_length(v) > p_max THEN
    RAISE EXCEPTION 'text_too_long' USING ERRCODE = 'P0001';
  END IF;
  RETURN v;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "task_today"(p_org UUID) RETURNS DATE AS $$
  SELECT (clock_timestamp() AT TIME ZONE "att_org_timezone"(p_org))::date;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- The login of an employee (an active member with an active user), or NULL.
CREATE FUNCTION "task_owner_login"(p_org UUID, p_employee UUID) RETURNS UUID AS $$
  SELECT om."user_id" FROM "employees" e
  JOIN "organization_members" om ON om."id" = e."member_id" AND om."organization_id" = e."organization_id" AND om."status" = 'ACTIVE'
  JOIN "users" u ON u."id" = om."user_id" AND u."status" = 'ACTIVE'
  WHERE e."id" = p_employee AND e."organization_id" = p_org;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- A task owner must be an active employee with a linked, active login (they get the notifications and do the work).
CREATE FUNCTION "task_owner_with_login"(p_org UUID, p_employee UUID) RETURNS UUID AS $$
DECLARE
  v_login UUID;
BEGIN
  PERFORM "task_active_employee"(p_org, p_employee);
  v_login := "task_owner_login"(p_org, p_employee);
  IF v_login IS NULL THEN
    RAISE EXCEPTION 'employee_no_login' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_login;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Active logins holding task:manage in the organisation (reviewers), optionally without one user.
CREATE FUNCTION "task_reviewers"(p_org UUID, p_except UUID) RETURNS SETOF UUID AS $$
  SELECT DISTINCT om."user_id" FROM "organization_members" om
  JOIN "users" u ON u."id" = om."user_id" AND u."status" = 'ACTIVE'
  JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
  JOIN "role_permissions" rp ON rp."role_id" = omr."role_id"
  JOIN "permissions" p ON p."id" = rp."permission_id" AND p."key" = 'task:manage'
  WHERE om."organization_id" = p_org AND om."status" = 'ACTIVE' AND om."user_id" IS DISTINCT FROM p_except;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "task_notify"(p_org UUID, p_user UUID, p_type "NotificationType", p_task UUID, p_subject TEXT, p_body TEXT) RETURNS void AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO "notifications" ("id", "organization_id", "type", "channel", "recipient_user_id", "subject", "body", "status", "sent_at", "task_id", "created_at")
  VALUES (gen_random_uuid(), p_org, p_type, 'IN_APP', p_user, left(p_subject, 200), left(p_body, 1000), 'SENT', clock_timestamp(), p_task, clock_timestamp());
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "task_event"(p_task "tasks", p_kind "TaskEventKind", p_from "TaskStatus", p_to "TaskStatus", p_note TEXT, p_changes JSONB)
RETURNS void AS $$
  INSERT INTO "task_events" ("organization_id", "task_id", "kind", "from_status", "to_status", "note", "changes", "actor_id")
  VALUES (p_task."organization_id", p_task."id", p_kind, p_from, p_to, p_note, p_changes, "app_user_id"());
$$ LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- A file entry (evidence or resource) is a key in the tasks/ folder, an allowed type, at most 10 MB, a SHA-256.
CREATE FUNCTION "task_file_ok"(p_key TEXT, p_mime TEXT, p_size BIGINT, p_sha TEXT, p_name TEXT) RETURNS BOOLEAN AS $$
  SELECT COALESCE(p_key ~ '^tasks/[0-9]{4}/[0-9a-f-]{36}$'
    AND p_mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
    AND p_size BETWEEN 1 AND 10485760 AND p_sha ~ '^[0-9a-f]{64}$'
    AND char_length(btrim(p_name)) BETWEEN 1 AND 200, false);
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

-- Nobody reviews a task they own, unless no other active member can review.
CREATE FUNCTION "task_check_four_eyes"(p_task "tasks") RETURNS BOOLEAN AS $$
BEGIN
  IF p_task."owner_employee_id" IS DISTINCT FROM "app_my_employee_id"() THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM "task_reviewers"(p_task."organization_id", "app_user_id"())) THEN
    RAISE EXCEPTION 'own_task' USING ERRCODE = 'P0001';
  END IF;
  RETURN true; -- the only reviewer: allowed, marked self_reviewed
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. Entry points for the app
-- ---------------------------------------------------------------------------
-- HR assigns a task. Returns its id.
CREATE FUNCTION "app_assign_task"(p_owner UUID, p_outlet UUID, p_title TEXT, p_description TEXT, p_due_on DATE, p_due_time TIME,
                                  p_priority "TaskPriority", p_proof "TaskProofKind"[]) RETURNS UUID AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_login UUID := "task_owner_with_login"(v_org, p_owner);
  v_title TEXT := "task_text"(p_title, 120, 'text_required');
  v_desc TEXT := "task_text"(p_description, 2000, 'text_required');
  v_task "tasks";
  v_outlet TEXT;
BEGIN
  PERFORM "task_active_outlet"(v_org, p_outlet);
  IF p_due_on IS NULL OR p_due_on < "task_today"(v_org) THEN
    RAISE EXCEPTION 'task_due_in_past' USING ERRCODE = 'P0001';
  END IF;
  IF p_proof IS NULL OR NOT "task_proof_ok"(p_proof) THEN
    RAISE EXCEPTION 'task_proof_missing' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "tasks" ("organization_id", "outlet_id", "owner_employee_id", "title", "description", "due_on", "due_time", "priority", "proof_kinds", "created_by_id")
  VALUES (v_org, p_outlet, p_owner, v_title, v_desc, p_due_on, p_due_time, COALESCE(p_priority, 'NORMAL'), p_proof, "app_user_id"())
  RETURNING * INTO v_task;
  PERFORM "task_event"(v_task, 'ASSIGNED', NULL, 'ASSIGNED', NULL, NULL);
  SELECT o."name" INTO v_outlet FROM "outlets" o WHERE o."id" = p_outlet;
  PERFORM "task_notify"(v_org, v_login, 'TASK_ASSIGNED', v_task."id", 'New task: ' || v_title,
                        'Due ' || to_char(p_due_on, 'DD Mon YYYY') || ' at ' || v_outlet || '.');
  RETURN v_task."id";
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR edits an open task. Changing anything but the description needs a reason. A new owner is possible only before the
-- task is submitted (REASSIGNED); every change is recorded with its old and new value.
CREATE FUNCTION "app_edit_task"(p_task UUID, p_title TEXT, p_description TEXT, p_due_on DATE, p_due_time TIME, p_priority "TaskPriority",
                                p_proof "TaskProofKind"[], p_outlet UUID, p_owner UUID, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_task "tasks" := "task_lock"(p_task);
  v_title TEXT := "task_text"(p_title, 120, 'text_required');
  v_desc TEXT := "task_text"(p_description, 2000, 'text_required');
  v_reason TEXT := "task_text"(p_reason, 1000, NULL);
  v_changes JSONB := '{}'::JSONB;
  v_outlet TEXT;
BEGIN
  IF v_task."status" IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'task_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF p_proof IS NULL OR NOT "task_proof_ok"(p_proof) THEN
    RAISE EXCEPTION 'task_proof_missing' USING ERRCODE = 'P0001';
  END IF;
  IF v_title IS DISTINCT FROM v_task."title" THEN v_changes := v_changes || jsonb_build_object('title', jsonb_build_array(v_task."title", v_title)); END IF;
  IF p_due_on IS DISTINCT FROM v_task."due_on" OR p_due_time IS DISTINCT FROM v_task."due_time" THEN
    IF p_due_on IS NULL OR (p_due_on IS DISTINCT FROM v_task."due_on" AND p_due_on < "task_today"(v_org)) THEN
      RAISE EXCEPTION 'task_due_in_past' USING ERRCODE = 'P0001';
    END IF;
    v_changes := v_changes || jsonb_build_object('due', jsonb_build_array(v_task."due_on"::TEXT || COALESCE(' ' || v_task."due_time"::TEXT, ''),
                                                                          p_due_on::TEXT || COALESCE(' ' || p_due_time::TEXT, '')));
  END IF;
  IF COALESCE(p_priority, 'NORMAL') IS DISTINCT FROM v_task."priority" THEN
    v_changes := v_changes || jsonb_build_object('priority', jsonb_build_array(v_task."priority", COALESCE(p_priority, 'NORMAL')));
  END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(p_proof) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_task."proof_kinds") x) THEN
    v_changes := v_changes || jsonb_build_object('proof_kinds', jsonb_build_array(to_jsonb(v_task."proof_kinds"), to_jsonb(p_proof)));
  END IF;
  IF p_outlet IS DISTINCT FROM v_task."outlet_id" THEN
    PERFORM "task_active_outlet"(v_org, p_outlet);
    v_changes := v_changes || jsonb_build_object('outlet_id', jsonb_build_array(v_task."outlet_id", p_outlet));
  END IF;
  IF p_owner IS DISTINCT FROM v_task."owner_employee_id" THEN
    IF v_task."status" NOT IN ('ASSIGNED', 'IN_PROGRESS', 'CHANGES_REQUESTED') THEN
      RAISE EXCEPTION 'task_bad_transition' USING ERRCODE = 'P0001';
    END IF;
    PERFORM "task_owner_with_login"(v_org, p_owner);
    v_changes := v_changes || jsonb_build_object('owner_employee_id', jsonb_build_array(v_task."owner_employee_id", p_owner));
  END IF;
  IF v_changes <> '{}'::JSONB AND v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF v_desc IS DISTINCT FROM v_task."description" THEN
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_array(v_task."description", v_desc));
  END IF;
  IF v_changes = '{}'::JSONB THEN
    RETURN;
  END IF;
  UPDATE "tasks" SET "title" = v_title, "description" = v_desc, "due_on" = p_due_on, "due_time" = p_due_time, "priority" = COALESCE(p_priority, 'NORMAL'),
         "proof_kinds" = p_proof, "outlet_id" = p_outlet, "owner_employee_id" = p_owner, "updated_at" = clock_timestamp()
  WHERE "id" = v_task."id";
  -- A changed due date or a new owner is reminded again.
  IF v_changes ? 'due' OR v_changes ? 'owner_employee_id' THEN
    DELETE FROM "task_reminders" WHERE "task_id" = v_task."id";
  END IF;
  IF v_changes ? 'owner_employee_id' THEN
    PERFORM "task_event"(v_task, 'REASSIGNED', v_task."status", v_task."status", v_reason, v_changes);
    SELECT o."name" INTO v_outlet FROM "outlets" o WHERE o."id" = p_outlet;
    PERFORM "task_notify"(v_org, "task_owner_login"(v_org, p_owner), 'TASK_ASSIGNED', v_task."id", 'New task: ' || v_title,
                          'Due ' || to_char(p_due_on, 'DD Mon YYYY') || ' at ' || v_outlet || '.');
  ELSE
    PERFORM "task_event"(v_task, 'EDITED', v_task."status", v_task."status", v_reason, v_changes);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The owner starts work, or starts again after changes were requested.
CREATE FUNCTION "app_start_task"(p_task UUID) RETURNS void AS $$
DECLARE
  v_task "tasks" := "task_lock"(p_task);
BEGIN
  PERFORM "task_require_owner"(v_task);
  IF v_task."status" NOT IN ('ASSIGNED', 'CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'task_bad_transition' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "task_active_employee"(v_task."organization_id", v_task."owner_employee_id");
  UPDATE "tasks" SET "status" = 'IN_PROGRESS', "updated_at" = clock_timestamp() WHERE "id" = v_task."id";
  PERFORM "task_event"(v_task, 'STARTED', v_task."status", 'IN_PROGRESS', NULL, NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- A note on an open task, by the owner or by HR (task_lock already limits it to them); the actor is recorded.
CREATE FUNCTION "app_add_task_note"(p_task UUID, p_note TEXT) RETURNS void AS $$
DECLARE
  v_task "tasks" := "task_lock"(p_task);
  v_note TEXT := "task_text"(p_note, 1000, 'note_required');
BEGIN
  IF v_task."status" IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'task_not_open' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "task_event"(v_task, 'NOTE', v_task."status", v_task."status", v_note, NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The owner submits proof: text and the files already stored by the app (tasks/ keys).
-- Every required proof kind must be present: PHOTO = at least one image, DOCUMENT = at least one PDF, TEXT = text.
CREATE FUNCTION "app_submit_task"(p_task UUID, p_text TEXT, p_evidence JSONB) RETURNS UUID AS $$
DECLARE
  v_task "tasks" := "task_lock"(p_task);
  v_text TEXT := "task_text"(p_text, 4000, NULL);
  v_files JSONB := COALESCE(p_evidence, '[]'::JSONB);
  v_sub UUID;
  v_title TEXT;
  r JSONB;
  u UUID;
BEGIN
  PERFORM "task_require_owner"(v_task);
  IF v_task."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'task_bad_transition' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "task_active_employee"(v_task."organization_id", v_task."owner_employee_id");
  IF jsonb_typeof(v_files) <> 'array' THEN
    RAISE EXCEPTION 'task_bad_file' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(v_files) > 5 THEN
    RAISE EXCEPTION 'task_too_many_files' USING ERRCODE = 'P0001';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(v_files) LOOP
    IF jsonb_typeof(r) <> 'object' OR COALESCE(r->>'size_bytes', '') !~ '^[0-9]{1,9}$'
       OR NOT "task_file_ok"(r->>'storage_key', r->>'mime_type', (r->>'size_bytes')::BIGINT, r->>'sha256', r->>'original_name') THEN
      RAISE EXCEPTION 'task_bad_file' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF ('PHOTO' = ANY (v_task."proof_kinds") AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_files) f WHERE f->>'mime_type' LIKE 'image/%'))
     OR ('DOCUMENT' = ANY (v_task."proof_kinds") AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_files) f WHERE f->>'mime_type' = 'application/pdf'))
     OR ('TEXT' = ANY (v_task."proof_kinds") AND v_text IS NULL) THEN
    RAISE EXCEPTION 'task_proof_missing' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "task_submissions" ("organization_id", "task_id", "number", "text", "submitted_by_id")
  VALUES (v_task."organization_id", v_task."id",
          COALESCE((SELECT max(s."number") FROM "task_submissions" s WHERE s."task_id" = v_task."id"), 0) + 1, v_text, "app_user_id"())
  RETURNING "id" INTO v_sub;
  INSERT INTO "task_evidence" ("organization_id", "task_id", "submission_id", "storage_key", "original_name", "mime_type", "size_bytes", "sha256")
  SELECT v_task."organization_id", v_task."id", v_sub, f->>'storage_key', btrim(f->>'original_name'), f->>'mime_type', (f->>'size_bytes')::INTEGER, f->>'sha256'
  FROM jsonb_array_elements(v_files) f;
  UPDATE "tasks" SET "status" = 'SUBMITTED', "submitted_at" = clock_timestamp(), "updated_at" = clock_timestamp() WHERE "id" = v_task."id";
  PERFORM "task_event"(v_task, 'SUBMITTED', 'IN_PROGRESS', 'SUBMITTED', NULL, NULL);
  SELECT e."full_name" || ' (' || e."employee_code" || ')' INTO v_title FROM "employees" e WHERE e."id" = v_task."owner_employee_id";
  FOR u IN SELECT * FROM "task_reviewers"(v_task."organization_id", "app_user_id"()) LOOP
    PERFORM "task_notify"(v_task."organization_id", u, 'TASK_SUBMITTED', v_task."id", 'Task submitted for review: ' || v_task."title", 'From ' || v_title || '.');
  END LOOP;
  RETURN v_sub;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR reviews a submitted task: approve (passed the check) with a rating of 1-5 and an optional comment, or request
-- changes with a note (no rating).
CREATE FUNCTION "app_review_task"(p_task UUID, p_approve BOOLEAN, p_rating SMALLINT, p_note TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_task "tasks" := "task_lock"(p_task);
  v_self BOOLEAN;
  v_note TEXT := "task_text"(p_note, 1000, NULL);
  v_owner UUID;
BEGIN
  IF v_task."status" <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'task_bad_transition' USING ERRCODE = 'P0001';
  END IF;
  v_self := "task_check_four_eyes"(v_task);
  v_owner := "task_owner_login"(v_org, v_task."owner_employee_id");
  IF COALESCE(p_approve, false) THEN
    IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'rating_required' USING ERRCODE = 'P0001';
    END IF;
    UPDATE "tasks" SET "status" = 'APPROVED', "rating" = p_rating, "rating_comment" = v_note, "decided_at" = clock_timestamp(), "decided_by_id" = "app_user_id"(),
           "decision_note" = NULL, "self_reviewed" = v_self, "final_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = v_task."id";
    PERFORM "task_event"(v_task, 'APPROVED', 'SUBMITTED', 'APPROVED', v_note, jsonb_build_object('rating', p_rating));
    PERFORM "task_notify"(v_org, v_owner, 'TASK_APPROVED', v_task."id", 'Task approved: ' || v_task."title", 'Rated ' || p_rating || ' out of 5.');
  ELSE
    IF p_rating IS NOT NULL THEN
      RAISE EXCEPTION 'rating_not_allowed' USING ERRCODE = 'P0001';
    END IF;
    IF v_note IS NULL THEN
      RAISE EXCEPTION 'note_required' USING ERRCODE = 'P0001';
    END IF;
    UPDATE "tasks" SET "status" = 'CHANGES_REQUESTED', "decision_note" = v_note, "decided_at" = clock_timestamp(), "decided_by_id" = "app_user_id"(),
           "self_reviewed" = v_self, "updated_at" = clock_timestamp()
    WHERE "id" = v_task."id";
    PERFORM "task_event"(v_task, 'CHANGES_REQUESTED', 'SUBMITTED', 'CHANGES_REQUESTED', v_note, NULL);
    PERFORM "task_notify"(v_org, v_owner, 'TASK_CHANGES_REQUESTED', v_task."id", 'Changes requested: ' || v_task."title", v_note);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR cancels an open task, with a reason.
CREATE FUNCTION "app_cancel_task"(p_task UUID, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_task "tasks" := "task_lock"(p_task);
  v_reason TEXT := "task_text"(p_reason, 500, 'reason_required');
BEGIN
  IF v_task."status" IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'task_not_open' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "tasks" SET "status" = 'CANCELLED', "cancelled_at" = clock_timestamp(), "cancelled_by_id" = "app_user_id"(), "cancel_reason" = v_reason,
         "final_at" = clock_timestamp(), "updated_at" = clock_timestamp()
  WHERE "id" = v_task."id";
  PERFORM "task_event"(v_task, 'CANCELLED', v_task."status", 'CANCELLED', v_reason, NULL);
  PERFORM "task_notify"(v_org, "task_owner_login"(v_org, v_task."owner_employee_id"), 'TASK_CANCELLED', v_task."id", 'Task cancelled: ' || v_task."title", v_reason);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR attaches a reference for the owner: a file already stored by the app (tasks/ key) or an https link.
CREATE FUNCTION "app_add_task_resource"(p_task UUID, p_kind TEXT, p_storage_key TEXT, p_url TEXT, p_name TEXT, p_mime TEXT, p_size INTEGER, p_sha256 TEXT)
RETURNS UUID AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_task "tasks" := "task_lock"(p_task);
  v_name TEXT;
  v_id UUID;
BEGIN
  IF v_task."status" IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'task_not_open' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind = 'LINK' THEN
    IF p_url IS NULL OR p_url !~ '^https://[^[:space:]]+$' OR char_length(p_url) > 500 THEN
      RAISE EXCEPTION 'bad_link' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM "task_resources" x WHERE x."task_id" = v_task."id" AND x."kind" = 'LINK' AND x."removed_at" IS NULL) >= 10 THEN
      RAISE EXCEPTION 'too_many_resources' USING ERRCODE = 'P0001';
    END IF;
    v_name := COALESCE("task_text"(p_name, 200, NULL), left(p_url, 200));
    INSERT INTO "task_resources" ("organization_id", "task_id", "kind", "url", "original_name", "added_by_id")
    VALUES (v_org, v_task."id", 'LINK', p_url, v_name, "app_user_id"()) RETURNING "id" INTO v_id;
  ELSIF p_kind = 'FILE' THEN
    IF NOT "task_file_ok"(p_storage_key, p_mime, p_size, p_sha256, p_name) THEN
      RAISE EXCEPTION 'task_bad_file' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM "task_resources" x WHERE x."task_id" = v_task."id" AND x."kind" = 'FILE' AND x."removed_at" IS NULL) >= 5 THEN
      RAISE EXCEPTION 'too_many_resources' USING ERRCODE = 'P0001';
    END IF;
    v_name := btrim(p_name);
    INSERT INTO "task_resources" ("organization_id", "task_id", "kind", "storage_key", "original_name", "mime_type", "size_bytes", "sha256", "added_by_id")
    VALUES (v_org, v_task."id", 'FILE', p_storage_key, v_name, p_mime, p_size, p_sha256, "app_user_id"()) RETURNING "id" INTO v_id;
  ELSE
    RAISE EXCEPTION 'task_bad_file' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "task_event"(v_task, 'RESOURCE_ADDED', v_task."status", v_task."status", NULL, jsonb_build_object('resource', v_name, 'kind', p_kind));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "app_remove_task_resource"(p_resource UUID) RETURNS void AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_res "task_resources";
  v_task "tasks";
BEGIN
  SELECT x.* INTO v_res FROM "task_resources" x WHERE x."id" = p_resource AND x."organization_id" = v_org AND x."removed_at" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_task := "task_lock"(v_res."task_id");
  -- Someone may have removed it while we waited for the task lock.
  UPDATE "task_resources" SET "removed_at" = clock_timestamp(), "removed_by_id" = "app_user_id"() WHERE "id" = v_res."id" AND "removed_at" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "task_event"(v_task, 'RESOURCE_REMOVED', v_task."status", v_task."status", NULL, jsonb_build_object('resource', v_res."original_name", 'kind', v_res."kind"));
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. The daily job (maintenance mode)
-- ---------------------------------------------------------------------------
-- Reminders: to the owner of an open task (not waiting for HR) once on the due date and once the day after; never more
-- (one row per task and kind). Returns how many were sent. Nothing is deleted here: evidence retention is a proposed
-- setting, not built until the owner approves a period. p_today (tests) may move at most one day ahead of the real date.
CREATE FUNCTION "app_task_housekeeping"(p_today DATE DEFAULT NULL) RETURNS INTEGER AS $$
DECLARE
  o RECORD;
  t RECORD;
  v_today DATE;
  v_n INTEGER := 0;
  v_rows INTEGER;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR (p_today IS NOT NULL AND p_today > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR o IN SELECT org."id", org."timezone" FROM "organizations" org
           WHERE org."status" = 'ACTIVE' AND (EXISTS (SELECT 1 FROM "time_zone_names" z WHERE z."name" = org."timezone")
                                           OR EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = org."timezone")) LOOP
    v_today := COALESCE(p_today, (clock_timestamp() AT TIME ZONE o."timezone")::date);
    FOR t IN SELECT tk."id", tk."title", tk."due_on", tk."owner_employee_id",
                    CASE WHEN tk."due_on" = v_today THEN 'DUE' ELSE 'DUE_AFTER' END::"TaskReminderKind" AS kind
             FROM "tasks" tk JOIN "employees" e ON e."id" = tk."owner_employee_id" AND e."status" = 'ACTIVE'
             WHERE tk."organization_id" = o."id" AND tk."status" IN ('ASSIGNED', 'IN_PROGRESS', 'CHANGES_REQUESTED')
               AND tk."due_on" IN (v_today, v_today - 1)
               -- Only owners who can receive it: the reminder is kept for later if the login is inactive today.
               AND "task_owner_login"(o."id", tk."owner_employee_id") IS NOT NULL LOOP
      INSERT INTO "task_reminders" ("organization_id", "task_id", "kind", "sent_on") VALUES (o."id", t."id", t.kind, v_today)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN
        PERFORM "task_notify"(o."id", "task_owner_login"(o."id", t."owner_employee_id"), 'TASK_DUE', t."id",
                              CASE WHEN t.kind = 'DUE' THEN 'Task due today: ' ELSE 'Task overdue: ' END || t."title",
                              'It was due ' || to_char(t."due_on", 'DD Mon YYYY') || '.');
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. Rights
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "task_require"(TEXT), "task_lock"(UUID), "task_require_owner"("tasks"), "task_active_employee"(UUID, UUID), "task_active_outlet"(UUID, UUID),
  "task_text"(TEXT, INTEGER, TEXT), "task_today"(UUID), "task_owner_login"(UUID, UUID), "task_owner_with_login"(UUID, UUID), "task_reviewers"(UUID, UUID),
  "task_notify"(UUID, UUID, "NotificationType", UUID, TEXT, TEXT), "task_event"("tasks", "TaskEventKind", "TaskStatus", "TaskStatus", TEXT, JSONB),
  "task_file_ok"(TEXT, TEXT, BIGINT, TEXT, TEXT), "task_check_four_eyes"("tasks"),
  "app_assign_task"(UUID, UUID, TEXT, TEXT, DATE, TIME, "TaskPriority", "TaskProofKind"[]),
  "app_edit_task"(UUID, TEXT, TEXT, DATE, TIME, "TaskPriority", "TaskProofKind"[], UUID, UUID, TEXT),
  "app_start_task"(UUID), "app_add_task_note"(UUID, TEXT), "app_submit_task"(UUID, TEXT, JSONB), "app_review_task"(UUID, BOOLEAN, SMALLINT, TEXT),
  "app_cancel_task"(UUID, TEXT), "app_add_task_resource"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT), "app_remove_task_resource"(UUID),
  "app_task_housekeeping"(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_assign_task"(UUID, UUID, TEXT, TEXT, DATE, TIME, "TaskPriority", "TaskProofKind"[]),
  "app_edit_task"(UUID, TEXT, TEXT, DATE, TIME, "TaskPriority", "TaskProofKind"[], UUID, UUID, TEXT),
  "app_start_task"(UUID), "app_add_task_note"(UUID, TEXT), "app_submit_task"(UUID, TEXT, JSONB), "app_review_task"(UUID, BOOLEAN, SMALLINT, TEXT),
  "app_cancel_task"(UUID, TEXT), "app_add_task_resource"(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT), "app_remove_task_resource"(UUID),
  "app_task_housekeeping"(DATE) TO hr_runtime;
-- NOT granted: the task_* helpers (several take an organisation or employee id and trust it).

COMMIT;
