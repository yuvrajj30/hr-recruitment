-- Employee Management (CafeOS milestone 1, 21 Nov 2026).
--
-- Organisation structure and employee records:
--   - outlets (cafe locations) and designations (job titles), next to the existing departments;
--   - employees: a record per person working for the organisation. A record does NOT need a CafeOS login (cafe
--     staff often have no email); it can be linked to a staff account, and that person can then read their own
--     record. Each has an outlet, department, designation and manager (all optional), a joining date, and leaves
--     by being marked EXITED with an exit date (records are never deleted);
--   - employee_assignments: the history of where an employee worked and for whom, written by the database itself
--     whenever an employee's outlet, department, designation or manager changes (nobody writes it directly).
-- Every table carries organization_id; every link is a two-column key (organisation, id), so nothing can point
-- into another organisation. Row-level security: HR (Super Admins, HR Managers) manage their own organisation;
-- every staff member may read the organisation's outlet, department and designation names; an employee linked to
-- a staff account may read their own record and history. Nothing else.
BEGIN;

-- ---------------------------------------------------------------------------
-- Structure: outlets and designations (departments already exist)
-- ---------------------------------------------------------------------------
CREATE TABLE "outlets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "address" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "outlets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outlets_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "outlets_address_check" CHECK ("address" IS NULL OR char_length("address") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "outlets_organization_id_name_key" ON "outlets"("organization_id", "name");
CREATE UNIQUE INDEX "outlets_organization_id_id_key" ON "outlets"("organization_id", "id");
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "designations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "designations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "designations_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "designations_organization_id_name_key" ON "designations"("organization_id", "name");
CREATE UNIQUE INDEX "designations_organization_id_id_key" ON "designations"("organization_id", "id");
ALTER TABLE "designations" ADD CONSTRAINT "designations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An employee record may point at a staff account of the same organisation.
CREATE UNIQUE INDEX "organization_members_organization_id_id_key" ON "organization_members"("organization_id", "id");

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'EXITED');

CREATE TABLE "employees" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_code" TEXT NOT NULL,
  "full_name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "employment_type" "EmploymentType" NOT NULL DEFAULT 'FULL_TIME',
  "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
  "joined_on" DATE NOT NULL,
  "exited_on" DATE,
  "outlet_id" UUID,
  "department_id" UUID,
  "designation_id" UUID,
  "manager_id" UUID,
  "member_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employees_code_check" CHECK ("employee_code" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,31}$'),
  CONSTRAINT "employees_name_check" CHECK ("full_name" = btrim("full_name") AND char_length("full_name") BETWEEN 1 AND 120),
  CONSTRAINT "employees_email_check" CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length("email") <= 254)),
  CONSTRAINT "employees_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+?[0-9][0-9 -]{5,19}$'),
  CONSTRAINT "employees_exit_check" CHECK (("status" = 'EXITED') = ("exited_on" IS NOT NULL) AND ("exited_on" IS NULL OR "exited_on" >= "joined_on")),
  CONSTRAINT "employees_not_own_manager" CHECK ("manager_id" IS NULL OR "manager_id" <> "id")
);
CREATE UNIQUE INDEX "employees_organization_id_employee_code_key" ON "employees"("organization_id", "employee_code");
CREATE UNIQUE INDEX "employees_organization_id_id_key" ON "employees"("organization_id", "id");
CREATE UNIQUE INDEX "employees_member_id_key" ON "employees"("member_id");
CREATE INDEX "employees_organization_id_status_idx" ON "employees"("organization_id", "status");
CREATE INDEX "employees_organization_id_manager_id_idx" ON "employees"("organization_id", "manager_id");
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employees_organization_id_outlet_id_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employees_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employees_organization_id_designation_id_fkey" FOREIGN KEY ("organization_id", "designation_id") REFERENCES "designations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employees_organization_id_manager_id_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employees_organization_id_member_id_fkey" FOREIGN KEY ("organization_id", "member_id") REFERENCES "organization_members"("organization_id", "id") ON DELETE SET NULL ("member_id") ON UPDATE CASCADE;

-- No reporting loops (A reports to B reports to A), checked whenever a manager is set.
CREATE FUNCTION "guard_employee_manager"() RETURNS trigger AS $$
DECLARE
  v_cur UUID := NEW."manager_id";
  v_depth INT := 0;
BEGIN
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
CREATE TRIGGER "employees_no_manager_loop" BEFORE INSERT OR UPDATE OF "manager_id" ON "employees"
  FOR EACH ROW WHEN (NEW."manager_id" IS NOT NULL) EXECUTE FUNCTION "guard_employee_manager"();

-- ---------------------------------------------------------------------------
-- Assignment history, written by the database
-- ---------------------------------------------------------------------------
CREATE TABLE "employee_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "outlet_id" UUID,
  "department_id" UUID,
  "designation_id" UUID,
  "manager_id" UUID,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6),
  "changed_by_id" UUID,
  CONSTRAINT "employee_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_assignments_period_check" CHECK ("ends_at" IS NULL OR "ends_at" >= "starts_at")
);
CREATE INDEX "employee_assignments_organization_id_employee_id_starts_at_idx" ON "employee_assignments"("organization_id", "employee_id", "starts_at");
CREATE UNIQUE INDEX "employee_assignments_one_current_key" ON "employee_assignments"("employee_id") WHERE "ends_at" IS NULL;
ALTER TABLE "employee_assignments"
  ADD CONSTRAINT "employee_assignments_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_assignments_organization_id_outlet_id_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_assignments_organization_id_department_id_fkey" FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_assignments_organization_id_designation_id_fkey" FOREIGN KEY ("organization_id", "designation_id") REFERENCES "designations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_assignments_organization_id_manager_id_fkey" FOREIGN KEY ("organization_id", "manager_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_assignments_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- On a new employee, and on any change of outlet, department, designation or manager: the current assignment
-- ends now and a new one starts, recorded with the signed-in person who made the change.
CREATE FUNCTION "record_employee_assignment"() RETURNS trigger AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."outlet_id" IS NOT DISTINCT FROM OLD."outlet_id"
     AND NEW."department_id" IS NOT DISTINCT FROM OLD."department_id"
     AND NEW."designation_id" IS NOT DISTINCT FROM OLD."designation_id"
     AND NEW."manager_id" IS NOT DISTINCT FROM OLD."manager_id" THEN
    RETURN NEW;
  END IF;
  UPDATE "employee_assignments" SET "ends_at" = v_now WHERE "employee_id" = NEW."id" AND "ends_at" IS NULL;
  INSERT INTO "employee_assignments" ("id", "organization_id", "employee_id", "outlet_id", "department_id", "designation_id", "manager_id", "starts_at", "changed_by_id")
  VALUES (gen_random_uuid(), NEW."organization_id", NEW."id", NEW."outlet_id", NEW."department_id", NEW."designation_id", NEW."manager_id", v_now, "app_user_id"());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "employees_record_assignment" AFTER INSERT OR UPDATE OF "outlet_id", "department_id", "designation_id", "manager_id" ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "record_employee_assignment"();

-- The employee record of the signed-in person in this organisation (NULL if none): for "own record" rules.
CREATE FUNCTION "app_my_employee_id"() RETURNS UUID AS $$
  SELECT e."id" FROM "employees" e
  JOIN "organization_members" om ON om."id" = e."member_id"
  WHERE om."user_id" = "app_user_id"() AND om."organization_id" = "app_org_id"() AND e."organization_id" = "app_org_id"();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE "outlets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "designations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_assignments" ENABLE ROW LEVEL SECURITY;

-- HR manage their own organisation's structure and employees.
CREATE POLICY "hr_same_org" ON "outlets" FOR ALL USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "designations" FOR ALL USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "employees" FOR ALL USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));
CREATE POLICY "hr_same_org" ON "employee_assignments" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_is_hr"()));

-- Every staff member of the organisation may read its structure names (to see where they work).
CREATE POLICY "staff_reads_structure" ON "outlets" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_staff_role"()) IS NOT NULL);
CREATE POLICY "staff_reads_structure" ON "designations" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_staff_role"()) IS NOT NULL);
CREATE POLICY "staff_reads_structure" ON "departments" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_staff_role"()) IS NOT NULL);

-- An employee linked to a staff account reads their own record and assignment history.
CREATE POLICY "own_record" ON "employees" FOR SELECT USING ("id" = (SELECT "app_my_employee_id"()));
CREATE POLICY "own_record" ON "employee_assignments" FOR SELECT USING ("employee_id" = (SELECT "app_my_employee_id"()));

-- Table rights of the app account: records are ended, never deleted; history is written only by the trigger.
GRANT SELECT, INSERT, UPDATE ON "outlets", "designations", "employees" TO hr_runtime;
REVOKE DELETE, TRUNCATE ON "outlets", "designations", "employees" FROM hr_runtime;
GRANT SELECT ON "employee_assignments" TO hr_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "employee_assignments" FROM hr_runtime;

REVOKE ALL ON FUNCTION "guard_employee_manager"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "record_employee_assignment"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_my_employee_id"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_my_employee_id"() TO hr_runtime;

COMMIT;
