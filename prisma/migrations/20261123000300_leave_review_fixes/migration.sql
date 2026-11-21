-- Leave: fixes from the milestone's final review (CafeOS Milestone 3).
-- 1. Cancelling partly-past leave gave back the stored count minus a RECOUNT of the past days with today's holidays and
--    standard, so a holiday or standard change after approval moved the balance. Each approved request now records what
--    each day was charged (leave_request_days); a cancel gives back exactly the charge of today and later.
-- 2. Approving leave cancelled a shift the person had already clocked into early (clock-in links a shift from 2 hours
--    before its start). Such a shift now stays.
-- 3. The year close expired the whole balance of types without accrual (comp-off, HR credits), which the design leaves
--    to HR. Their balance now moves to the new year in full; capped carry-over stays for yearly and monthly types.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-day charges
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_request_days" (
  "organization_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "weight" NUMERIC(2,1) NOT NULL,
  CONSTRAINT "leave_request_days_pkey" PRIMARY KEY ("request_id", "day"),
  CONSTRAINT "leave_request_days_weight_check" CHECK ("weight" IN (0.5, 1.0)),
  CONSTRAINT "leave_request_days_request_fkey" FOREIGN KEY ("organization_id", "request_id")
    REFERENCES "leave_requests"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "leave_request_days_organization_id_idx" ON "leave_request_days"("organization_id");
-- Written only by the leave functions; the app reads the stored count on the request.
ALTER TABLE "leave_request_days" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "leave_request_days" FROM PUBLIC;
REVOKE ALL ON "leave_request_days" FROM hr_runtime;

-- The days of a period that count for one employee, with their weight (1, or 0.5 for a half day). Same rules as
-- before: holidays (organisation-wide or at their home outlet) and weekly offs do not count; on a one-day period either
-- half flag means 0.5. leave_count_days is now the sum of this, so the two can never disagree.
CREATE FUNCTION "leave_day_weights"(p_org UUID, p_employee UUID, p_start DATE, p_end DATE, p_start_half BOOLEAN, p_end_half BOOLEAN)
RETURNS TABLE ("day" DATE, "weight" NUMERIC) AS $$
  SELECT x.d, (CASE WHEN (x.d = p_start AND p_start_half) OR (x.d = p_end AND p_end_half) THEN 0.5 ELSE 1 END)::NUMERIC(2,1)
  FROM generate_series(p_start::timestamp, p_end::timestamp, INTERVAL '1 day') AS g(t)
  CROSS JOIN LATERAL (SELECT g.t::date AS d) AS x
  WHERE NOT EXISTS (
          SELECT 1 FROM "holidays" h
          WHERE h."organization_id" = p_org AND h."day" = x.d
            AND (h."outlet_id" IS NULL OR h."outlet_id" = (SELECT e."outlet_id" FROM "employees" e WHERE e."id" = p_employee AND e."organization_id" = p_org)))
    AND COALESCE(extract(isodow FROM x.d)::SMALLINT = ANY (
          (SELECT p."work_days" FROM "employee_shift_patterns" p WHERE p."employee_id" = p_employee AND p."organization_id" = p_org)::SMALLINT[]), true)
  ORDER BY x.d;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION "leave_count_days"(p_org UUID, p_employee UUID, p_start DATE, p_end DATE, p_start_half BOOLEAN, p_end_half BOOLEAN)
RETURNS NUMERIC AS $$
  SELECT COALESCE(sum(w."weight"), 0)::NUMERIC(5,1) FROM "leave_day_weights"(p_org, p_employee, p_start, p_end, p_start_half, p_end_half) w;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Leave approved before this migration: record today's view of its days where it matches the stored count (otherwise
-- a cancel falls back to the old recount).
INSERT INTO "leave_request_days" ("organization_id", "request_id", "day", "weight")
SELECT q."organization_id", q."id", w."day", w."weight"
FROM "leave_requests" q
CROSS JOIN LATERAL "leave_day_weights"(q."organization_id", q."employee_id", q."start_day", q."end_day", q."start_half", q."end_half") w
WHERE q."status" = 'APPROVED'
  AND "leave_count_days"(q."organization_id", q."employee_id", q."start_day", q."end_day", q."start_half", q."end_half") = q."days";

CREATE OR REPLACE FUNCTION "leave_approve"(p_req "leave_requests", p_emp "employees", p_self BOOLEAN) RETURNS void AS $$
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
  -- What each day was charged, so a later cancel gives back exactly the charge of the days not yet taken.
  INSERT INTO "leave_request_days" ("organization_id", "request_id", "day", "weight")
  SELECT p_req."organization_id", p_req."id", w."day", w."weight"
  FROM "leave_day_weights"(p_req."organization_id", p_emp."id", p_req."start_day", p_req."end_day", p_req."start_half", p_req."end_half") w;
  PERFORM "leave_cancel_shifts"(p_req."id");
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

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
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. A shift already clocked into stays
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "leave_cancel_shifts"(p_request UUID) RETURNS INTEGER AS $$
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
    -- A shift the person has already clocked into (clock-in links a shift from 2 hours before its start) stays.
    AND NOT EXISTS (SELECT 1 FROM "attendance_records" a WHERE a."shift_id" = s."id" AND a."status" <> 'VOID')
    AND "leave_on_full_leave"(v_req."employee_id", COALESCE(s."standard_day", (s."starts_at" AT TIME ZONE v_tz)::date))
    AND COALESCE(s."standard_day", (s."starts_at" AT TIME ZONE v_tz)::date) BETWEEN v_req."start_day" AND v_req."end_day";
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.session_token', COALESCE(v_token, ''), true);
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Year close: no automatic expiry for types without accrual
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "app_leave_housekeeping"(p_today DATE DEFAULT NULL) RETURNS INTEGER AS $$
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
  v_carry NUMERIC;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR (p_today IS NOT NULL AND p_today > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR o IN SELECT org."id", org."timezone" FROM "organizations" org
           WHERE org."status" = 'ACTIVE' AND (EXISTS (SELECT 1 FROM "time_zone_names" z WHERE z."name" = org."timezone")
                OR EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z."name" = org."timezone")) LOOP
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
          -- Types with no accrual (comp-off, HR credits) never expire by themselves: the whole balance moves on.
          v_carry := CASE WHEN t."accrual" = 'NONE' THEN v_bal ELSE LEAST(v_bal, t."carry_over_max") END;
          INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason")
          VALUES (o."id", e.id, t."id", v_year - 1, 'EXPIRED', -v_bal, 'Year closed')
          ON CONFLICT DO NOTHING;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          v_n := v_n + v_rows;
          IF v_rows > 0 AND v_carry > 0 THEN
            INSERT INTO "leave_ledger" ("organization_id", "employee_id", "leave_type_id", "year", "kind", "days", "reason")
            VALUES (o."id", e.id, t."id", v_year, 'CARRY_OVER', v_carry, 'Carried over from ' || (v_year - 1))
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

REVOKE ALL ON FUNCTION "leave_day_weights"(UUID, UUID, DATE, DATE, BOOLEAN, BOOLEAN) FROM PUBLIC;

COMMIT;
