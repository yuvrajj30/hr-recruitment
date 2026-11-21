-- Attendance: fixes found by the service tests (on top of 20261122000000..20261122000200).
--  1. Prisma sends created_at and status when it adds a shift, so the app account may now name those columns. The
--     database still decides them: a new shift is always PLANNED, and created_at / updated_at are its own clock.
--  2. A correction that moves the times so that recorded breaks fall (partly) outside the new period no longer fails:
--     only the part of each break inside the new period counts, and that becomes the record's break minutes.
--     (Before, an employee asking "I left at 17:30" was refused because a break ran to 17:30:12.) Break minutes
--     that no longer fit a shortened period are refused with a clear message instead of a raw constraint error.
--  3. Review fixes: a CLOSED record must have a clock-out time (the old check let NULL through), and an active
--     employee's joining date cannot be moved after attendance or planned shifts they already have.
BEGIN;

-- 1. Shifts --------------------------------------------------------------------------------------------------
GRANT INSERT ("status", "created_at") ON "shifts" TO hr_runtime;

CREATE OR REPLACE FUNCTION "guard_shift"() RETURNS trigger AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_emp RECORD;
  v_tz TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'shift_fixed_fields' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'shift_cancelled' USING ERRCODE = 'P0001';
    END IF;
    NEW."updated_by_id" := "app_user_id"();
    NEW."updated_at" := v_now;
    IF NEW."status" = 'CANCELLED' THEN
      IF NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
         OR NEW."outlet_id" IS DISTINCT FROM OLD."outlet_id" OR NEW."break_minutes" IS DISTINCT FROM OLD."break_minutes" THEN
        RAISE EXCEPTION 'shift_cancel_only' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD."ends_at" <= v_now THEN
      RAISE EXCEPTION 'shift_over' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."starts_at" <= v_now AND (NEW."starts_at" IS DISTINCT FROM OLD."starts_at" OR NEW."outlet_id" IS DISTINCT FROM OLD."outlet_id") THEN
      RAISE EXCEPTION 'shift_started' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    NEW."created_by_id" := "app_user_id"();
    NEW."updated_by_id" := NEW."created_by_id";
    NEW."created_at" := v_now;
    NEW."updated_at" := v_now;
    IF NEW."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'shift_must_be_planned' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."starts_at" < v_now - INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'shift_in_past' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW."ends_at" <= v_now THEN
    RAISE EXCEPTION 'shift_in_past' USING ERRCODE = 'P0001';
  END IF;
  SELECT e."status", e."joined_on", e."exited_on" INTO v_emp FROM "employees" e
  WHERE e."id" = NEW."employee_id" AND e."organization_id" = NEW."organization_id" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_tz := "att_org_timezone"(NEW."organization_id");
  IF (NEW."starts_at" AT TIME ZONE v_tz)::date < v_emp."joined_on" THEN
    RAISE EXCEPTION 'shift_before_joining' USING ERRCODE = 'P0001';
  END IF;
  IF v_emp."status" = 'EXITED' AND (v_emp."exited_on" IS NULL OR (NEW."starts_at" AT TIME ZONE v_tz)::date > v_emp."exited_on") THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."outlet_id" IS DISTINCT FROM OLD."outlet_id")
     AND NOT EXISTS (SELECT 1 FROM "outlets" o WHERE o."id" = NEW."outlet_id" AND o."organization_id" = NEW."organization_id" AND o."is_active") THEN
    RAISE EXCEPTION 'outlet_not_active' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- 2. Corrections and recorded breaks -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "att_apply_correction"(p_rec "attendance_records", p_emp "employees", p_tz TEXT, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ,
                                                  p_outlet UUID, p_set_break BOOLEAN, p_break INTEGER, p_reason TEXT, p_request UUID, p_self BOOLEAN)
RETURNS void AS $$
DECLARE
  v_shift "shifts";
  v_set BOOLEAN := p_set_break;
  v_break INTEGER := CASE WHEN p_set_break THEN p_break ELSE p_rec."break_minutes" END;
BEGIN
  IF p_rec."status" = 'VOID' THEN
    RAISE EXCEPTION 'attendance_void' USING ERRCODE = 'P0001';
  END IF;
  IF p_out IS NULL AND p_rec."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'attendance_bad_period' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "att_check_period"(p_emp, p_tz, p_in, p_out, CASE WHEN p_set_break THEN p_break END);
  IF p_outlet IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "outlets" o WHERE o."id" = p_outlet AND o."organization_id" = p_rec."organization_id") THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  -- Recorded breaks partly outside the new period: count only the part inside it (as break minutes), unless the
  -- break minutes are given. An open record (no end yet) cannot be clipped: then the minutes must be given.
  IF NOT p_set_break AND p_rec."break_minutes" IS NULL AND EXISTS (SELECT 1 FROM "attendance_breaks" b WHERE b."record_id" = p_rec."id"
       AND (b."starts_at" < p_in OR (p_out IS NOT NULL AND COALESCE(b."ends_at", 'infinity') > p_out))) THEN
    IF p_out IS NULL THEN
      RAISE EXCEPTION 'attendance_breaks_outside' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(floor(sum(extract(epoch FROM GREATEST(INTERVAL '0', LEAST(COALESCE(b."ends_at", p_out), p_out) - GREATEST(b."starts_at", p_in)))) / 60), 0)::INTEGER
      INTO v_break FROM "attendance_breaks" b WHERE b."record_id" = p_rec."id";
    v_set := true;
  END IF;
  -- Whatever break minutes the record ends up with must fit the new period.
  IF v_break IS NOT NULL AND p_out IS NOT NULL AND v_break * INTERVAL '1 minute' >= p_out - p_in THEN
    RAISE EXCEPTION 'attendance_bad_break' USING ERRCODE = 'P0001';
  END IF;
  v_shift := "att_match_shift"(p_rec."organization_id", p_rec."employee_id", p_in);
  PERFORM "att_say"('CORRECTED', p_reason, p_request, p_self);
  BEGIN
    UPDATE "attendance_records" SET
      "clock_in_at" = p_in, "clock_out_at" = p_out,
      "status" = CASE WHEN p_out IS NULL THEN 'OPEN' ELSE 'CLOSED' END::"AttendanceStatus",
      "outlet_id" = COALESCE(p_outlet, "outlet_id"),
      "shift_id" = v_shift."id",
      "break_minutes" = CASE WHEN v_set THEN v_break ELSE "break_minutes" END,
      "in_source" = CASE WHEN p_in IS DISTINCT FROM p_rec."clock_in_at" THEN 'CORRECTION' ELSE "in_source" END::"AttendanceSource",
      "out_source" = CASE WHEN p_out IS NULL THEN NULL WHEN p_out IS DISTINCT FROM p_rec."clock_out_at" THEN 'CORRECTION' ELSE "out_source" END::"AttendanceSource"
    WHERE "id" = p_rec."id";
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'attendance_overlap' USING ERRCODE = 'P0001';
  END;
  PERFORM "att_supersede_requests"(p_rec."organization_id", p_rec."id", p_request);
  PERFORM "att_say"(NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- 3. A CLOSED record always has its clock-out ----------------------------------------------------------------
ALTER TABLE "attendance_records" DROP CONSTRAINT "attendance_records_state_check";
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_state_check" CHECK (COALESCE(CASE "status"
    WHEN 'OPEN' THEN "clock_out_at" IS NULL AND "out_source" IS NULL
    WHEN 'MISSING_OUT' THEN "clock_out_at" IS NULL AND "out_source" IS NULL
    WHEN 'CLOSED' THEN "clock_out_at" IS NOT NULL AND "clock_out_at" > "clock_in_at" AND "clock_out_at" - "clock_in_at" <= INTERVAL '24 hours' AND "out_source" IS NOT NULL
    ELSE "clock_out_at" IS NULL OR "clock_out_at" > "clock_in_at" END, false));

-- ... and the joining date cannot move after existing attendance or planned shifts.
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

REVOKE ALL ON FUNCTION "guard_employee_status"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_shift"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "att_apply_correction"("attendance_records", "employees", TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID, BOOLEAN, INTEGER, TEXT, UUID, BOOLEAN) FROM PUBLIC;

COMMIT;
