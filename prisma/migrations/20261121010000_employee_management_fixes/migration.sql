-- Employee Management: review fixes (on top of 20261121000000_employee_management).
--  1. Manager changes and "mark as left" in one organisation run one at a time (advisory lock), so two HR users
--     acting at once can no longer create a reporting loop, or leave someone who has left with active reports.
--     A newly chosen manager must be an active employee.
--  2. A record marked as left is frozen in the database, not only in the app. Only unlinking its login stays
--     possible (also what happens when the staff account itself is removed). Leaving closes the current assignment.
--  3. "Own record" access needs an active member, user and organisation (like every other staff rule).
--  4. An Employee no longer sees the whole list of outlets, departments and designations: only the ones they are
--     or were assigned to, which is what their own record shows.
BEGIN;

-- 1. Reporting chain ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_employee_manager"() RETURNS trigger AS $$
DECLARE
  v_cur UUID := NEW."manager_id";
  v_depth INT := 0;
BEGIN
  -- Serialise manager changes and exits per organisation; every statement below then sees what the others committed.
  PERFORM pg_advisory_xact_lock(hashtextextended('employees:' || NEW."organization_id"::text, 0));
  IF (TG_OP = 'INSERT' OR NEW."manager_id" IS DISTINCT FROM OLD."manager_id")
     AND NOT EXISTS (SELECT 1 FROM "employees" m WHERE m."id" = NEW."manager_id" AND m."organization_id" = NEW."organization_id" AND m."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'manager_not_active' USING ERRCODE = 'P0001';
  END IF;
  WHILE v_cur IS NOT NULL LOOP
    IF v_cur = NEW."id" THEN
      RAISE EXCEPTION 'manager_loop' USING ERRCODE = 'P0001';
    END IF;
    v_depth := v_depth + 1;
    IF v_depth > 100 THEN
      RAISE EXCEPTION 'manager_chain_too_long' USING ERRCODE = 'P0001';
    END IF;
    SELECT e."manager_id" INTO v_cur FROM "employees" e WHERE e."id" = v_cur;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- 2. Leaving, and records of people who have left --------------------------------------------------------------
CREATE FUNCTION "guard_employee_status"() RETURNS trigger AS $$
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "employees_guard_status" BEFORE UPDATE ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "guard_employee_status"();

CREATE FUNCTION "close_employee_assignment"() RETURNS trigger AS $$
BEGIN
  UPDATE "employee_assignments" SET "ends_at" = GREATEST(clock_timestamp(), "starts_at")
  WHERE "employee_id" = NEW."id" AND "ends_at" IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "employees_close_assignment" AFTER UPDATE OF "status" ON "employees"
  FOR EACH ROW WHEN (OLD."status" = 'ACTIVE' AND NEW."status" = 'EXITED') EXECUTE FUNCTION "close_employee_assignment"();

REVOKE ALL ON FUNCTION "guard_employee_status"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "close_employee_assignment"() FROM PUBLIC;

-- 3. Own record only for an active member of an active organisation ---------------------------------------------
CREATE OR REPLACE FUNCTION "app_my_employee_id"() RETURNS UUID AS $$
  SELECT e."id" FROM "employees" e
  JOIN "organization_members" om ON om."id" = e."member_id"
  WHERE om."user_id" = "app_user_id"() AND om."organization_id" = "app_org_id"() AND e."organization_id" = "app_org_id"()
    AND "app_staff_role"() IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- 4. Structure names an Employee may read: those of their own (current or past) assignments ---------------------
DROP POLICY "staff_reads_structure" ON "outlets";
DROP POLICY "staff_reads_structure" ON "designations";
DROP POLICY "staff_reads_structure" ON "departments";
CREATE POLICY "own_assignment" ON "outlets" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"())
  AND "id" IN (SELECT a."outlet_id" FROM "employee_assignments" a WHERE a."employee_id" = (SELECT "app_my_employee_id"())));
CREATE POLICY "own_assignment" ON "designations" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"())
  AND "id" IN (SELECT a."designation_id" FROM "employee_assignments" a WHERE a."employee_id" = (SELECT "app_my_employee_id"())));
CREATE POLICY "own_assignment" ON "departments" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"())
  AND "id" IN (SELECT a."department_id" FROM "employee_assignments" a WHERE a."employee_id" = (SELECT "app_my_employee_id"())));

COMMIT;
