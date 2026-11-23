-- Attendance, part 1 of 3: the new self-service permission, shared helpers, and the planned rota (shifts).
--   * self:attendance_clock: clock in and out, breaks, correction requests. Every role has it (HR staff are
--     employees too), mirroring src/lib/auth/roles.ts.
--   * app_has_permission(key): the asking member's role holds this permission key (database-side check by key,
--     never by role name).
--   * shifts: HR plans who works where and when. Two planned shifts of one employee never overlap (exclusion
--     constraint). A shift that has started cannot be moved back (its start and outlet are fixed, so a late
--     arrival cannot be hidden afterwards); any shift can be cancelled with a reason; a cancelled shift is final.
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "key", "module", "description")
VALUES (gen_random_uuid(), 'self:attendance_clock', 'self', 'Clock in and out, record breaks and ask for attendance corrections')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('SUPER_ADMIN', 'HR_MANAGER', 'EMPLOYEE') AND p."key" = 'self:attendance_clock'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- The asking member (active member, user and organisation: see app_staff_role) holds this permission.
CREATE FUNCTION "app_has_permission"(p_key TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
    WHERE r."key" = "app_staff_role"() AND p."key" = p_key);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The organisation's time zone, checked to be a real zone name (local dates are computed with it).
CREATE FUNCTION "att_org_timezone"(p_org UUID) RETURNS TEXT AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT o."timezone" INTO v_tz FROM "organizations" o WHERE o."id" = p_org;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE "name" = v_tz) THEN
    RAISE EXCEPTION 'invalid_timezone' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_tz;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 3. Shifts
-- ---------------------------------------------------------------------------
CREATE TYPE "ShiftStatus" AS ENUM ('PLANNED', 'CANCELLED');

CREATE TABLE "shifts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "outlet_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "break_minutes" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "status" "ShiftStatus" NOT NULL DEFAULT 'PLANNED',
  "cancel_reason" TEXT,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "shifts_period_check" CHECK ("ends_at" > "starts_at" AND "ends_at" - "starts_at" <= INTERVAL '16 hours'),
  CONSTRAINT "shifts_break_check" CHECK ("break_minutes" >= 0 AND "break_minutes" <= 240
                                         AND "break_minutes" * INTERVAL '1 minute' < "ends_at" - "starts_at"),
  CONSTRAINT "shifts_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
  CONSTRAINT "shifts_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL)
                                          AND ("cancel_reason" IS NULL OR char_length(btrim("cancel_reason")) BETWEEN 1 AND 500)),
  CONSTRAINT "shifts_no_overlap" EXCLUDE USING gist ("employee_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&) WHERE ("status" = 'PLANNED')
);
CREATE UNIQUE INDEX "shifts_organization_id_id_key" ON "shifts"("organization_id", "id");
CREATE UNIQUE INDEX "shifts_organization_id_id_employee_id_key" ON "shifts"("organization_id", "id", "employee_id");
CREATE INDEX "shifts_organization_id_starts_at_idx" ON "shifts"("organization_id", "starts_at");
CREATE INDEX "shifts_organization_id_employee_id_starts_at_idx" ON "shifts"("organization_id", "employee_id", "starts_at");
ALTER TABLE "shifts"
  ADD CONSTRAINT "shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shifts_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shifts_organization_id_outlet_id_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shifts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "shifts_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules a CHECK cannot express. Runs with owner's rights: it reads the employee and outlet whatever the caller's
-- row-level security allows, and it sets who made the change from the session (never from the app).
--   * New shift: for an employee who can still work on that day (active, or leaving on a later date), at an active
--     outlet, not before the joining date, and not already over.
--   * Change of a planned shift: not once it is over; once it has started its start and outlet are fixed.
--   * Cancelling: always possible with a reason (also for past shifts); a cancelled shift never changes again.
--   * Employee, organisation and creator never change.
CREATE FUNCTION "guard_shift"() RETURNS trigger AS $$
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
    IF NEW."status" = 'CANCELLED' THEN
      -- Cancelling changes nothing else.
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
  -- The employee row is share-locked: marking them as left (an UPDATE of that row) waits for this to finish.
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
CREATE TRIGGER "shifts_guard" BEFORE INSERT OR UPDATE ON "shifts" FOR EACH ROW EXECUTE FUNCTION "guard_shift"();

-- ---------------------------------------------------------------------------
-- 4. Row-level security and rights
-- ---------------------------------------------------------------------------
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hr_reads" ON "shifts" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:read')));
CREATE POLICY "hr_adds" ON "shifts" FOR INSERT
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')));
CREATE POLICY "hr_changes" ON "shifts" FOR UPDATE
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')));
-- An employee sees their own rota (app_my_employee_id needs an active membership in this organisation).
CREATE POLICY "own_shifts" ON "shifts" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND "employee_id" = (SELECT "app_my_employee_id"()));

-- New tables inherit broad default rights: start from none, then give exactly these.
REVOKE ALL ON "shifts" FROM hr_runtime;
GRANT SELECT ON "shifts" TO hr_runtime;
GRANT INSERT ("id", "organization_id", "employee_id", "outlet_id", "starts_at", "ends_at", "break_minutes", "note", "updated_at") ON "shifts" TO hr_runtime;
GRANT UPDATE ("outlet_id", "starts_at", "ends_at", "break_minutes", "note", "status", "cancel_reason", "updated_at") ON "shifts" TO hr_runtime;

REVOKE ALL ON FUNCTION "app_has_permission"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "att_org_timezone"(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION "guard_shift"() FROM PUBLIC;
-- app_has_permission is read by the policies above, which run as the app account.
GRANT EXECUTE ON FUNCTION "app_has_permission"(TEXT) TO hr_runtime;

COMMIT;
