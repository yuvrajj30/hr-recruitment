-- Leave polish (owner approval, 23 Nov 2026).
-- 1. A holiday or weekly off inside approved leave is not a day "on leave": it is never charged, so its shift is not
--    cancelled for leave, the standard rota does not skip it and clock-in is not refused for leave. A day counts as on
--    leave when the approval charged it in full (leave_request_days); leave approved before those charges existed falls
--    back to today's rule (holidays and weekly offs do not count).
-- 2. Cancelling approved leave brings the standard shifts it cancelled back at once, instead of at the next daily job.
--    Hand-planned or changed shifts still do not come back by themselves (HR plans them again).
BEGIN;

CREATE OR REPLACE FUNCTION "leave_on_full_leave"(p_employee UUID, p_day DATE) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM "leave_requests" q
    WHERE q."employee_id" = p_employee AND q."status" = 'APPROVED' AND p_day BETWEEN q."start_day" AND q."end_day"
      AND NOT (p_day = q."start_day" AND q."start_half") AND NOT (p_day = q."end_day" AND q."end_half")
      AND CASE WHEN EXISTS (SELECT 1 FROM "leave_request_days" r WHERE r."request_id" = q."id")
               THEN EXISTS (SELECT 1 FROM "leave_request_days" r WHERE r."request_id" = q."id" AND r."day" = p_day AND r."weight" = 1.0)
               ELSE EXISTS (SELECT 1 FROM "leave_day_weights"(q."organization_id", q."employee_id", p_day, p_day, false, false))
          END);
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Fills the organisation's standard rota now, as the HR button and the daily job do (the sync refuses a signed-in
-- session, so the token is set aside for the call and put back).
CREATE FUNCTION "leave_refill_standard_shifts"(p_org UUID) RETURNS INTEGER AS $$
DECLARE
  v_token TEXT := current_setting('app.session_token', true);
  v_n INTEGER;
BEGIN
  PERFORM set_config('app.session_token', '', true);
  v_n := "att_sync_standard_shifts"(p_org, 14);
  PERFORM set_config('app.session_token', COALESCE(v_token, ''), true);
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- As in 20261123000300_leave_review_fixes, plus the refill at the end.
CREATE OR REPLACE FUNCTION "app_cancel_leave"(p_request UUID, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_hr BOOLEAN := "app_staff_role"() IS NOT NULL AND "app_has_permission"('leave:approve');
  v_org UUID;
  v_employee UUID;
  v_emp "employees";
  v_req "leave_requests";
  v_today DATE;
  v_past NUMERIC := 0;
  v_back NUMERIC;
BEGIN
  IF NOT v_hr THEN
    v_org := "leave_require"('self:leave_apply');
  ELSE
    v_org := "app_org_id"();
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT q."employee_id" INTO v_employee FROM "leave_requests" q
  WHERE q."id" = p_request AND q."organization_id" = v_org AND (v_hr OR q."employee_id" = "app_my_employee_id"());
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_emp := "leave_lock_employee"(v_org, v_employee);
  SELECT q.* INTO v_req FROM "leave_requests" q WHERE q."id" = p_request FOR UPDATE;
  IF v_req."status" <> 'APPROVED' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'P0001';
  END IF;
  v_today := (clock_timestamp() AT TIME ZONE "att_org_timezone"(v_org))::date;
  IF NOT v_hr AND v_today >= v_req."start_day" THEN
    RAISE EXCEPTION 'leave_already_started' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM "leave_request_days" r WHERE r."request_id" = v_req."id") THEN
    -- The charge recorded at approval for today and later: later holiday or standard changes cannot move it.
    v_back := COALESCE((SELECT sum(r."weight") FROM "leave_request_days" r WHERE r."request_id" = v_req."id" AND r."day" >= v_today), 0);
  ELSE
    -- Approved before the per-day charges existed: recount the days already passed.
    IF v_today > v_req."start_day" THEN
      v_past := "leave_count_days"(v_org, v_emp."id", v_req."start_day", LEAST(v_today - 1, v_req."end_day"), v_req."start_half",
                                   v_req."end_day" <= v_today - 1 AND v_req."end_half");
    END IF;
    v_back := GREATEST(v_req."days" - v_past, 0);
  END IF;
  v_back := LEAST(v_back, v_req."days");
  UPDATE "leave_requests" SET "status" = 'CANCELLED', "cancelled_by_id" = "app_user_id"(), "cancelled_at" = clock_timestamp(),
         "cancel_reason" = v_reason, "updated_at" = clock_timestamp()
  WHERE "id" = v_req."id";
  IF v_back > 0 THEN
    INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "request_id", "reason", "created_by_id")
    VALUES (v_org, v_emp."id", v_req."leave_type_id", extract(year FROM v_req."start_day")::INTEGER, 'RESTORED', v_back, v_req."id", v_reason, "app_user_id"());
  END IF;
  -- The standard shifts this leave cancelled come back now (only days still to come within the rota's 14 days).
  IF v_req."end_day" >= v_today THEN
    PERFORM "leave_refill_standard_shifts"(v_org);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

REVOKE ALL ON FUNCTION "leave_refill_standard_shifts"(UUID) FROM PUBLIC;

COMMIT;
