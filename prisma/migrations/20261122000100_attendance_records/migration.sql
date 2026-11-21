-- Attendance, part 2 of 3: worked time, breaks, its history, and correction requests.
--
-- The app account can only READ these tables. Every change goes through the owner's-rights functions in section
-- 6, so a clock-in always gets the database's own time, and every change leaves a history row. Each function:
--   1. finds out who is asking from the session (app_staff_role / app_my_employee_id), and checks the permission
--      key in SQL;
--   2. resolves every id it is given within the caller's organisation; a missing and a foreign id give the same
--      'not_found' error;
--   3. locks in one fixed order: the employee row (FOR SHARE, so marking someone as left waits), then a
--      per-employee advisory lock, then the record / request rows (FOR UPDATE).
--
-- Record states: OPEN (clocked in; at most one per employee) -> CLOSED (clocked out, or set by a correction);
-- OPEN -> MISSING_OUT (left open: more than 20 hours, or 4 hours past the end of its shift; noticed at the next
-- clock-in or clock-out, and fixed by a correction); any -> VOID (HR only, with a reason; kept, never counted).
-- OPEN and CLOSED records of one employee never overlap (exclusion constraint).
BEGIN;

CREATE TYPE "AttendanceStatus" AS ENUM ('OPEN', 'CLOSED', 'MISSING_OUT', 'VOID');
CREATE TYPE "AttendanceSource" AS ENUM ('SELF', 'HR', 'CORRECTION');
CREATE TYPE "AttendanceChangeKind" AS ENUM ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END', 'HR_RECORDED', 'CORRECTED', 'MARKED_MISSING_OUT', 'VOIDED');
CREATE TYPE "CorrectionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED');

-- ---------------------------------------------------------------------------
-- 1. Records
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "outlet_id" UUID,
  "shift_id" UUID,
  "clock_in_at" TIMESTAMPTZ(6) NOT NULL,
  "clock_out_at" TIMESTAMPTZ(6),
  "status" "AttendanceStatus" NOT NULL,
  -- Unpaid break time set by HR or a correction; NULL = the sum of the break rows.
  "break_minutes" INTEGER,
  "in_source" "AttendanceSource" NOT NULL,
  "out_source" "AttendanceSource",
  -- Device details of self punches, for HR review; removed after 90 days (app_remove_old_attendance_device_data).
  "in_ip" TEXT,
  "in_user_agent" TEXT,
  "out_ip" TEXT,
  "out_user_agent" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_records_state_check" CHECK (CASE "status"
    WHEN 'OPEN' THEN "clock_out_at" IS NULL AND "out_source" IS NULL
    WHEN 'MISSING_OUT' THEN "clock_out_at" IS NULL AND "out_source" IS NULL
    WHEN 'CLOSED' THEN "clock_out_at" > "clock_in_at" AND "clock_out_at" - "clock_in_at" <= INTERVAL '24 hours' AND "out_source" IS NOT NULL
    ELSE "clock_out_at" IS NULL OR "clock_out_at" > "clock_in_at" END),
  CONSTRAINT "attendance_records_break_check" CHECK ("break_minutes" IS NULL OR ("break_minutes" >= 0
    AND ("clock_out_at" IS NULL OR "break_minutes" * INTERVAL '1 minute' < "clock_out_at" - "clock_in_at"))),
  CONSTRAINT "attendance_records_device_check" CHECK (("in_ip" IS NULL OR char_length("in_ip") <= 64) AND ("out_ip" IS NULL OR char_length("out_ip") <= 64)
    AND ("in_user_agent" IS NULL OR char_length("in_user_agent") <= 400) AND ("out_user_agent" IS NULL OR char_length("out_user_agent") <= 400)),
  CONSTRAINT "attendance_records_no_overlap" EXCLUDE USING gist ("employee_id" WITH =, tstzrange("clock_in_at", COALESCE("clock_out_at", 'infinity')) WITH &&)
    WHERE ("status" IN ('OPEN', 'CLOSED'))
);
CREATE UNIQUE INDEX "attendance_records_organization_id_id_key" ON "attendance_records"("organization_id", "id");
CREATE UNIQUE INDEX "attendance_records_organization_id_id_employee_id_key" ON "attendance_records"("organization_id", "id", "employee_id");
CREATE UNIQUE INDEX "attendance_records_one_open_key" ON "attendance_records"("employee_id") WHERE "status" = 'OPEN';
CREATE INDEX "attendance_records_organization_id_clock_in_at_idx" ON "attendance_records"("organization_id", "clock_in_at");
CREATE INDEX "attendance_records_organization_id_employee_id_clock_in_at_idx" ON "attendance_records"("organization_id", "employee_id", "clock_in_at");
CREATE INDEX "attendance_records_organization_id_shift_id_idx" ON "attendance_records"("organization_id", "shift_id");
ALTER TABLE "attendance_records"
  ADD CONSTRAINT "attendance_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_records_organization_id_employee_id_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_records_organization_id_outlet_id_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The shift must be one of the same employee's.
  ADD CONSTRAINT "attendance_records_shift_fkey" FOREIGN KEY ("organization_id", "shift_id", "employee_id") REFERENCES "shifts"("organization_id", "id", "employee_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Breaks (belong to a record of the same employee)
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_breaks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "record_id" UUID NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6),
  CONSTRAINT "attendance_breaks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_breaks_period_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "attendance_breaks_no_overlap" EXCLUDE USING gist ("record_id" WITH =, tstzrange("starts_at", COALESCE("ends_at", 'infinity')) WITH &&)
);
CREATE UNIQUE INDEX "attendance_breaks_one_open_key" ON "attendance_breaks"("record_id") WHERE "ends_at" IS NULL;
CREATE INDEX "attendance_breaks_organization_id_record_id_idx" ON "attendance_breaks"("organization_id", "record_id");
ALTER TABLE "attendance_breaks"
  ADD CONSTRAINT "attendance_breaks_record_fkey" FOREIGN KEY ("organization_id", "record_id", "employee_id") REFERENCES "attendance_records"("organization_id", "id", "employee_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Correction requests
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_correction_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  -- NULL: "I forgot to clock in at all; please add this period".
  "record_id" UUID,
  "proposed_clock_in_at" TIMESTAMPTZ(6) NOT NULL,
  "proposed_clock_out_at" TIMESTAMPTZ(6) NOT NULL,
  "proposed_break_minutes" INTEGER,
  "reason" TEXT NOT NULL,
  "status" "CorrectionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" UUID,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_correction_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_correction_requests_period_check" CHECK ("proposed_clock_out_at" > "proposed_clock_in_at"
    AND "proposed_clock_out_at" - "proposed_clock_in_at" <= INTERVAL '24 hours'),
  CONSTRAINT "attendance_correction_requests_break_check" CHECK ("proposed_break_minutes" IS NULL OR ("proposed_break_minutes" >= 0
    AND "proposed_break_minutes" * INTERVAL '1 minute' < "proposed_clock_out_at" - "proposed_clock_in_at")),
  CONSTRAINT "attendance_correction_requests_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500 AND "reason" = btrim("reason")),
  CONSTRAINT "attendance_correction_requests_decision_check" CHECK (
    ("status" IN ('APPROVED', 'REJECTED')) = ("decided_at" IS NOT NULL)
    AND ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL)
    AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX "attendance_correction_requests_organization_id_id_key" ON "attendance_correction_requests"("organization_id", "id");
CREATE UNIQUE INDEX "attendance_correction_requests_one_pending_key" ON "attendance_correction_requests"("record_id") WHERE "status" = 'PENDING' AND "record_id" IS NOT NULL;
CREATE INDEX "attendance_correction_requests_organization_id_status_idx" ON "attendance_correction_requests"("organization_id", "status", "created_at");
CREATE INDEX "attendance_correction_requests_organization_id_employee_id_idx" ON "attendance_correction_requests"("organization_id", "employee_id", "created_at");
ALTER TABLE "attendance_correction_requests"
  ADD CONSTRAINT "attendance_correction_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_correction_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- The record must be one of the same employee's.
  ADD CONSTRAINT "attendance_correction_requests_record_fkey" FOREIGN KEY ("organization_id", "record_id", "employee_id") REFERENCES "attendance_records"("organization_id", "id", "employee_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_correction_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_correction_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. History: one row for every change of a record, written by a trigger (it cannot be skipped)
-- ---------------------------------------------------------------------------
CREATE TABLE "attendance_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "record_id" UUID NOT NULL,
  "kind" "AttendanceChangeKind" NOT NULL,
  -- Times, status, outlet, shift and break minutes before / after. Never device details.
  "before" JSONB,
  "after" JSONB NOT NULL,
  "reason" TEXT,
  "request_id" UUID,
  -- The person changed their own attendance (HR correcting themselves, or deciding their own request as the
  -- only HR person): shown in the review screen.
  "self_edit" BOOLEAN NOT NULL DEFAULT false,
  "changed_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "attendance_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_changes_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500)
);
CREATE INDEX "attendance_changes_organization_id_record_id_idx" ON "attendance_changes"("organization_id", "record_id", "created_at");
ALTER TABLE "attendance_changes"
  ADD CONSTRAINT "attendance_changes_record_fkey" FOREIGN KEY ("organization_id", "record_id", "employee_id") REFERENCES "attendance_records"("organization_id", "id", "employee_id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_changes_request_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "attendance_correction_requests"("organization_id", "id") ON DELETE SET NULL ("request_id") ON UPDATE CASCADE,
  ADD CONSTRAINT "attendance_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- History rows never change (only the person reference may be cleared when a user is removed).
CREATE FUNCTION "block_attendance_change_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'changed_by_id' - 'request_id') IS DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id' - 'request_id')
     OR (NEW."changed_by_id" IS NOT NULL AND NEW."changed_by_id" IS DISTINCT FROM OLD."changed_by_id")
     OR (NEW."request_id" IS NOT NULL AND NEW."request_id" IS DISTINCT FROM OLD."request_id") THEN
    RAISE EXCEPTION 'attendance_changes is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "attendance_changes_append_only" BEFORE UPDATE ON "attendance_changes" FOR EACH ROW EXECUTE FUNCTION "block_attendance_change_updates"();
CREATE FUNCTION "block_attendance_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "attendance_changes_no_truncate" BEFORE TRUNCATE ON "attendance_changes" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();
CREATE TRIGGER "attendance_records_no_truncate" BEFORE TRUNCATE ON "attendance_records" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();

CREATE FUNCTION "att_snapshot"(r "attendance_records") RETURNS JSONB AS $$
  SELECT jsonb_build_object('clock_in_at', r."clock_in_at", 'clock_out_at', r."clock_out_at", 'status', r."status",
                            'outlet_id', r."outlet_id", 'shift_id', r."shift_id", 'break_minutes', r."break_minutes");
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

-- Before a record changes: allowed transitions only, device details only ever cleared, fixed fields fixed.
-- The kind of change is stated by the function making it (transaction-local setting app.att_kind).
CREATE FUNCTION "guard_attendance_record"() RETURNS trigger AS $$
DECLARE
  v_kind TEXT := NULLIF(current_setting('app.att_kind', true), '');
  v_ok BOOLEAN;
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'attendance_fixed_fields' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW."in_ip" IS NOT NULL AND NEW."in_ip" IS DISTINCT FROM OLD."in_ip")
     OR (NEW."in_user_agent" IS NOT NULL AND NEW."in_user_agent" IS DISTINCT FROM OLD."in_user_agent")
     OR (NEW."out_ip" IS NOT NULL AND NEW."out_ip" IS DISTINCT FROM OLD."out_ip" AND NOT (OLD."status" = 'OPEN' AND v_kind = 'CLOCK_OUT'))
     OR (NEW."out_user_agent" IS NOT NULL AND NEW."out_user_agent" IS DISTINCT FROM OLD."out_user_agent" AND NOT (OLD."status" = 'OPEN' AND v_kind = 'CLOCK_OUT')) THEN
    RAISE EXCEPTION 'attendance_device_fields' USING ERRCODE = 'P0001';
  END IF;
  IF "att_snapshot"(NEW) IS NOT DISTINCT FROM "att_snapshot"(OLD) AND v_kind IS NULL THEN
    RETURN NEW; -- only device details cleared (retention)
  END IF;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'attendance_change_without_kind' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'VOID' THEN
    RAISE EXCEPTION 'attendance_void' USING ERRCODE = 'P0001';
  END IF;
  v_ok := CASE v_kind
      WHEN 'CLOCK_OUT' THEN OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' AND NEW."clock_in_at" = OLD."clock_in_at"
      WHEN 'MARKED_MISSING_OUT' THEN OLD."status" = 'OPEN' AND NEW."status" = 'MISSING_OUT' AND NEW."clock_in_at" = OLD."clock_in_at"
      WHEN 'BREAK_START' THEN OLD."status" = 'OPEN' AND "att_snapshot"(NEW) = "att_snapshot"(OLD)
      WHEN 'BREAK_END' THEN OLD."status" = 'OPEN' AND "att_snapshot"(NEW) = "att_snapshot"(OLD)
      WHEN 'CORRECTED' THEN (NEW."status" = 'CLOSED') OR (OLD."status" = 'OPEN' AND NEW."status" = 'OPEN')
      WHEN 'VOIDED' THEN NEW."status" = 'VOID'
      ELSE false END;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'attendance_bad_transition' USING ERRCODE = 'P0001';
  END IF;
  NEW."version" := OLD."version" + 1;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "attendance_records_guard" BEFORE UPDATE ON "attendance_records" FOR EACH ROW EXECUTE FUNCTION "guard_attendance_record"();

-- After a record is created or changed: the history row.
CREATE FUNCTION "record_attendance_change"() RETURNS trigger AS $$
DECLARE
  v_kind TEXT := NULLIF(current_setting('app.att_kind', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND v_kind IS NULL THEN
    RETURN NULL; -- device details cleared only (the guard refused anything else without a kind)
  END IF;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'attendance_change_without_kind' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO "attendance_changes" ("organization_id", "employee_id", "record_id", "kind", "before", "after", "reason", "request_id", "self_edit", "changed_by_id")
  VALUES (NEW."organization_id", NEW."employee_id", NEW."id", v_kind::"AttendanceChangeKind",
          CASE WHEN TG_OP = 'UPDATE' THEN "att_snapshot"(OLD) END, "att_snapshot"(NEW),
          NULLIF(current_setting('app.att_reason', true), ''),
          NULLIF(current_setting('app.att_request', true), '')::UUID,
          COALESCE(NULLIF(current_setting('app.att_self', true), ''), 'false')::BOOLEAN,
          "app_user_id"());
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "attendance_records_history" AFTER INSERT OR UPDATE ON "attendance_records" FOR EACH ROW EXECUTE FUNCTION "record_attendance_change"();

-- ---------------------------------------------------------------------------
-- 5. Internal helpers (owner's rights, NOT callable by the app account)
-- ---------------------------------------------------------------------------
-- States the kind / reason / request / self-edit of the next change, for the two triggers above.
CREATE FUNCTION "att_say"(p_kind TEXT, p_reason TEXT DEFAULT NULL, p_request UUID DEFAULT NULL, p_self BOOLEAN DEFAULT false) RETURNS void AS $$
  SELECT set_config('app.att_kind', COALESCE(p_kind, ''), true), set_config('app.att_reason', COALESCE(p_reason, ''), true),
         set_config('app.att_request', COALESCE(p_request::TEXT, ''), true), set_config('app.att_self', COALESCE(p_self, false)::TEXT, true);
$$ LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- The employee row (share-locked) and then the per-employee attendance lock. Always in this order.
CREATE FUNCTION "att_lock_employee"(p_org UUID, p_employee UUID) RETURNS "employees" AS $$
DECLARE
  v_emp "employees";
BEGIN
  SELECT e.* INTO v_emp FROM "employees" e WHERE e."id" = p_employee AND e."organization_id" = p_org FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('attendance:' || p_org::TEXT || ':' || p_employee::TEXT, 0));
  RETURN v_emp;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Can the employee work on the local day of p_at? Active, or marked as left with a last day not before it.
CREATE FUNCTION "att_can_work_on"(p_emp "employees", p_at TIMESTAMPTZ, p_tz TEXT) RETURNS BOOLEAN AS $$
  SELECT (p_at AT TIME ZONE p_tz)::date >= p_emp."joined_on"
     AND (p_emp."status" = 'ACTIVE' OR (p_emp."exited_on" IS NOT NULL AND (p_at AT TIME ZONE p_tz)::date <= p_emp."exited_on"));
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- A period recorded by HR or a correction: in the past, within employment, at most 24 hours, break shorter.
CREATE FUNCTION "att_check_period"(p_emp "employees", p_tz TEXT, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ, p_break INTEGER) RETURNS void AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_in IS NULL OR p_in > v_now OR (p_out IS NOT NULL AND (p_out <= p_in OR p_out > v_now OR p_out - p_in > INTERVAL '24 hours')) THEN
    RAISE EXCEPTION 'attendance_bad_period' USING ERRCODE = 'P0001';
  END IF;
  IF NOT "att_can_work_on"(p_emp, p_in, p_tz) OR (p_out IS NOT NULL AND NOT "att_can_work_on"(p_emp, p_out - INTERVAL '1 microsecond', p_tz)) THEN
    RAISE EXCEPTION 'attendance_outside_employment' USING ERRCODE = 'P0001';
  END IF;
  IF p_break IS NOT NULL AND (p_break < 0 OR p_out IS NULL OR p_break * INTERVAL '1 minute' >= p_out - p_in) THEN
    RAISE EXCEPTION 'attendance_bad_break' USING ERRCODE = 'P0001';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- The planned shift a clock-in at p_at belongs to: from 2 hours before its start until its end; nearest start.
CREATE FUNCTION "att_match_shift"(p_org UUID, p_employee UUID, p_at TIMESTAMPTZ) RETURNS "shifts" AS $$
  SELECT s.* FROM "shifts" s
  WHERE s."organization_id" = p_org AND s."employee_id" = p_employee AND s."status" = 'PLANNED'
    AND p_at >= s."starts_at" - INTERVAL '2 hours' AND p_at < s."ends_at"
  ORDER BY abs(extract(epoch FROM p_at - s."starts_at")), s."starts_at"
  LIMIT 1;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- An OPEN record left behind: more than 20 hours old, or more than 4 hours past the end of its shift.
CREATE FUNCTION "att_is_abandoned"(p_rec "attendance_records", p_now TIMESTAMPTZ) RETURNS BOOLEAN AS $$
  SELECT p_now - p_rec."clock_in_at" > INTERVAL '20 hours'
      OR EXISTS (SELECT 1 FROM "shifts" s WHERE s."id" = p_rec."shift_id" AND p_now > s."ends_at" + INTERVAL '4 hours');
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Device details as given by the app: a valid IP address (normalised) or nothing; a user agent without control
-- characters, at most 400 characters.
CREATE FUNCTION "att_clean_ip"(p_ip TEXT) RETURNS TEXT AS $$
BEGIN
  RETURN CASE WHEN p_ip IS NULL OR btrim(p_ip) = '' THEN NULL ELSE host(btrim(p_ip)::inet) END;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;
CREATE FUNCTION "att_clean_agent"(p_agent TEXT) RETURNS TEXT AS $$
  SELECT NULLIF(left(btrim(regexp_replace(COALESCE(p_agent, ''), '[[:cntrl:]]', ' ', 'g')), 400), '');
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp;

-- The signed-in employee's own record for self-service, locked. Raises unless they may clock.
CREATE FUNCTION "att_me"() RETURNS "employees" AS $$
DECLARE
  v_org UUID := "app_org_id"();
  v_id UUID := "app_my_employee_id"();
BEGIN
  IF "app_staff_role"() IS NULL OR NOT "app_has_permission"('self:attendance_clock') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'no_employee_record' USING ERRCODE = 'P0001';
  END IF;
  RETURN "att_lock_employee"(v_org, v_id);
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "att_require_hr"() RETURNS UUID AS $$
BEGIN
  IF "app_staff_role"() IS NULL OR NOT "app_has_permission"('attendance:manage') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN "app_org_id"();
END;
$$ LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp;

-- Pending requests about a record that has just been changed by someone else are no longer valid.
CREATE FUNCTION "att_supersede_requests"(p_org UUID, p_record UUID, p_except UUID DEFAULT NULL) RETURNS void AS $$
  UPDATE "attendance_correction_requests" SET "status" = 'SUPERSEDED', "updated_at" = clock_timestamp()
  WHERE "organization_id" = p_org AND "record_id" = p_record AND "status" = 'PENDING' AND "id" IS DISTINCT FROM p_except;
$$ LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- Applies a correction to a record (direct by HR, or an approved request). The record is locked by the caller.
CREATE FUNCTION "att_apply_correction"(p_rec "attendance_records", p_emp "employees", p_tz TEXT, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ,
                                       p_outlet UUID, p_set_break BOOLEAN, p_break INTEGER, p_reason TEXT, p_request UUID, p_self BOOLEAN)
RETURNS void AS $$
DECLARE
  v_shift "shifts";
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
  v_shift := "att_match_shift"(p_rec."organization_id", p_rec."employee_id", p_in);
  PERFORM "att_say"('CORRECTED', p_reason, p_request, p_self);
  BEGIN
    UPDATE "attendance_records" SET
      "clock_in_at" = p_in, "clock_out_at" = p_out,
      "status" = CASE WHEN p_out IS NULL THEN 'OPEN' ELSE 'CLOSED' END::"AttendanceStatus",
      "outlet_id" = COALESCE(p_outlet, "outlet_id"),
      "shift_id" = v_shift."id",
      "break_minutes" = CASE WHEN p_set_break THEN p_break ELSE "break_minutes" END,
      "in_source" = CASE WHEN p_in IS DISTINCT FROM p_rec."clock_in_at" THEN 'CORRECTION' ELSE "in_source" END::"AttendanceSource",
      "out_source" = CASE WHEN p_out IS NULL THEN NULL WHEN p_out IS DISTINCT FROM p_rec."clock_out_at" THEN 'CORRECTION' ELSE "out_source" END::"AttendanceSource"
    WHERE "id" = p_rec."id";
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'attendance_overlap' USING ERRCODE = 'P0001';
  END;
  -- Breaks recorded on the old times no longer apply once break minutes are set; a break outside the new
  -- period without minutes set is refused (HR must give the break minutes then).
  IF NOT p_set_break AND EXISTS (SELECT 1 FROM "attendance_breaks" b WHERE b."record_id" = p_rec."id"
       AND (b."starts_at" < p_in OR (p_out IS NOT NULL AND COALESCE(b."ends_at", 'infinity') > p_out))) THEN
    RAISE EXCEPTION 'attendance_breaks_outside' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "att_supersede_requests"(p_rec."organization_id", p_rec."id", p_request);
  PERFORM "att_say"(NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 6. Entry points for the app
-- ---------------------------------------------------------------------------
-- Clock in now. Returns the new record's id. An OPEN record that was left behind is marked MISSING_OUT first;
-- one that is still current refuses the clock-in.
CREATE FUNCTION "app_clock_in"(p_ip TEXT, p_user_agent TEXT) RETURNS UUID AS $$
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

-- Clock out now. Returns 'closed', or 'missing_out' when the OPEN record had been left behind (it is then marked
-- MISSING_OUT and the employee asks for a correction).
CREATE FUNCTION "app_clock_out"(p_ip TEXT, p_user_agent TEXT) RETURNS TEXT AS $$
DECLARE
  v_emp "employees" := "att_me"();
  v_org UUID := v_emp."organization_id";
  v_now TIMESTAMPTZ := clock_timestamp();
  v_open "attendance_records";
BEGIN
  SELECT r.* INTO v_open FROM "attendance_records" r WHERE r."organization_id" = v_org AND r."employee_id" = v_emp."id" AND r."status" = 'OPEN' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_clocked_in' USING ERRCODE = 'P0001';
  END IF;
  IF "att_is_abandoned"(v_open, v_now) THEN
    PERFORM "att_say"('MARKED_MISSING_OUT', NULL, NULL, false);
    UPDATE "attendance_records" SET "status" = 'MISSING_OUT' WHERE "id" = v_open."id";
    PERFORM "att_say"(NULL);
    RETURN 'missing_out';
  END IF;
  UPDATE "attendance_breaks" SET "ends_at" = v_now WHERE "record_id" = v_open."id" AND "ends_at" IS NULL;
  PERFORM "att_say"('CLOCK_OUT', NULL, NULL, false);
  UPDATE "attendance_records" SET "status" = 'CLOSED', "clock_out_at" = v_now, "out_source" = 'SELF',
         "out_ip" = "att_clean_ip"(p_ip), "out_user_agent" = "att_clean_agent"(p_user_agent)
  WHERE "id" = v_open."id";
  PERFORM "att_say"(NULL);
  RETURN 'closed';
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Start / end a break on the current OPEN record (at most 10 breaks per record).
CREATE FUNCTION "app_break"(p_start BOOLEAN) RETURNS void AS $$
DECLARE
  v_emp "employees" := "att_me"();
  v_org UUID := v_emp."organization_id";
  v_now TIMESTAMPTZ := clock_timestamp();
  v_open "attendance_records";
BEGIN
  SELECT r.* INTO v_open FROM "attendance_records" r WHERE r."organization_id" = v_org AND r."employee_id" = v_emp."id" AND r."status" = 'OPEN' FOR UPDATE;
  IF NOT FOUND OR "att_is_abandoned"(v_open, v_now) THEN
    RAISE EXCEPTION 'not_clocked_in' USING ERRCODE = 'P0001';
  END IF;
  IF p_start THEN
    IF EXISTS (SELECT 1 FROM "attendance_breaks" b WHERE b."record_id" = v_open."id" AND b."ends_at" IS NULL) THEN
      RAISE EXCEPTION 'already_on_break' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM "attendance_breaks" b WHERE b."record_id" = v_open."id") >= 10 THEN
      RAISE EXCEPTION 'too_many_breaks' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO "attendance_breaks" ("organization_id", "employee_id", "record_id", "starts_at") VALUES (v_org, v_emp."id", v_open."id", v_now);
  ELSE
    UPDATE "attendance_breaks" SET "ends_at" = v_now WHERE "record_id" = v_open."id" AND "ends_at" IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_on_break' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  PERFORM "att_say"(CASE WHEN p_start THEN 'BREAK_START' ELSE 'BREAK_END' END, NULL, NULL, false);
  UPDATE "attendance_records" SET "updated_at" = v_now WHERE "id" = v_open."id"; -- history row; version +1
  PERFORM "att_say"(NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Ask HR to correct one of my records (CLOSED or MISSING_OUT), or to add a period I forgot (p_record NULL).
-- At most 31 days back, never in the future, one pending request per record, at most 10 pending in all.
CREATE FUNCTION "app_request_attendance_correction"(p_record UUID, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ, p_break INTEGER, p_reason TEXT) RETURNS UUID AS $$
DECLARE
  v_emp "employees" := "att_me"();
  v_org UUID := v_emp."organization_id";
  v_tz TEXT := "att_org_timezone"(v_org);
  v_now TIMESTAMPTZ := clock_timestamp();
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  v_id UUID;
BEGIN
  IF p_record IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "attendance_records" r WHERE r."id" = p_record AND r."organization_id" = v_org
       AND r."employee_id" = v_emp."id" AND r."status" IN ('CLOSED', 'MISSING_OUT')) THEN
    RAISE EXCEPTION 'record_not_correctable' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_out IS NULL OR p_in < v_now - INTERVAL '31 days' THEN
    RAISE EXCEPTION 'attendance_bad_period' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "att_check_period"(v_emp, v_tz, p_in, p_out, p_break);
  IF (SELECT count(*) FROM "attendance_correction_requests" q WHERE q."organization_id" = v_org AND q."employee_id" = v_emp."id" AND q."status" = 'PENDING') >= 10 THEN
    RAISE EXCEPTION 'too_many_requests' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    INSERT INTO "attendance_correction_requests" ("organization_id", "employee_id", "record_id", "proposed_clock_in_at", "proposed_clock_out_at",
                                                  "proposed_break_minutes", "reason", "requested_by_id")
    VALUES (v_org, v_emp."id", p_record, p_in, p_out, p_break, v_reason, "app_user_id"())
    RETURNING "id" INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'request_pending' USING ERRCODE = 'P0001';
  END;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION "app_withdraw_attendance_correction"(p_request UUID) RETURNS void AS $$
DECLARE
  v_emp "employees" := "att_me"();
BEGIN
  UPDATE "attendance_correction_requests" SET "status" = 'WITHDRAWN', "updated_at" = clock_timestamp()
  WHERE "id" = p_request AND "organization_id" = v_emp."organization_id" AND "employee_id" = v_emp."id" AND "status" = 'PENDING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR: record a period for anyone (e.g. staff without a login), or open one now (p_out NULL, employee not clocked in).
CREATE FUNCTION "app_hr_record_attendance"(p_employee UUID, p_outlet UUID, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ, p_break INTEGER, p_reason TEXT) RETURNS UUID AS $$
DECLARE
  v_org UUID := "att_require_hr"();
  v_emp "employees";
  v_tz TEXT;
  v_shift "shifts";
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_id UUID;
BEGIN
  v_emp := "att_lock_employee"(v_org, p_employee);
  v_tz := "att_org_timezone"(v_org);
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_too_long' USING ERRCODE = 'P0001';
  END IF;
  PERFORM "att_check_period"(v_emp, v_tz, p_in, p_out, p_break);
  IF p_out IS NULL AND NOT "att_can_work_on"(v_emp, clock_timestamp(), v_tz) THEN
    RAISE EXCEPTION 'employee_not_active' USING ERRCODE = 'P0001';
  END IF;
  IF p_outlet IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "outlets" o WHERE o."id" = p_outlet AND o."organization_id" = v_org) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_shift := "att_match_shift"(v_org, v_emp."id", p_in);
  PERFORM "att_say"('HR_RECORDED', v_reason, NULL, COALESCE(v_emp."id" = "app_my_employee_id"(), false));
  BEGIN
    INSERT INTO "attendance_records" ("organization_id", "employee_id", "outlet_id", "shift_id", "clock_in_at", "clock_out_at", "status",
                                      "break_minutes", "in_source", "out_source")
    VALUES (v_org, v_emp."id", COALESCE(p_outlet, v_shift."outlet_id", v_emp."outlet_id"), v_shift."id", p_in, p_out,
            CASE WHEN p_out IS NULL THEN 'OPEN' ELSE 'CLOSED' END::"AttendanceStatus",
            p_break, 'HR', CASE WHEN p_out IS NULL THEN NULL ELSE 'HR' END::"AttendanceSource")
    RETURNING "id" INTO v_id;
  EXCEPTION WHEN exclusion_violation OR unique_violation THEN
    RAISE EXCEPTION 'attendance_overlap' USING ERRCODE = 'P0001';
  END;
  PERFORM "att_say"(NULL);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR: correct a record directly, with a reason. p_set_break: whether p_break (NULL = use the break rows) is set.
CREATE FUNCTION "app_hr_correct_attendance"(p_record UUID, p_in TIMESTAMPTZ, p_out TIMESTAMPTZ, p_outlet UUID, p_set_break BOOLEAN, p_break INTEGER, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "att_require_hr"();
  v_employee UUID;
  v_emp "employees";
  v_rec "attendance_records";
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT r."employee_id" INTO v_employee FROM "attendance_records" r WHERE r."id" = p_record AND r."organization_id" = v_org;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_emp := "att_lock_employee"(v_org, v_employee);
  SELECT r.* INTO v_rec FROM "attendance_records" r WHERE r."id" = p_record AND r."organization_id" = v_org FOR UPDATE;
  PERFORM "att_apply_correction"(v_rec, v_emp, "att_org_timezone"(v_org), p_in, p_out, p_outlet, COALESCE(p_set_break, false), p_break,
                                 v_reason, NULL, COALESCE(v_emp."id" = "app_my_employee_id"(), false));
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR: void a record created by mistake (kept, never counted), with a reason.
CREATE FUNCTION "app_hr_void_attendance"(p_record UUID, p_reason TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "att_require_hr"();
  v_employee UUID;
  v_emp "employees";
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT r."employee_id" INTO v_employee FROM "attendance_records" r WHERE r."id" = p_record AND r."organization_id" = v_org;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_emp := "att_lock_employee"(v_org, v_employee);
  PERFORM 1 FROM "attendance_records" r WHERE r."id" = p_record FOR UPDATE;
  UPDATE "attendance_breaks" SET "ends_at" = GREATEST(clock_timestamp(), "starts_at" + INTERVAL '1 microsecond')
  WHERE "record_id" = p_record AND "ends_at" IS NULL;
  PERFORM "att_say"('VOIDED', v_reason, NULL, COALESCE(v_emp."id" = "app_my_employee_id"(), false));
  UPDATE "attendance_records" SET "status" = 'VOID' WHERE "id" = p_record;
  PERFORM "att_supersede_requests"(v_org, p_record);
  PERFORM "att_say"(NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- HR: approve or reject a correction request. Nobody decides their own request, unless they are the only person
-- in the organisation who manages attendance (then the change is marked as a self-edit).
CREATE FUNCTION "app_decide_attendance_correction"(p_request UUID, p_approve BOOLEAN, p_note TEXT) RETURNS void AS $$
DECLARE
  v_org UUID := "att_require_hr"();
  v_employee UUID;
  v_emp "employees";
  v_req "attendance_correction_requests";
  v_rec "attendance_records";
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_self BOOLEAN;
  v_shift "shifts";
  v_tz TEXT := "att_org_timezone"(v_org);
BEGIN
  IF p_approve IS NULL OR (v_note IS NOT NULL AND char_length(v_note) > 500) OR (NOT p_approve AND v_note IS NULL) THEN
    RAISE EXCEPTION 'decision_note_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT q."employee_id" INTO v_employee FROM "attendance_correction_requests" q WHERE q."id" = p_request AND q."organization_id" = v_org;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_emp := "att_lock_employee"(v_org, v_employee);
  SELECT q.* INTO v_req FROM "attendance_correction_requests" q WHERE q."id" = p_request AND q."organization_id" = v_org FOR UPDATE;
  IF v_req."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'P0001';
  END IF;
  v_self := COALESCE(v_emp."id" = "app_my_employee_id"(), false);
  IF v_self AND EXISTS (
       SELECT 1 FROM "organization_members" om
       JOIN "users" u ON u."id" = om."user_id"
       JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
       JOIN "role_permissions" rp ON rp."role_id" = omr."role_id"
       JOIN "permissions" p ON p."id" = rp."permission_id" AND p."key" = 'attendance:manage'
       WHERE om."organization_id" = v_org AND om."status" = 'ACTIVE' AND u."status" = 'ACTIVE' AND om."user_id" <> "app_user_id"()) THEN
    RAISE EXCEPTION 'own_request' USING ERRCODE = 'P0001';
  END IF;
  IF p_approve THEN
    IF v_req."record_id" IS NOT NULL THEN
      SELECT r.* INTO v_rec FROM "attendance_records" r WHERE r."id" = v_req."record_id" FOR UPDATE;
      PERFORM "att_apply_correction"(v_rec, v_emp, v_tz, v_req."proposed_clock_in_at", v_req."proposed_clock_out_at", NULL,
                                     v_req."proposed_break_minutes" IS NOT NULL, v_req."proposed_break_minutes", v_req."reason", v_req."id", v_self);
    ELSE
      PERFORM "att_check_period"(v_emp, v_tz, v_req."proposed_clock_in_at", v_req."proposed_clock_out_at", v_req."proposed_break_minutes");
      v_shift := "att_match_shift"(v_org, v_emp."id", v_req."proposed_clock_in_at");
      PERFORM "att_say"('CORRECTED', v_req."reason", v_req."id", v_self);
      BEGIN
        INSERT INTO "attendance_records" ("organization_id", "employee_id", "outlet_id", "shift_id", "clock_in_at", "clock_out_at", "status",
                                          "break_minutes", "in_source", "out_source")
        VALUES (v_org, v_emp."id", COALESCE(v_shift."outlet_id", v_emp."outlet_id"), v_shift."id", v_req."proposed_clock_in_at", v_req."proposed_clock_out_at",
                'CLOSED', v_req."proposed_break_minutes", 'CORRECTION', 'CORRECTION');
      EXCEPTION WHEN exclusion_violation THEN
        RAISE EXCEPTION 'attendance_overlap' USING ERRCODE = 'P0001';
      END;
      PERFORM "att_say"(NULL);
    END IF;
  END IF;
  UPDATE "attendance_correction_requests" SET
    "status" = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END::"CorrectionRequestStatus",
    "decided_by_id" = "app_user_id"(), "decided_at" = clock_timestamp(), "decision_note" = v_note, "updated_at" = clock_timestamp()
  WHERE "id" = v_req."id";
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- Housekeeping (maintenance mode only): remove device details of punches older than p_days (at least 30).
CREATE FUNCTION "app_remove_old_attendance_device_data"(p_days INTEGER) RETURNS INTEGER AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF "app_mode"() IS DISTINCT FROM 'maintenance' OR p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM "att_say"(NULL);
  UPDATE "attendance_records" SET "in_ip" = NULL, "in_user_agent" = NULL, "out_ip" = NULL, "out_user_agent" = NULL
  WHERE "clock_in_at" < clock_timestamp() - p_days * INTERVAL '1 day'
    AND ("in_ip" IS NOT NULL OR "in_user_agent" IS NOT NULL OR "out_ip" IS NOT NULL OR "out_user_agent" IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;

-- ---------------------------------------------------------------------------
-- 7. Row-level security: read only. HR of the organisation reads all; an employee reads their own.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_records', 'attendance_breaks', 'attendance_changes', 'attendance_correction_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "hr_reads" ON %I FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"(''attendance:read'')))', t);
    EXECUTE format('CREATE POLICY "own_rows" ON %I FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND "employee_id" = (SELECT "app_my_employee_id"()))', t);
    -- New tables inherit broad default rights: start from none, then reading only.
    EXECUTE format('REVOKE ALL ON %I FROM hr_runtime', t);
    EXECUTE format('GRANT SELECT ON %I TO hr_runtime', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Execution rights
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION "block_attendance_change_updates"(), "block_attendance_truncate"(), "att_snapshot"("attendance_records"),
  "guard_attendance_record"(), "record_attendance_change"(), "att_say"(TEXT, TEXT, UUID, BOOLEAN), "att_lock_employee"(UUID, UUID),
  "att_can_work_on"("employees", TIMESTAMPTZ, TEXT), "att_check_period"("employees", TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER),
  "att_match_shift"(UUID, UUID, TIMESTAMPTZ), "att_is_abandoned"("attendance_records", TIMESTAMPTZ), "att_clean_ip"(TEXT), "att_clean_agent"(TEXT),
  "att_me"(), "att_require_hr"(), "att_supersede_requests"(UUID, UUID, UUID),
  "att_apply_correction"("attendance_records", "employees", TEXT, TIMESTAMPTZ, TIMESTAMPTZ, UUID, BOOLEAN, INTEGER, TEXT, UUID, BOOLEAN),
  "app_clock_in"(TEXT, TEXT), "app_clock_out"(TEXT, TEXT), "app_break"(BOOLEAN),
  "app_request_attendance_correction"(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT), "app_withdraw_attendance_correction"(UUID),
  "app_hr_record_attendance"(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT),
  "app_hr_correct_attendance"(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, BOOLEAN, INTEGER, TEXT), "app_hr_void_attendance"(UUID, TEXT),
  "app_decide_attendance_correction"(UUID, BOOLEAN, TEXT), "app_remove_old_attendance_device_data"(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  "app_clock_in"(TEXT, TEXT), "app_clock_out"(TEXT, TEXT), "app_break"(BOOLEAN),
  "app_request_attendance_correction"(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT), "app_withdraw_attendance_correction"(UUID),
  "app_hr_record_attendance"(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT),
  "app_hr_correct_attendance"(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID, BOOLEAN, INTEGER, TEXT), "app_hr_void_attendance"(UUID, TEXT),
  "app_decide_attendance_correction"(UUID, BOOLEAN, TEXT), "app_remove_old_attendance_device_data"(INTEGER) TO hr_runtime;
-- NOT granted: the att_* helpers (several take an organisation or employee id and trust it) and the triggers.

COMMIT;
