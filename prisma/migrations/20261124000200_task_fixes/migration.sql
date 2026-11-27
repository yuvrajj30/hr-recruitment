-- Tasks: two fixes found by the tests right after 20261124000000_tasks and 20261124000100_task_functions were applied to
-- the TEST database (never released).
-- 1. The history guard read NEW."actor_id" directly; PL/pgSQL resolves that field at run time even when the table has no
--    such column, so every update of task_resources (removing a resource) failed. It now compares JSON copies of the rows.
-- 2. Moving a task to a new owner kept IN_PROGRESS / CHANGES_REQUESTED, so the new owner could not start it. A moved task
--    now goes back to ASSIGNED (the history records the old and new status and owner).
BEGIN;

CREATE OR REPLACE FUNCTION "block_task_history_updates"() RETURNS trigger AS $$
DECLARE
  v_new JSONB := to_jsonb(NEW);
  v_old JSONB := to_jsonb(OLD);
  -- Columns that may change: user references cleared by ON DELETE SET NULL, and a resource's removal (set once).
  v_free TEXT[] := CASE TG_TABLE_NAME
    WHEN 'task_events' THEN ARRAY['actor_id']
    WHEN 'task_submissions' THEN ARRAY['submitted_by_id']
    WHEN 'task_resources' THEN ARRAY['removed_at', 'removed_by_id', 'added_by_id']
    ELSE ARRAY[]::TEXT[] END;
  c TEXT;
BEGIN
  IF (v_new - v_free) IS DISTINCT FROM (v_old - v_free) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  -- A user reference may only be cleared (set to NULL), never pointed at someone else.
  FOREACH c IN ARRAY ARRAY['actor_id', 'submitted_by_id', 'added_by_id'] LOOP
    IF c = ANY (v_free) AND v_new->>c IS NOT NULL AND v_new->>c IS DISTINCT FROM v_old->>c THEN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  -- A resource is removed once: removed_at and removed_by_id are set from NULL, and never changed again (only
  -- removed_by_id may later be cleared when that user is deleted).
  IF TG_TABLE_NAME = 'task_resources' AND (
       (v_old->>'removed_at' IS NOT NULL AND v_new->>'removed_at' IS DISTINCT FROM v_old->>'removed_at')
    OR (v_old->>'removed_by_id' IS NOT NULL AND v_new->>'removed_by_id' IS NOT NULL AND v_new->>'removed_by_id' IS DISTINCT FROM v_old->>'removed_by_id')) THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "app_edit_task"(p_task UUID, p_title TEXT, p_description TEXT, p_due_on DATE, p_due_time TIME, p_priority "TaskPriority",
                                p_proof "TaskProofKind"[], p_outlet UUID, p_owner UUID, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "task_require"('task:manage');
  v_task "tasks" := "task_lock"(p_task);
  v_title TEXT := "task_text"(p_title, 120, 'text_required');
  v_desc TEXT := "task_text"(p_description, 2000, 'text_required');
  v_reason TEXT := "task_text"(p_reason, 1000, NULL);
  v_changes JSONB := '{}'::JSONB;
  v_outlet TEXT;
  v_new_status "TaskStatus";
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
  -- A new owner starts the task themselves: a moved task goes back to ASSIGNED.
  v_new_status := CASE WHEN v_changes ? 'owner_employee_id' THEN 'ASSIGNED'::"TaskStatus" ELSE v_task."status" END;
  UPDATE "tasks" SET "title" = v_title, "description" = v_desc, "due_on" = p_due_on, "due_time" = p_due_time, "priority" = COALESCE(p_priority, 'NORMAL'),
         "proof_kinds" = p_proof, "outlet_id" = p_outlet, "owner_employee_id" = p_owner, "status" = v_new_status, "updated_at" = clock_timestamp()
  WHERE "id" = v_task."id";
  -- A changed due date or a new owner is reminded again.
  IF v_changes ? 'due' OR v_changes ? 'owner_employee_id' THEN
    DELETE FROM "task_reminders" WHERE "task_id" = v_task."id";
  END IF;
  IF v_changes ? 'owner_employee_id' THEN
    PERFORM "task_event"(v_task, 'REASSIGNED', v_task."status", v_new_status, v_reason, v_changes);
    SELECT o."name" INTO v_outlet FROM "outlets" o WHERE o."id" = p_outlet;
    PERFORM "task_notify"(v_org, "task_owner_login"(v_org, p_owner), 'TASK_ASSIGNED', v_task."id", 'New task: ' || v_title,
                          'Due ' || to_char(p_due_on, 'DD Mon YYYY') || ' at ' || v_outlet || '.');
  ELSE
    PERFORM "task_event"(v_task, 'EDITED', v_task."status", v_task."status", v_reason, v_changes);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

COMMIT;
