-- Attendance: standard shifts and shift history (on top of 20261122000000..20261122000300).
--
-- 1. Standard shifts. Most outlets keep the same hours every day, so HR sets them once:
--      outlets.opening_time / changeover_time / closing_time (+ a standard break). MORNING = opening -> changeover,
--      EVENING = changeover -> closing (a closing time at or before the changeover is after midnight, e.g. 00:00).
--    Each employee can have a standard: MORNING or EVENING, on chosen weekdays, at their home outlet
--    (employee_shift_patterns). The database fills the rota from this for the coming days (source STANDARD), daily
--    and whenever HR asks; days HR changed or added by hand are never touched. A standard shift that a PERSON
--    edits or cancels is marked `edited` ("changed from the standard") by the database itself. Generated shifts
--    whose standard has changed are updated, or cancelled when the day is no longer worked.
-- 2. Shift history. Every new, changed or cancelled shift leaves a row in shift_changes (before / after of times,
--    outlet, break, note, status, cancel reason), written by a trigger, append-only. HR can read it.
-- Who is a person and who is the system: system changes run without a signed-in person (app_user_id() is NULL):
-- the daily job (maintenance mode) and app_apply_standard_shifts, which drops the session for its own changes.
-- The app account cannot do that itself: without a session row-level security gives it no shifts at all.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Outlet hours
-- ---------------------------------------------------------------------------
ALTER TABLE "outlets"
  ADD COLUMN "opening_time" TIME(0),
  ADD COLUMN "changeover_time" TIME(0),
  ADD COLUMN "closing_time" TIME(0),
  ADD COLUMN "shift_break_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "outlets_hours_check" CHECK (
    ("opening_time" IS NULL AND "changeover_time" IS NULL AND "closing_time" IS NULL)
    OR ("opening_time" IS NOT NULL AND "changeover_time" IS NOT NULL AND "closing_time" IS NOT NULL
        AND "opening_time" < "changeover_time" AND "closing_time" <> "changeover_time")),
  ADD CONSTRAINT "outlets_shift_break_check" CHECK ("shift_break_minutes" BETWEEN 0 AND 240);

-- ---------------------------------------------------------------------------
-- 2. Employee standards and the shift columns
-- ---------------------------------------------------------------------------
CREATE TYPE "StandardShift" AS ENUM ('MORNING', 'EVENING');
CREATE TYPE "ShiftSource" AS ENUM ('MANUAL', 'STANDARD');

CREATE TABLE "employee_shift_patterns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "standard_shift" "StandardShift" NOT NULL,
  -- ISO weekdays worked: 1 = Monday ... 7 = Sunday.
  "work_days" SMALLINT[] NOT NULL,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_shift_patterns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_shift_patterns_days_check" CHECK (cardinality("work_days") BETWEEN 1 AND 7 AND "work_days" <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
    AND array_position("work_days", NULL) IS NULL)
);
CREATE UNIQUE INDEX "employee_shift_patterns_employee_id_key" ON "employee_shift_patterns"("employee_id");
CREATE INDEX "employee_shift_patterns_organization_id_idx" ON "employee_shift_patterns"("organization_id");
ALTER TABLE "employee_shift_patterns"
  ADD CONSTRAINT "employee_shift_patterns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_shift_patterns_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_shift_patterns_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "guard_shift_pattern"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id") THEN
    RAISE EXCEPTION 'pattern_fixed_fields' USING ERRCODE = 'P0001';
  END IF;
  NEW."updated_by_id" := "app_user_id"();
  NEW."updated_at" := clock_timestamp();
  IF TG_OP = 'INSERT' THEN
    NEW."created_at" := NEW."updated_at";
  END IF;
  -- One entry per weekday, in order.
  NEW."work_days" := ARRAY(SELECT DISTINCT d FROM unnest(NEW."work_days") d ORDER BY d);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "employee_shift_patterns_guard" BEFORE INSERT OR UPDATE ON "employee_shift_patterns" FOR EACH ROW EXECUTE FUNCTION "guard_shift_pattern"();

ALTER TABLE "shifts"
  ADD COLUMN "source" "ShiftSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "standard_shift" "StandardShift",
  ADD COLUMN "edited" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "shifts_source_check" CHECK (("source" = 'STANDARD') = ("standard_shift" IS NOT NULL) AND ("source" = 'STANDARD' OR NOT "edited"));
CREATE INDEX "shifts_organization_id_source_starts_at_idx" ON "shifts"("organization_id", "source", "starts_at");

-- ---------------------------------------------------------------------------
-- 3. Shift guard: people add MANUAL shifts only; a person changing a STANDARD shift marks it edited
--    (everything else as in 20261122000300_attendance_fixes)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_shift"() RETURNS trigger AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_person UUID := "app_user_id"();
  v_emp RECORD;
  v_tz TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."source" IS DISTINCT FROM OLD."source" THEN
      RAISE EXCEPTION 'shift_fixed_fields' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'shift_cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF v_person IS NOT NULL THEN
      -- A person: the standard it came from stays as it was, and a change of a standard shift is remembered.
      NEW."standard_shift" := OLD."standard_shift";
      NEW."edited" := OLD."edited" OR OLD."source" = 'STANDARD';
    ELSE
      NEW."edited" := OLD."edited";
    END IF;
    NEW."updated_by_id" := v_person;
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
    NEW."created_by_id" := v_person;
    NEW."updated_by_id" := v_person;
    NEW."created_at" := v_now;
    NEW."updated_at" := v_now;
    IF v_person IS NOT NULL THEN
      NEW."source" := 'MANUAL';
      NEW."standard_shift" := NULL;
    END IF;
    NEW."edited" := false;
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

-- ---------------------------------------------------------------------------
-- 4. Shift history
-- ---------------------------------------------------------------------------
CREATE TYPE "ShiftChangeKind" AS ENUM ('CREATED', 'CHANGED', 'CANCELLED');
CREATE TABLE "shift_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "shift_id" UUID NOT NULL,
  "kind" "ShiftChangeKind" NOT NULL,
  "before" JSONB,
  "after" JSONB NOT NULL,
  -- NULL: made by the system (standard rota), not by a person.
  "changed_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "shift_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shift_changes_organization_id_shift_id_idx" ON "shift_changes"("organization_id", "shift_id", "created_at");
ALTER TABLE "shift_changes"
  ADD CONSTRAINT "shift_changes_shift_fkey" FOREIGN KEY ("organization_id", "shift_id", "employee_id") REFERENCES "shifts"("organization_id", "id", "employee_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "shift_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "shift_snapshot"(s "shifts") RETURNS JSONB AS $$
  SELECT jsonb_build_object('starts_at', s."starts_at", 'ends_at', s."ends_at", 'outlet_id', s."outlet_id", 'break_minutes', s."break_minutes",
                            'note', s."note", 'status', s."status", 'cancel_reason', s."cancel_reason", 'source', s."source",
                            'standard_shift', s."standard_shift", 'edited', s."edited");
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "record_shift_change"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND "shift_snapshot"(NEW) IS NOT DISTINCT FROM "shift_snapshot"(OLD) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "shift_changes" ("organization_id", "employee_id", "shift_id", "kind", "before", "after", "changed_by_id")
  VALUES (NEW."organization_id", NEW."employee_id", NEW."id",
          CASE WHEN TG_OP = 'INSERT' THEN 'CREATED' WHEN NEW."status" = 'CANCELLED' THEN 'CANCELLED' ELSE 'CHANGED' END::"ShiftChangeKind",
          CASE WHEN TG_OP = 'UPDATE' THEN "shift_snapshot"(OLD) END, "shift_snapshot"(NEW), "app_user_id"());
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "shifts_history" AFTER INSERT OR UPDATE ON "shifts" FOR EACH ROW EXECUTE FUNCTION "record_shift_change"();

CREATE FUNCTION "block_shift_change_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'changed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id')
     OR (NEW."changed_by_id" IS NOT NULL AND NEW."changed_by_id" IS DISTINCT FROM OLD."changed_by_id") THEN
    RAISE EXCEPTION 'shift_changes is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "shift_changes_append_only" BEFORE UPDATE ON "shift_changes" FOR EACH ROW EXECUTE FUNCTION "block_shift_change_updates"();
CREATE TRIGGER "shift_changes_no_truncate" BEFORE TRUNCATE ON "shift_changes" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();

-- ---------------------------------------------------------------------------
-- 5. Filling the rota from the standard
-- ---------------------------------------------------------------------------
-- The period of a standard shift on a local day at an outlet, or nothing when the outlet has no hours.
CREATE FUNCTION "att_standard_period"(p_outlet "outlets", p_shift "StandardShift", p_day DATE, p_tz TEXT,
                                      OUT starts_at TIMESTAMPTZ, OUT ends_at TIMESTAMPTZ) AS $$
DECLARE
  v_from TIME := CASE p_shift WHEN 'MORNING' THEN p_outlet."opening_time" ELSE p_outlet."changeover_time" END;
  v_to TIME := CASE p_shift WHEN 'MORNING' THEN p_outlet."changeover_time" ELSE p_outlet."closing_time" END;
BEGIN
  IF v_from IS NULL OR v_to IS NULL THEN
    RETURN;
  END IF;
  starts_at := (p_day + v_from) AT TIME ZONE p_tz;
  ends_at := ((CASE WHEN v_to <= v_from THEN p_day + 1 ELSE p_day END) + v_to) AT TIME ZONE p_tz;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Brings the coming p_days days of one organisation's rota in line with the standard. Called only with no person
-- signed in (see app_apply_standard_shifts / app_generate_standard_shifts). Returns the number of shifts created.
CREATE FUNCTION "att_sync_standard_shifts"(p_org UUID, p_days INTEGER) RETURNS INTEGER AS $$
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
  FOR r IN
    SELECT s.*, p."standard_shift" AS want_shift, p."work_days", e."status" AS emp_status, e."outlet_id" AS emp_outlet, o AS outlet
    FROM "shifts" s
    JOIN "employees" e ON e."id" = s."employee_id"
    LEFT JOIN "employee_shift_patterns" p ON p."employee_id" = s."employee_id"
    LEFT JOIN "outlets" o ON o."id" = e."outlet_id" AND o."is_active"
    WHERE s."organization_id" = p_org AND s."source" = 'STANDARD' AND NOT s."edited" AND s."status" = 'PLANNED' AND s."starts_at" > v_now
  LOOP
    v_day := (r."starts_at" AT TIME ZONE v_tz)::date;
    v_from := NULL;
    v_to := NULL;
    IF r.want_shift IS NOT NULL AND r.emp_status = 'ACTIVE' AND (r.outlet)."id" IS NOT NULL
       AND extract(isodow FROM v_day)::SMALLINT = ANY (r."work_days") THEN
      SELECT x.starts_at, x.ends_at INTO v_from, v_to FROM "att_standard_period"(r.outlet, r.want_shift, v_day, v_tz) x;
    END IF;
    BEGIN
      IF v_from IS NULL OR v_from <= v_now THEN
        UPDATE "shifts" SET "status" = 'CANCELLED', "cancel_reason" = 'No longer in the standard rota' WHERE "id" = r."id";
      ELSIF v_from IS DISTINCT FROM r."starts_at" OR v_to IS DISTINCT FROM r."ends_at" OR (r.outlet)."id" IS DISTINCT FROM r."outlet_id"
            OR (r.outlet)."shift_break_minutes" IS DISTINCT FROM r."break_minutes" OR r.want_shift IS DISTINCT FROM r."standard_shift" THEN
        UPDATE "shifts" SET "starts_at" = v_from, "ends_at" = v_to, "outlet_id" = (r.outlet)."id",
               "break_minutes" = LEAST((r.outlet)."shift_break_minutes", GREATEST(0, (extract(epoch FROM v_to - v_from) / 60)::INTEGER - 1)),
               "standard_shift" = r.want_shift
        WHERE "id" = r."id";
      END IF;
    EXCEPTION WHEN exclusion_violation OR check_violation OR raise_exception THEN
      NULL; -- leave it as it is (HR sees it on the rota)
    END;
  END LOOP;

  -- b) Days with no shift yet (a standard shift the system cancelled does not count): add one.
  FOR r IN
    SELECT e."id" AS employee_id, e."joined_on", p."standard_shift", p."work_days", o AS outlet
    FROM "employee_shift_patterns" p
    JOIN "employees" e ON e."id" = p."employee_id" AND e."organization_id" = p_org AND e."status" = 'ACTIVE'
    JOIN "outlets" o ON o."id" = e."outlet_id" AND o."organization_id" = p_org AND o."is_active" AND o."opening_time" IS NOT NULL
    WHERE p."organization_id" = p_org
  LOOP
    FOR i IN 0 .. p_days - 1 LOOP
      v_day := v_today + i;
      CONTINUE WHEN v_day < r."joined_on" OR NOT (extract(isodow FROM v_day)::SMALLINT = ANY (r."work_days"));
      CONTINUE WHEN EXISTS (SELECT 1 FROM "shifts" s WHERE s."employee_id" = r.employee_id AND (s."starts_at" AT TIME ZONE v_tz)::date = v_day
                              AND NOT (s."status" = 'CANCELLED' AND s."source" = 'STANDARD' AND NOT s."edited"));
      SELECT x.starts_at, x.ends_at INTO v_from, v_to FROM "att_standard_period"(r.outlet, r."standard_shift", v_day, v_tz) x;
      CONTINUE WHEN v_from IS NULL OR v_from <= v_now;
      BEGIN
        INSERT INTO "shifts" ("organization_id", "employee_id", "outlet_id", "starts_at", "ends_at", "break_minutes", "source", "standard_shift")
        VALUES (p_org, r.employee_id, (r.outlet)."id", v_from, v_to,
                LEAST((r.outlet)."shift_break_minutes", GREATEST(0, (extract(epoch FROM v_to - v_from) / 60)::INTEGER - 1)), 'STANDARD', r."standard_shift");
        v_created := v_created + 1;
      EXCEPTION WHEN exclusion_violation OR check_violation OR raise_exception THEN
        NULL; -- overlaps a shift HR planned by hand, or the employee cannot work that day
      END;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- HR: apply the standard to the next 14 days of their organisation now (after changing hours or standards).
-- The changes are the system's (no person), so generated shifts stay "not changed from the standard".
CREATE FUNCTION "app_apply_standard_shifts"() RETURNS INTEGER AS $$
DECLARE
  v_org UUID := "att_require_hr"();
  v_token TEXT := current_setting('app.session_token', true);
  v_n INTEGER;
BEGIN
  PERFORM set_config('app.session_token', '', true);
  v_n := "att_sync_standard_shifts"(v_org, 14);
  PERFORM set_config('app.session_token', COALESCE(v_token, ''), true);
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- The daily job (maintenance mode): every organisation with standards, p_days ahead.
CREATE FUNCTION "app_generate_standard_shifts"(p_days INTEGER) RETURNS INTEGER AS $$
DECLARE
  v_total INTEGER := 0;
  v_org UUID;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR v_org IN SELECT DISTINCT p."organization_id" FROM "employee_shift_patterns" p JOIN "organizations" o ON o."id" = p."organization_id" AND o."status" = 'ACTIVE' LOOP
    BEGIN
      v_total := v_total + "att_sync_standard_shifts"(v_org, p_days);
    EXCEPTION WHEN raise_exception THEN
      NULL; -- e.g. an organisation whose time zone is not set correctly: the others still run
    END;
  END LOOP;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 6. Row-level security and rights
-- ---------------------------------------------------------------------------
ALTER TABLE "employee_shift_patterns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hr_reads" ON "employee_shift_patterns" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:read')));
CREATE POLICY "hr_adds" ON "employee_shift_patterns" FOR INSERT
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')));
CREATE POLICY "hr_changes" ON "employee_shift_patterns" FOR UPDATE
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')));
CREATE POLICY "hr_removes" ON "employee_shift_patterns" FOR DELETE
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:manage')));
CREATE POLICY "own_pattern" ON "employee_shift_patterns" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND "employee_id" = (SELECT "app_my_employee_id"()));
REVOKE ALL ON "employee_shift_patterns" FROM hr_runtime;
GRANT SELECT, DELETE ON "employee_shift_patterns" TO hr_runtime;
GRANT INSERT ("id", "organization_id", "employee_id", "standard_shift", "work_days", "created_at", "updated_at") ON "employee_shift_patterns" TO hr_runtime;
GRANT UPDATE ("standard_shift", "work_days", "updated_at") ON "employee_shift_patterns" TO hr_runtime;

ALTER TABLE "shift_changes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hr_reads" ON "shift_changes" FOR SELECT
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('attendance:read')));
REVOKE ALL ON "shift_changes" FROM hr_runtime;
GRANT SELECT ON "shift_changes" TO hr_runtime;

-- Prisma names these columns when it adds a shift; the guard decides their values for people.
GRANT INSERT ("source", "standard_shift", "edited") ON "shifts" TO hr_runtime;

REVOKE ALL ON FUNCTION "guard_shift"(), "guard_shift_pattern"(), "shift_snapshot"("shifts"), "record_shift_change"(), "block_shift_change_updates"(),
  "att_standard_period"("outlets", "StandardShift", DATE, TEXT), "att_sync_standard_shifts"(UUID, INTEGER),
  "app_apply_standard_shifts"(), "app_generate_standard_shifts"(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_apply_standard_shifts"(), "app_generate_standard_shifts"(INTEGER) TO hr_runtime;
-- NOT granted: att_sync_standard_shifts (takes an organisation id and trusts it), att_standard_period, the triggers.

COMMIT;
