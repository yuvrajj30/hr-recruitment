-- Leave, part 2 of 2: the functions that count leave days and write requests and the balance ledger, the daily
-- grants / accrual / year close, and the link to attendance and the rota.
-- Design: docs/superpowers/specs/2026-11-21-leave-design.md. Every entry function finds out who is asking from the
-- session, checks the permission key in SQL, resolves every id within the caller's organisation (a missing and a
-- foreign id give the same 'not_found'), and locks in one order: the employee row (FOR SHARE), then a per-employee
-- advisory lock, then the rows. The app account cannot write the ledger or the requests itself.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Helpers (internal: not callable by the app account)
-- ---------------------------------------------------------------------------
-- Working days of a period for one employee: holidays (organisation-wide or at their home outlet) and their weekly
-- off days (days missing from their standard; none without a standard) do not count. A half day at either end
-- counts 0.5; on a one-day period either half flag means 0.5.
CREATE FUNCTION "leave_count_days"(p_org UUID, p_employee UUID, p_start DATE, p_end DATE, p_start_half BOOLEAN, p_end_half BOOLEAN)
RETURNS NUMERIC AS $$
  SELECT COALESCE(sum(CASE WHEN (x.d = p_start AND p_start_half) OR (x.d = p_end AND p_end_half) THEN 0.5 ELSE 1 END), 0)::NUMERIC(5,1)
  FROM generate_series(p_start::timestamp, p_end::timestamp, INTERVAL '1 day') AS g(t)
  CROSS JOIN LATERAL (SELECT g.t::date AS d) AS x
  WHERE NOT EXISTS (
          SELECT 1 FROM "holidays" h
          WHERE h."organization_id" = p_org AND h."day" = x.d
            AND (h."outlet_id" IS NULL OR h."outlet_id" = (SELECT e."outlet_id" FROM "employees" e WHERE e."id" = p_employee AND e."organization_id" = p_org)))
    AND COALESCE(extract(isodow FROM x.d)::SMALLINT = ANY (
          (SELECT p."work_days" FROM "employee_shift_patterns" p WHERE p."employee_id" = p_employee AND p."organization_id" = p_org)::SMALLINT[]), true);
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- The ledger balance of one employee, type and year.
CREATE FUNCTION "leave_balance"(p_employee UUID, p_type UUID, p_year INTEGER) RETURNS NUMERIC AS $$
  SELECT COALESCE(sum(l."days"), 0)::NUMERIC(6,1) FROM "leave_ledger" l
  WHERE l."employee_id" = p_employee AND l."leave_type_id" = p_type AND l."year" = p_year;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Available = the balance minus the days of that person's other PENDING requests of the type in that year.
CREATE FUNCTION "leave_available"(p_employee UUID, p_type UUID, p_year INTEGER, p_except UUID) RETURNS NUMERIC AS $$
  SELECT "leave_balance"(p_employee, p_type, p_year) - COALESCE((
    SELECT sum(q."days") FROM "leave_requests" q
    WHERE q."employee_id" = p_employee AND q."leave_type_id" = p_type AND q."status" = 'PENDING'
      AND extract(year FROM q."start_day") = p_year AND q."id" IS DISTINCT FROM p_except), 0);
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- On approved leave for the whole of that day (not a half day at either end).
CREATE FUNCTION "leave_on_full_leave"(p_employee UUID, p_day DATE) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM "leave_requests" q
    WHERE q."employee_id" = p_employee AND q."status" = 'APPROVED' AND p_day BETWEEN q."start_day" AND q."end_day"
      AND NOT (p_day = q."start_day" AND q."start_half") AND NOT (p_day = q."end_day" AND q."end_half"));
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- The employee row (share-locked: marking someone as left waits) and then the per-employee leave lock.
CREATE FUNCTION "leave_lock_employee"(p_org UUID, p_employee UUID) RETURNS "employees" AS $$
DECLARE
  v_emp "employees";
BEGIN
  SELECT e.* INTO v_emp FROM "employees" e WHERE e."id" = p_employee AND e."organization_id" = p_org FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('leave:' || p_org::TEXT || ':' || p_employee::TEXT, 0));
  RETURN v_emp;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- The caller holds this permission (an active member of an active organisation); returns their organisation.
CREATE FUNCTION "leave_require"(p_permission TEXT) RETURNS UUID AS $$
BEGIN
  IF "app_staff_role"() IS NULL OR NOT "app_has_permission"(p_permission) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN "app_org_id"();
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- The signed-in employee's own record (locked), for self-service.
CREATE FUNCTION "leave_me"() RETURNS "employees" AS $$
DECLARE
  v_org UUID := "leave_require"('self:leave_apply');
  v_id UUID := "app_my_employee_id"();
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no_employee_record' USING ERRCODE = 'P0001';
  END IF;
  RETURN "leave_lock_employee"(v_org, v_id);
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "leave_type_of"(p_org UUID, p_type UUID) RETURNS "leave_types" AS $$
DECLARE
  v_type "leave_types";
BEGIN
  SELECT t.* INTO v_type FROM "leave_types" t WHERE t."id" = p_type AND t."organization_id" = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_type;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Checks a request's type, dates and note, and returns its working-day count (never 0).
CREATE FUNCTION "leave_check_request"(p_emp "employees", p_type "leave_types", p_start DATE, p_end DATE, p_start_half BOOLEAN,
                                      p_end_half BOOLEAN, p_note TEXT) RETURNS NUMERIC AS $$
DECLARE
  v_today DATE := (clock_timestamp() AT TIME ZONE "att_org_timezone"(p_emp."organization_id"))::date;
  v_days NUMERIC;
BEGIN
  IF NOT p_type."is_active" THEN
    RAISE EXCEPTION 'leave_type_inactive' USING ERRCODE = 'P0001';
  END IF;
  IF NOT p_type."configured" THEN
    RAISE EXCEPTION 'leave_type_not_configured' USING ERRCODE = 'P0001';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'leave_bad_period' USING ERRCODE = 'P0001';
  END IF;
  IF extract(year FROM p_start) <> extract(year FROM p_end) THEN
    RAISE EXCEPTION 'leave_crosses_year' USING ERRCODE = 'P0001';
  END IF;
  IF p_start < v_today - 31 THEN
    RAISE EXCEPTION 'leave_too_far_back' USING ERRCODE = 'P0001';
  END IF;
  IF p_end > v_today + 365 THEN
    RAISE EXCEPTION 'leave_too_far_ahead' USING ERRCODE = 'P0001';
  END IF;
  IF p_start < p_emp."joined_on" OR (p_emp."status" = 'EXITED' AND (p_emp."exited_on" IS NULL OR p_end > p_emp."exited_on")) THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF p_type."note_required" AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'leave_note_required' USING ERRCODE = 'P0001';
  END IF;
  v_days := "leave_count_days"(p_emp."organization_id", p_emp."id", p_start, p_end, COALESCE(p_start_half, false), COALESCE(p_end_half, false));
  IF v_days <= 0 THEN
    RAISE EXCEPTION 'leave_zero_days' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_days;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Someone else in the organisation (an active member with an active account) can approve leave.
CREATE FUNCTION "leave_other_approver_exists"(p_org UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "users" u ON u."id" = om."user_id"
    JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
    JOIN "role_permissions" rp ON rp."role_id" = omr."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id" AND p."key" = 'leave:approve'
    WHERE om."organization_id" = p_org AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND om."user_id" <> "app_user_id"());
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Planned shifts on full leave days that have not started are cancelled ("On leave"), as a system change (no person
-- signed in for that moment), so the standard rota refills standard days if the leave is cancelled later.
CREATE FUNCTION "leave_cancel_shifts"(p_request UUID) RETURNS INTEGER AS $$
DECLARE
  v_req "leave_requests";
  v_tz TEXT;
  v_token TEXT := current_setting('app.session_token', true);
  v_n INTEGER;
BEGIN
  SELECT q.* INTO v_req FROM "leave_requests" q WHERE q."id" = p_request;
  v_tz := "att_org_timezone"(v_req."organization_id");
  PERFORM set_config('app.session_token', '', true);
  UPDATE "shifts" s SET "status" = 'CANCELLED', "cancel_reason" = 'On leave'
  WHERE s."employee_id" = v_req."employee_id" AND s."organization_id" = v_req."organization_id" AND s."status" = 'PLANNED'
    AND s."starts_at" > clock_timestamp()
    AND "leave_on_full_leave"(v_req."employee_id", COALESCE(s."standard_day", (s."starts_at" AT TIME ZONE v_tz)::date))
    AND COALESCE(s."standard_day", (s."starts_at" AT TIME ZONE v_tz)::date) BETWEEN v_req."start_day" AND v_req."end_day";
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.session_token', COALESCE(v_token, ''), true);
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Approves a pending request (locked by the caller): recounts its days with today's holidays and standard (final),
-- checks the balance again, writes TAKEN once, and clears that person's rota on full leave days.
CREATE FUNCTION "leave_approve"(p_req "leave_requests", p_emp "employees", p_self BOOLEAN) RETURNS void AS $$
DECLARE
  v_type "leave_types" := "leave_type_of"(p_req."organization_id", p_req."leave_type_id");
  v_days NUMERIC := "leave_count_days"(p_req."organization_id", p_emp."id", p_req."start_day", p_req."end_day", p_req."start_half", p_req."end_half");
  v_year INTEGER := extract(year FROM p_req."start_day")::INTEGER;
BEGIN
  IF v_days <= 0 THEN
    RAISE EXCEPTION 'leave_zero_days' USING ERRCODE = 'P0001';
  END IF;
  IF v_type."paid" AND v_days > "leave_balance"(p_emp."id", v_type."id", v_year) THEN
    RAISE EXCEPTION 'leave_insufficient_balance' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "leave_requests" SET "status" = 'APPROVED', "days" = v_days, "decided_by_id" = "app_user_id"(), "decided_at" = clock_timestamp(),
         "self_decided" = p_self, "updated_at" = clock_timestamp()
  WHERE "id" = p_req."id";
  INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "request_id", "created_by_id")
  VALUES (p_req."organization_id", p_emp."id", v_type."id", v_year, 'TAKEN', -v_days, p_req."id", "app_user_id"());
  PERFORM "leave_cancel_shifts"(p_req."id");
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. Entry points for the app
-- ---------------------------------------------------------------------------
-- An employee asks for leave for themselves. Returns the request's id.
CREATE FUNCTION "app_request_leave"(p_type UUID, p_start DATE, p_end DATE, p_start_half BOOLEAN, p_end_half BOOLEAN, p_note TEXT) RETURNS UUID AS $$
DECLARE
  v_emp "employees" := "leave_me"();
  v_type "leave_types" := "leave_type_of"(v_emp."organization_id", p_type);
  v_days NUMERIC;
  v_id UUID;
BEGIN
  IF v_emp."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  v_days := "leave_check_request"(v_emp, v_type, p_start, p_end, p_start_half, p_end_half, p_note);
  IF v_type."paid" AND v_days > "leave_available"(v_emp."id", v_type."id", extract(year FROM p_start)::INTEGER, NULL) THEN
    RAISE EXCEPTION 'leave_insufficient_balance' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    INSERT INTO "leave_requests" ("organization_id", "employee_id", "leave_type_id", "start_day", "end_day", "start_half", "end_half", "days", "note", "requested_by_id")
    VALUES (v_emp."organization_id", v_emp."id", v_type."id", p_start, p_end, COALESCE(p_start_half, false), COALESCE(p_end_half, false), v_days,
            NULLIF(btrim(COALESCE(p_note, '')), ''), "app_user_id"())
    RETURNING "id" INTO v_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'leave_overlap' USING ERRCODE = 'P0001';
  END;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The employee takes back their own pending request.
CREATE FUNCTION "app_withdraw_leave"(p_request UUID) RETURNS void AS $$
DECLARE
  v_emp "employees" := "leave_me"();
  v_status "LeaveRequestStatus";
BEGIN
  SELECT q."status" INTO v_status FROM "leave_requests" q
  WHERE q."id" = p_request AND q."organization_id" = v_emp."organization_id" AND q."employee_id" = v_emp."id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_status <> 'PENDING' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'P0001';
  END IF;
  UPDATE "leave_requests" SET "status" = 'WITHDRAWN', "updated_at" = clock_timestamp() WHERE "id" = p_request;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR approves or rejects (a note is required to reject). Nobody decides their own request unless nobody else can.
CREATE FUNCTION "app_decide_leave"(p_request UUID, p_approve BOOLEAN, p_note TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "leave_require"('leave:approve');
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_employee UUID;
  v_emp "employees";
  v_req "leave_requests";
  v_self BOOLEAN;
BEGIN
  IF p_approve IS NULL OR (NOT p_approve AND v_note IS NULL) THEN
    RAISE EXCEPTION 'decision_note_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT q."employee_id" INTO v_employee FROM "leave_requests" q WHERE q."id" = p_request AND q."organization_id" = v_org;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_emp := "leave_lock_employee"(v_org, v_employee);
  SELECT q.* INTO v_req FROM "leave_requests" q WHERE q."id" = p_request FOR UPDATE;
  IF v_req."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'P0001';
  END IF;
  v_self := COALESCE(v_emp."id" = "app_my_employee_id"(), false);
  IF v_self AND "leave_other_approver_exists"(v_org) THEN
    RAISE EXCEPTION 'own_request' USING ERRCODE = 'P0001';
  END IF;
  IF p_approve THEN
    PERFORM "leave_approve"(v_req, v_emp, v_self);
    IF v_note IS NOT NULL THEN
      UPDATE "leave_requests" SET "decision_note" = left(v_note, 500) WHERE "id" = p_request;
    END IF;
  ELSE
    UPDATE "leave_requests" SET "status" = 'REJECTED', "decision_note" = left(v_note, 500), "decided_by_id" = "app_user_id"(),
           "decided_at" = clock_timestamp(), "self_decided" = v_self, "updated_at" = clock_timestamp()
    WHERE "id" = p_request;
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR records leave for an employee (a paper request, or staff without a login): approved at once. Never for themselves.
CREATE FUNCTION "app_hr_record_leave"(p_employee UUID, p_type UUID, p_start DATE, p_end DATE, p_start_half BOOLEAN, p_end_half BOOLEAN, p_note TEXT) RETURNS UUID AS $$
DECLARE
  v_org UUID := "leave_require"('leave:approve');
  v_emp "employees" := "leave_lock_employee"(v_org, p_employee);
  v_type "leave_types" := "leave_type_of"(v_org, p_type);
  v_days NUMERIC;
  v_req "leave_requests";
BEGIN
  IF v_emp."id" = "app_my_employee_id"() THEN
    RAISE EXCEPTION 'own_request' USING ERRCODE = 'P0001';
  END IF;
  v_days := "leave_check_request"(v_emp, v_type, p_start, p_end, p_start_half, p_end_half, p_note);
  BEGIN
    INSERT INTO "leave_requests" ("organization_id", "employee_id", "leave_type_id", "start_day", "end_day", "start_half", "end_half", "days", "note", "requested_by_id")
    VALUES (v_org, v_emp."id", v_type."id", p_start, p_end, COALESCE(p_start_half, false), COALESCE(p_end_half, false), v_days,
            NULLIF(btrim(COALESCE(p_note, '')), ''), "app_user_id"())
    RETURNING * INTO v_req;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'leave_overlap' USING ERRCODE = 'P0001';
  END;
  PERFORM "leave_approve"(v_req, v_emp, false);
  RETURN v_req."id";
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Cancels approved leave, with a reason. The employee may cancel their own before the first leave day (00:00 in the
-- organisation's time zone); HR at any time. Only the days not yet taken come back (RESTORED).
CREATE FUNCTION "app_cancel_leave"(p_request UUID, p_reason TEXT) RETURNS void AS $$
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
  IF v_today > v_req."start_day" THEN
    v_past := "leave_count_days"(v_org, v_emp."id", v_req."start_day", LEAST(v_today - 1, v_req."end_day"), v_req."start_half",
                                 v_req."end_day" <= v_today - 1 AND v_req."end_half");
  END IF;
  v_back := GREATEST(v_req."days" - v_past, 0);
  UPDATE "leave_requests" SET "status" = 'CANCELLED', "cancelled_by_id" = "app_user_id"(), "cancelled_at" = clock_timestamp(),
         "cancel_reason" = v_reason, "updated_at" = clock_timestamp()
  WHERE "id" = v_req."id";
  IF v_back > 0 THEN
    INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "request_id", "reason", "created_by_id")
    VALUES (v_org, v_emp."id", v_req."leave_type_id", extract(year FROM v_req."start_day")::INTEGER, 'RESTORED', v_back, v_req."id", v_reason, "app_user_id"());
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR adjusts a balance (e.g. a comp-off credit or a correction), with a reason. Never below zero for a paid type.
CREATE FUNCTION "app_adjust_leave"(p_employee UUID, p_type UUID, p_year INTEGER, p_days NUMERIC, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "leave_require"('leave:manage');
  v_emp "employees" := "leave_lock_employee"(v_org, p_employee);
  v_type "leave_types" := "leave_type_of"(v_org, p_type);
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT v_type."paid" THEN
    RAISE EXCEPTION 'leave_type_unpaid' USING ERRCODE = 'P0001';
  END IF;
  IF p_days IS NULL OR p_days = 0 OR p_days * 2 <> trunc(p_days * 2) OR abs(p_days) > 400 OR p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 THEN
    RAISE EXCEPTION 'adjust_bad_days' USING ERRCODE = 'P0001';
  END IF;
  IF "leave_balance"(v_emp."id", v_type."id", p_year) + p_days < 0 THEN
    RAISE EXCEPTION 'adjust_negative_balance' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason", "created_by_id")
  VALUES (v_org, v_emp."id", v_type."id", p_year, 'ADJUSTMENT', p_days, v_reason, "app_user_id"());
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR, before deciding: the request's stored count, its count today (holidays and standard as they are now), the
-- available balance (without this request) and what is left after approving it.
CREATE FUNCTION "app_leave_preview"(p_request UUID)
RETURNS TABLE ("stored_days" NUMERIC, "current_days" NUMERIC, "available" NUMERIC, "available_after" NUMERIC) AS $$
DECLARE
  v_org UUID := "leave_require"('leave:read');
  v_req "leave_requests";
  v_type "leave_types";
  v_now NUMERIC;
  v_avail NUMERIC;
BEGIN
  SELECT q.* INTO v_req FROM "leave_requests" q WHERE q."id" = p_request AND q."organization_id" = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_type := "leave_type_of"(v_org, v_req."leave_type_id");
  v_now := "leave_count_days"(v_org, v_req."employee_id", v_req."start_day", v_req."end_day", v_req."start_half", v_req."end_half");
  v_avail := CASE WHEN v_type."paid" THEN "leave_available"(v_req."employee_id", v_type."id", extract(year FROM v_req."start_day")::INTEGER, v_req."id") END;
  RETURN QUERY SELECT v_req."days", v_now, v_avail, v_avail - v_now;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The daily job (maintenance mode): yearly grants (pro rata for joiners), monthly accrual, and on/after 1 February the
-- close of the previous year (carry-over up to the cap into the new year; the old year's remaining balance expires).
-- A month counts if the person is employed on its 15th. Idempotent. p_today (tests) may only move the date back.
CREATE FUNCTION "app_leave_housekeeping"(p_today DATE DEFAULT NULL) RETURNS INTEGER AS $$
DECLARE
  v_n INTEGER := 0;
  v_rows INTEGER;
  o RECORD;
  e RECORD;
  t RECORD;
  v_today DATE;
  v_year INTEGER;
  v_from INTEGER;
  v_days NUMERIC;
  m INTEGER;
  v_bal NUMERIC;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR (p_today IS NOT NULL AND p_today > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR o IN SELECT org."id", org."timezone" FROM "organizations" org
           WHERE org."status" = 'ACTIVE' AND EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = org."timezone") LOOP
    v_today := COALESCE(p_today, (clock_timestamp() AT TIME ZONE o."timezone")::date);
    v_year := extract(year FROM v_today)::INTEGER;
    FOR t IN SELECT lt.* FROM "leave_types" lt WHERE lt."organization_id" = o."id" AND lt."is_active" AND lt."configured" AND lt."paid" LOOP
      FOR e IN SELECT emp.* FROM "employees" emp WHERE emp."organization_id" = o."id" AND emp."joined_on" <= v_today
                 AND (emp."status" = 'ACTIVE' OR emp."exited_on" >= make_date(v_year, 1, 1)) LOOP
        -- First counting month of this year: January, or the joining month (if joined by the 15th) or the next one.
        v_from := CASE WHEN e."joined_on" < make_date(v_year, 1, 1) THEN 1
                       WHEN extract(day FROM e."joined_on") <= 15 THEN extract(month FROM e."joined_on")::INTEGER
                       ELSE extract(month FROM e."joined_on")::INTEGER + 1 END;
        IF t."accrual" = 'YEARLY' AND t."days_per_year" > 0 AND e."status" = 'ACTIVE' AND v_from <= 12 THEN
          v_days := floor(t."days_per_year" * (13 - v_from) / 12 * 2) / 2;
          IF v_days > 0 THEN
            INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason")
            VALUES (o."id", e."id", t."id", v_year, 'GRANT', v_days, 'Yearly leave')
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            v_n := v_n + v_rows;
          END IF;
        ELSIF t."accrual" = 'MONTHLY' AND t."days_per_year" > 0 THEN
          FOR m IN v_from .. extract(month FROM v_today)::INTEGER LOOP
            CONTINUE WHEN e."exited_on" IS NOT NULL AND e."exited_on" < make_date(v_year, m, 15);
            -- Cumulative rounding to half days, so twelve months add up to exactly the yearly number.
            v_days := floor(t."days_per_year" * m / 12 * 2) / 2 - floor(t."days_per_year" * (m - 1) / 12 * 2) / 2;
            CONTINUE WHEN v_days <= 0;
            INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "month", "reason")
            VALUES (o."id", e."id", t."id", v_year, 'ACCRUAL', v_days, m, 'Monthly leave')
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            v_n := v_n + v_rows;
          END LOOP;
        END IF;
      END LOOP;
      -- Close the previous year from 1 February on (after the 31 days in which past leave can still be asked for).
      IF v_today >= make_date(v_year, 2, 1) THEN
        FOR e IN SELECT l."employee_id" AS id, sum(l."days") AS bal FROM "leave_ledger" l
                 WHERE l."organization_id" = o."id" AND l."leave_type_id" = t."id" AND l."year" = v_year - 1
                 GROUP BY l."employee_id" HAVING sum(l."days") > 0 LOOP
          v_bal := e.bal;
          INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason")
          VALUES (o."id", e.id, t."id", v_year - 1, 'EXPIRED', -v_bal, 'Year closed')
          ON CONFLICT DO NOTHING;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_n := v_n + v_rows;
          IF v_rows > 0 AND LEAST(v_bal, t."carry_over_max") > 0 THEN
            INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason")
            VALUES (o."id", e.id, t."id", v_year, 'CARRY_OVER', LEAST(v_bal, t."carry_over_max"), 'Carried over from ' || (v_year - 1))
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            v_n := v_n + v_rows;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Attendance and rota (replaced functions; only the leave lines are new)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app_clock_in"(p_ip TEXT, p_user_agent TEXT) RETURNS UUID AS $$
DECLARE
  v_emp "employees" := "att_me"();
  v_org UUID := v_emp."organization_id";
  v_tz TEXT := "att_org_timezone"(v_org);
  v_now TIMESTAMPTZ := clock_timestamp();
  v_open "attendance_records";
  v_shift "shifts";
  v_id UUID;
BEGIN
  IF NOT "att_can_work_on"(v_emp, v_now, v_tz) THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  -- Leave: nobody clocks in on a day of approved full-day leave (HR cancels the leave if that is wrong).
  IF "leave_on_full_leave"(v_emp."id", (v_now AT TIME ZONE v_tz)::date) THEN
    RAISE EXCEPTION 'on_leave' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.* INTO v_open FROM "attendance_records" r WHERE r."organization_id" = v_org AND r."employee_id" = v_emp."id" AND r."status" = 'OPEN' FOR UPDATE;
  IF FOUND THEN
    IF NOT "att_is_abandoned"(v_open, v_now) THEN
      RAISE EXCEPTION 'already_clocked_in' USING ERRCODE = 'P0001';
    END IF;
    PERFORM "att_say"('MARKED_MISSING_OUT', NULL, NULL, false);
    UPDATE "attendance_records" SET "status" = 'MISSING_OUT' WHERE "id" = v_open."id";
  END IF;
  IF (SELECT count(*) FROM "attendance_records" r WHERE r."organization_id" = v_org AND r."employee_id" = v_emp."id"
        AND r."in_source" = 'SELF' AND r."clock_in_at" > v_now - INTERVAL '24 hours') >= 12 THEN
    RAISE EXCEPTION 'too_many_punches' USING ERRCODE = 'P0001';
  END IF;
  v_shift := "att_match_shift"(v_org, v_emp."id", v_now);
  PERFORM "att_say"('CLOCK_IN', NULL, NULL, false);
  BEGIN
    INSERT INTO "attendance_records" ("organization_id", "employee_id", "outlet_id", "shift_id", "clock_in_at", "status", "in_source", "in_ip", "in_user_agent")
    VALUES (v_org, v_emp."id", COALESCE(v_shift."outlet_id", v_emp."outlet_id"), v_shift."id", v_now, 'OPEN', 'SELF',
            "att_clean_ip"(p_ip), "att_clean_agent"(p_user_agent))
    RETURNING "id" INTO v_id;
  EXCEPTION WHEN exclusion_violation OR unique_violation THEN
    RAISE EXCEPTION 'attendance_overlap' USING ERRCODE = 'P0001';
  END;
  PERFORM "att_say"(NULL);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "att_sync_standard_shifts"(p_org UUID, p_days INTEGER) RETURNS INTEGER AS $$
DECLARE
  v_tz TEXT := "att_org_timezone"(p_org);
  v_now TIMESTAMPTZ := clock_timestamp();
  v_today DATE := (clock_timestamp() AT TIME ZONE "att_org_timezone"(p_org))::date;
  v_created INTEGER := 0;
  r RECORD;
  v_day DATE;
  v_from TIMESTAMPTZ;
  v_to TIMESTAMPTZ;
BEGIN
  IF "app_user_id"() IS NOT NULL OR p_days IS NULL OR p_days < 1 OR p_days > 31 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('standard-shifts:' || p_org::TEXT, 0));

  -- a) Generated shifts nobody has touched, still to come: follow the current standard, or are cancelled.
  --    Rows someone is editing right now are skipped (they are about to become "changed").
  FOR r IN
    SELECT s.*, p."standard_shift" AS want_shift, p."work_days", e."status" AS emp_status, e."exited_on", o AS outlet
    FROM "shifts" s
    JOIN "employees" e ON e."id" = s."employee_id"
    LEFT JOIN "employee_shift_patterns" p ON p."employee_id" = s."employee_id"
    LEFT JOIN "outlets" o ON o."id" = e."outlet_id" AND o."is_active"
    WHERE s."organization_id" = p_org AND s."source" = 'STANDARD' AND NOT s."edited" AND s."status" = 'PLANNED' AND s."starts_at" > v_now
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    v_day := r."standard_day";
    v_from := NULL;
    v_to := NULL;
    IF r.want_shift IS NOT NULL AND (r.outlet)."id" IS NOT NULL AND extract(isodow FROM v_day)::SMALLINT = ANY (r."work_days")
       AND (r.emp_status = 'ACTIVE' OR (r.emp_status = 'EXITED' AND r."exited_on" IS NOT NULL AND v_day <= r."exited_on")) THEN
      SELECT x.starts_at, x.ends_at INTO v_from, v_to FROM "att_standard_period"(r.outlet, r.want_shift, v_day, v_tz) x;
    END IF;
    BEGIN
      IF v_from IS NULL OR v_from <= v_now THEN
        UPDATE "shifts" SET "status" = 'CANCELLED', "cancel_reason" = 'No longer in the standard rota'
        WHERE "id" = r."id" AND "source" = 'STANDARD' AND NOT "edited" AND "status" = 'PLANNED';
      ELSIF v_from IS DISTINCT FROM r."starts_at" OR v_to IS DISTINCT FROM r."ends_at" OR (r.outlet)."id" IS DISTINCT FROM r."outlet_id"
            OR (r.outlet)."shift_break_minutes" IS DISTINCT FROM r."break_minutes" OR r.want_shift IS DISTINCT FROM r."standard_shift" THEN
        UPDATE "shifts" SET "starts_at" = v_from, "ends_at" = v_to, "outlet_id" = (r.outlet)."id",
               "break_minutes" = LEAST((r.outlet)."shift_break_minutes", GREATEST(0, (extract(epoch FROM v_to - v_from) / 60)::INTEGER - 1)),
               "standard_shift" = r.want_shift
        WHERE "id" = r."id" AND "source" = 'STANDARD' AND NOT "edited" AND "status" = 'PLANNED';
      END IF;
    EXCEPTION WHEN exclusion_violation OR check_violation OR raise_exception THEN
      NULL; -- leave it as it is (HR sees it on the rota)
    END;
  END LOOP;

  -- b) Days with no shift yet (a standard shift the system cancelled does not count): add one. The shifts guard
  --    re-checks this under a per-person-and-day lock (standard_day_taken).
  FOR r IN
    SELECT e."id" AS employee_id, e."joined_on", e."status" AS emp_status, e."exited_on", p."standard_shift", p."work_days", o AS outlet
    FROM "employee_shift_patterns" p
    JOIN "employees" e ON e."id" = p."employee_id" AND e."organization_id" = p_org
      AND (e."status" = 'ACTIVE' OR (e."status" = 'EXITED' AND e."exited_on" IS NOT NULL AND e."exited_on" >= v_today))
    JOIN "outlets" o ON o."id" = e."outlet_id" AND o."organization_id" = p_org AND o."is_active" AND o."opening_time" IS NOT NULL
    WHERE p."organization_id" = p_org
  LOOP
    FOR i IN 0 .. p_days - 1 LOOP
      v_day := v_today + i;
      CONTINUE WHEN v_day < r."joined_on" OR NOT (extract(isodow FROM v_day)::SMALLINT = ANY (r."work_days"));
      CONTINUE WHEN r.emp_status = 'EXITED' AND v_day > r."exited_on";
      CONTINUE WHEN "leave_on_full_leave"(r.employee_id, v_day); -- on approved leave that day
      CONTINUE WHEN EXISTS (SELECT 1 FROM "shifts" s WHERE s."employee_id" = r.employee_id
                              AND (s."standard_day" = v_day OR (s."starts_at" AT TIME ZONE v_tz)::date = v_day)
                              AND NOT (s."status" = 'CANCELLED' AND s."source" = 'STANDARD' AND NOT s."edited"));
      SELECT x.starts_at, x.ends_at INTO v_from, v_to FROM "att_standard_period"(r.outlet, r."standard_shift", v_day, v_tz) x;
      CONTINUE WHEN v_from IS NULL OR v_from <= v_now;
      BEGIN
        INSERT INTO "shifts" ("organization_id", "employee_id", "outlet_id", "starts_at", "ends_at", "break_minutes", "source", "standard_shift", "standard_day")
        VALUES (p_org, r.employee_id, (r.outlet)."id", v_from, v_to,
                LEAST((r.outlet)."shift_break_minutes", GREATEST(0, (extract(epoch FROM v_to - v_from) / 60)::INTEGER - 1)), 'STANDARD', r."standard_shift", v_day);
        v_created := v_created + 1;
      EXCEPTION WHEN exclusion_violation OR check_violation OR raise_exception THEN
        NULL; -- the day is taken, overlaps a shift HR planned by hand, or the employee cannot work that day
      END;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "guard_employee_status"() RETURNS trigger AS $$
DECLARE
  v_tz TEXT;
BEGIN
  IF OLD."status" = 'EXITED' THEN
    IF NEW."employee_code" IS DISTINCT FROM OLD."employee_code" OR NEW."full_name" IS DISTINCT FROM OLD."full_name"
       OR NEW."email" IS DISTINCT FROM OLD."email" OR NEW."phone" IS DISTINCT FROM OLD."phone"
       OR NEW."employment_type" IS DISTINCT FROM OLD."employment_type" OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."joined_on" IS DISTINCT FROM OLD."joined_on" OR NEW."exited_on" IS DISTINCT FROM OLD."exited_on"
       OR NEW."outlet_id" IS DISTINCT FROM OLD."outlet_id" OR NEW."department_id" IS DISTINCT FROM OLD."department_id"
       OR NEW."designation_id" IS DISTINCT FROM OLD."designation_id" OR NEW."manager_id" IS DISTINCT FROM OLD."manager_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR (NEW."member_id" IS NOT NULL AND NEW."member_id" IS DISTINCT FROM OLD."member_id") THEN
      RAISE EXCEPTION 'employee_exited' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."joined_on" > OLD."joined_on" THEN
    v_tz := "att_org_timezone"(NEW."organization_id");
    IF EXISTS (SELECT 1 FROM "attendance_records" a WHERE a."employee_id" = NEW."id" AND a."status" <> 'VOID'
                 AND (a."clock_in_at" AT TIME ZONE v_tz)::date < NEW."joined_on")
       OR EXISTS (SELECT 1 FROM "shifts" s WHERE s."employee_id" = NEW."id" AND s."status" = 'PLANNED'
                 AND (s."starts_at" AT TIME ZONE v_tz)::date < NEW."joined_on") THEN
      RAISE EXCEPTION 'employee_joined_after_attendance' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW."status" = 'EXITED' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('employees:' || NEW."organization_id"::text, 0));
    IF EXISTS (SELECT 1 FROM "employees" r WHERE r."manager_id" = NEW."id" AND r."status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'employee_has_reports' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM "attendance_records" a WHERE a."employee_id" = NEW."id" AND a."status" = 'OPEN') THEN
      RAISE EXCEPTION 'employee_clocked_in' USING ERRCODE = 'P0001';
    END IF;
    v_tz := "att_org_timezone"(NEW."organization_id");
    IF EXISTS (SELECT 1 FROM "attendance_records" a WHERE a."employee_id" = NEW."id" AND a."status" <> 'VOID'
                 AND (a."clock_in_at" AT TIME ZONE v_tz)::date > NEW."exited_on") THEN
      RAISE EXCEPTION 'employee_attendance_after_exit' USING ERRCODE = 'P0001';
    END IF;
    UPDATE "shifts" SET "status" = 'CANCELLED', "cancel_reason" = 'Employee left', "updated_at" = clock_timestamp()
    WHERE "employee_id" = NEW."id" AND "organization_id" = NEW."organization_id" AND "status" = 'PLANNED'
      AND ("starts_at" AT TIME ZONE v_tz)::date > NEW."exited_on";
    -- Leave after the last working day: approved leave is cancelled and its days come back; pending is withdrawn.
    INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "request_id", "reason", "created_by_id")
    SELECT q."organization_id", q."employee_id", q."leave_type_id", extract(year FROM q."start_day")::INTEGER, 'RESTORED', q."days", q."id",
           'Employee left', "app_user_id"()
    FROM "leave_requests" q WHERE q."employee_id" = NEW."id" AND q."status" = 'APPROVED' AND q."start_day" > NEW."exited_on";
    UPDATE "leave_requests" SET "status" = 'CANCELLED', "cancelled_at" = clock_timestamp(), "cancelled_by_id" = "app_user_id"(),
           "cancel_reason" = 'Employee left', "updated_at" = clock_timestamp()
    WHERE "employee_id" = NEW."id" AND "status" = 'APPROVED' AND "start_day" > NEW."exited_on";
    UPDATE "leave_requests" SET "status" = 'WITHDRAWN', "updated_at" = clock_timestamp()
    WHERE "employee_id" = NEW."id" AND "status" = 'PENDING' AND "end_day" > NEW."exited_on";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 4. Execution rights
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "leave_count_days"(UUID, UUID, DATE, DATE, BOOLEAN, BOOLEAN), "leave_balance"(UUID, UUID, INTEGER),
  "leave_available"(UUID, UUID, INTEGER, UUID), "leave_on_full_leave"(UUID, DATE), "leave_lock_employee"(UUID, UUID), "leave_require"(TEXT),
  "leave_me"(), "leave_type_of"(UUID, UUID), "leave_check_request"("employees", "leave_types", DATE, DATE, BOOLEAN, BOOLEAN, TEXT),
  "leave_other_approver_exists"(UUID), "leave_cancel_shifts"(UUID), "leave_approve"("leave_requests", "employees", BOOLEAN),
  "app_request_leave"(UUID, DATE, DATE, BOOLEAN, BOOLEAN, TEXT), "app_withdraw_leave"(UUID), "app_decide_leave"(UUID, BOOLEAN, TEXT),
  "app_hr_record_leave"(UUID, UUID, DATE, DATE, BOOLEAN, BOOLEAN, TEXT), "app_cancel_leave"(UUID, TEXT),
  "app_adjust_leave"(UUID, UUID, INTEGER, NUMERIC, TEXT), "app_leave_preview"(UUID), "app_leave_housekeeping"(DATE),
  "app_clock_in"(TEXT, TEXT), "att_sync_standard_shifts"(UUID, INTEGER), "guard_employee_status"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_request_leave"(UUID, DATE, DATE, BOOLEAN, BOOLEAN, TEXT), "app_withdraw_leave"(UUID), "app_decide_leave"(UUID, BOOLEAN, TEXT),
  "app_hr_record_leave"(UUID, UUID, DATE, DATE, BOOLEAN, BOOLEAN, TEXT), "app_cancel_leave"(UUID, TEXT),
  "app_adjust_leave"(UUID, UUID, INTEGER, NUMERIC, TEXT), "app_leave_preview"(UUID), "app_leave_housekeeping"(DATE),
  "app_clock_in"(TEXT, TEXT) TO hr_runtime;
-- NOT granted: the leave_* helpers (several take an organisation or employee id and trust it), the triggers.

COMMIT;
