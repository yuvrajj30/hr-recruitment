-- Attendance, part 3 of 3: marking an employee as left now also respects their attendance.
--   * Refused while they are clocked in (an OPEN record): HR closes or corrects it first.
--   * Refused when they have attendance after the chosen last working day.
--   * Their planned shifts after the last working day are cancelled automatically ("Employee left").
-- Everything else in guard_employee_status stays as in 20261121010000_employee_management_fixes. Attendance
-- functions share-lock the employee row first, so they and this exit (an UPDATE of that row) never interleave.
BEGIN;

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
  ELSIF NEW."status" = 'EXITED' THEN
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

COMMIT;
