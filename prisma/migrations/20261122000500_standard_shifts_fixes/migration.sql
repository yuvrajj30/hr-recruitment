-- Standard shifts: review fixes (on top of 20261122000400_standard_shifts_and_shift_history).
--  1. Someone leaving on a later date keeps (and gets) their standard shifts up to their last working day,
--     like everywhere else in attendance (before, the rota fill cancelled their notice period).
--  2. The rota fill never overwrites a shift a person changed meanwhile: it locks the rows it updates (skipping
--     ones being edited) and re-checks they are still untouched standard shifts; and a new standard shift and
--     a shift HR adds by hand for the same person and day are serialised, so the fill cannot add a second shift
--     on a day HR has just filled.
--  3. A standard shift remembers the day it stands for (standard_day). Moving it to another day by hand no
--     longer makes the fill add a second standard shift on the original day.
--  4. Outlet hours are limited in the database too: each standard shift at most 16 hours.
BEGIN;

-- 3. The standard day of generated shifts ---------------------------------------------------------------------
ALTER TABLE "shifts" ADD COLUMN "standard_day" DATE;
ALTER TABLE "shifts" DISABLE TRIGGER "shifts_guard";
ALTER TABLE "shifts" DISABLE TRIGGER "shifts_history";
UPDATE "shifts" s SET "standard_day" = (s."starts_at" AT TIME ZONE o."timezone")::date
FROM "organizations" o WHERE o."id" = s."organization_id" AND s."source" = 'STANDARD';
ALTER TABLE "shifts" ENABLE TRIGGER "shifts_guard";
ALTER TABLE "shifts" ENABLE TRIGGER "shifts_history";
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_standard_day_check" CHECK (("source" = 'STANDARD') = ("standard_day" IS NOT NULL));
CREATE INDEX "shifts_employee_id_standard_day_idx" ON "shifts"("employee_id", "standard_day");

-- 4. Outlet hours: each standard shift at most 16 hours ------------------------------------------------------
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_hours_length_check" CHECK ("opening_time" IS NULL OR (
  "changeover_time" - "opening_time" <= INTERVAL '16 hours'
  AND (CASE WHEN "closing_time" > "changeover_time" THEN "closing_time" - "changeover_time"
            ELSE "closing_time" - "changeover_time" + INTERVAL '24 hours' END) <= INTERVAL '16 hours'));

-- 2 + 3. Shift guard ------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "guard_shift"() RETURNS trigger AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_person UUID := "app_user_id"();
  v_emp RECORD;
  v_tz TEXT := "att_org_timezone"(NEW."organization_id");
  v_day DATE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."standard_day" IS DISTINCT FROM OLD."standard_day" THEN
      RAISE EXCEPTION 'shift_fixed_fields' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'shift_cancelled' USING ERRCODE = 'P0001';
    END IF;
    IF v_person IS NOT NULL THEN
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
      NEW."standard_day" := NULL;
    END IF;
    NEW."edited" := false;
    IF NEW."status" <> 'PLANNED' THEN
      RAISE EXCEPTION 'shift_must_be_planned' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."starts_at" < v_now - INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'shift_in_past' USING ERRCODE = 'P0001';
    END IF;
    -- One person, one day: a new shift by hand and a new standard shift wait for each other; a standard shift is
    -- not added to a day that already has a shift (other than a standard one the system cancelled).
    v_day := COALESCE(NEW."standard_day", (NEW."starts_at" AT TIME ZONE v_tz)::date);
    PERFORM pg_advisory_xact_lock(hashtextextended('shift-day:' || NEW."employee_id"::TEXT || ':' || v_day::TEXT, 0));
    IF NEW."source" = 'STANDARD' AND EXISTS (
         SELECT 1 FROM "shifts" s WHERE s."employee_id" = NEW."employee_id"
           AND (s."standard_day" = v_day OR (s."starts_at" AT TIME ZONE v_tz)::date = v_day)
           AND NOT (s."status" = 'CANCELLED' AND s."source" = 'STANDARD' AND NOT s."edited")) THEN
      RAISE EXCEPTION 'standard_day_taken' USING ERRCODE = 'P0001';
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

-- 1 + 2 + 3. The rota fill --------------------------------------------------------------------------------------
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

-- shift_snapshot: include the standard day in the history.
CREATE OR REPLACE FUNCTION "shift_snapshot"(s "shifts") RETURNS JSONB AS $$
  SELECT jsonb_build_object('starts_at', s."starts_at", 'ends_at', s."ends_at", 'outlet_id', s."outlet_id", 'break_minutes', s."break_minutes",
                            'note', s."note", 'status', s."status", 'cancel_reason', s."cancel_reason", 'source', s."source",
                            'standard_shift', s."standard_shift", 'standard_day', s."standard_day", 'edited', s."edited");
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

-- Prisma names the new column when it adds a shift; the guard empties it for people.
GRANT INSERT ("standard_day") ON "shifts" TO hr_runtime;
REVOKE ALL ON FUNCTION "guard_shift"(), "att_sync_standard_shifts"(UUID, INTEGER), "shift_snapshot"("shifts") FROM PUBLIC;

COMMIT;
