-- Leave, part 1 of 2: leave types, holidays, the balance ledger and leave requests (tables, rights, seeding).
-- Design: docs/superpowers/specs/2026-11-21-leave-design.md. The functions that write the ledger and the requests come
-- in 20261123000100_leave_functions; until then nobody can write either table.
--   * leave:manage (new permission): set up leave types, holidays and balance adjustments. SUPER_ADMIN and HR_MANAGER.
--   * leave_types: per organisation, numbers are settings HR enters. Five are seeded for every organisation with 0 days
--     and "not configured" (only Unpaid works at once); no statutory number is guessed.
--   * holidays: for the whole organisation or one outlet.
--   * leave_ledger: every change to a balance is one line (grant, monthly accrual, taken, restored, adjustment,
--     carry-over, expired); the balance is the sum. Append-only, written only by the database's functions.
--   * leave_requests: no two active (pending or approved) requests of one person overlap.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "key", "module", "description")
VALUES (gen_random_uuid(), 'leave:manage', 'leave', 'Set up leave types, holidays and balance adjustments')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('SUPER_ADMIN', 'HR_MANAGER') AND p."key" = 'leave:manage'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Leave types
-- ---------------------------------------------------------------------------
CREATE TYPE "LeaveAccrual" AS ENUM ('NONE', 'YEARLY', 'MONTHLY');
CREATE TYPE "LeaveLedgerKind" AS ENUM ('GRANT', 'ACCRUAL', 'TAKEN', 'RESTORED', 'ADJUSTMENT', 'CARRY_OVER', 'EXPIRED');
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED');

CREATE TABLE "leave_types" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "paid" BOOLEAN NOT NULL DEFAULT true,
  "accrual" "LeaveAccrual" NOT NULL DEFAULT 'YEARLY',
  "days_per_year" NUMERIC(5,1) NOT NULL DEFAULT 0,
  "carry_over_max" NUMERIC(5,1) NOT NULL DEFAULT 0,
  "note_required" BOOLEAN NOT NULL DEFAULT false,
  "configured" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leave_types_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9]{1,9}$'),
  CONSTRAINT "leave_types_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60),
  CONSTRAINT "leave_types_days_check" CHECK ("days_per_year" >= 0 AND "days_per_year" <= 366 AND "days_per_year" * 2 = trunc("days_per_year" * 2)
    AND "carry_over_max" >= 0 AND "carry_over_max" <= 366 AND "carry_over_max" * 2 = trunc("carry_over_max" * 2)),
  -- Unpaid leave has no balance: no grants, no carry-over.
  CONSTRAINT "leave_types_unpaid_check" CHECK ("paid" OR ("accrual" = 'NONE' AND "days_per_year" = 0 AND "carry_over_max" = 0))
);
CREATE UNIQUE INDEX "leave_types_organization_id_code_key" ON "leave_types"("organization_id", "code");
CREATE UNIQUE INDEX "leave_types_organization_id_id_key" ON "leave_types"("organization_id", "id");
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The starting set for one organisation (0 days, not configured; Unpaid is ready).
CREATE FUNCTION "leave_seed_types"(p_org UUID) RETURNS void AS $$
  INSERT INTO "leave_types" ("organization_id", "code", "name", "paid", "accrual", "configured")
  VALUES (p_org, 'CL', 'Casual Leave', true, 'YEARLY', false),
         (p_org, 'SL', 'Sick Leave', true, 'YEARLY', false),
         (p_org, 'EL', 'Earned Leave', true, 'MONTHLY', false),
         (p_org, 'CO', 'Comp-off', true, 'NONE', false),
         (p_org, 'UL', 'Unpaid Leave', false, 'NONE', true)
  ON CONFLICT ("organization_id", "code") DO NOTHING;
$$ LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp;
SELECT "leave_seed_types"(o."id") FROM "organizations" o;

CREATE FUNCTION "seed_leave_types_for_new_org"() RETURNS trigger AS $$
BEGIN
  PERFORM "leave_seed_types"(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "organizations_seed_leave_types" AFTER INSERT ON "organizations" FOR EACH ROW EXECUTE FUNCTION "seed_leave_types_for_new_org"();

-- Code and organisation never change; updated_at is the database's.
CREATE FUNCTION "guard_leave_type"() RETURNS trigger AS $$
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NEW."code" IS DISTINCT FROM OLD."code" OR NEW."paid" IS DISTINCT FROM OLD."paid" THEN
    RAISE EXCEPTION 'leave_type_fixed_fields' USING ERRCODE = 'P0001';
  END IF;
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "leave_types_guard" BEFORE UPDATE ON "leave_types" FOR EACH ROW EXECUTE FUNCTION "guard_leave_type"();

-- ---------------------------------------------------------------------------
-- 3. Holidays
-- ---------------------------------------------------------------------------
CREATE TABLE "holidays" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  -- NULL: every outlet of the organisation.
  "outlet_id" UUID,
  "day" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "holidays_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "holidays_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX "holidays_organization_id_outlet_day_key" ON "holidays"("organization_id", COALESCE("outlet_id", '00000000-0000-0000-0000-000000000000'::UUID), "day");
CREATE INDEX "holidays_organization_id_day_idx" ON "holidays"("organization_id", "day");
ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "holidays_organization_id_outlet_id_fkey" FOREIGN KEY ("organization_id", "outlet_id") REFERENCES "outlets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. The balance ledger
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "leave_type_id" UUID NOT NULL,
  "year" SMALLINT NOT NULL,
  "kind" "LeaveLedgerKind" NOT NULL,
  -- Positive adds to the balance, negative takes from it.
  "days" NUMERIC(5,1) NOT NULL,
  -- The month an ACCRUAL is for (1-12).
  "month" SMALLINT,
  "request_id" UUID,
  "reason" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "leave_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leave_ledger_days_check" CHECK ("days" <> 0 AND "days" * 2 = trunc("days" * 2) AND abs("days") <= 400),
  CONSTRAINT "leave_ledger_year_check" CHECK ("year" BETWEEN 2000 AND 2200),
  CONSTRAINT "leave_ledger_month_check" CHECK (("kind" = 'ACCRUAL') = ("month" IS NOT NULL) AND ("month" IS NULL OR "month" BETWEEN 1 AND 12)),
  CONSTRAINT "leave_ledger_sign_check" CHECK (CASE "kind"
    WHEN 'GRANT' THEN "days" > 0 WHEN 'ACCRUAL' THEN "days" > 0 WHEN 'CARRY_OVER' THEN "days" > 0 WHEN 'RESTORED' THEN "days" > 0
    WHEN 'TAKEN' THEN "days" < 0 WHEN 'EXPIRED' THEN "days" < 0 ELSE true END),
  CONSTRAINT "leave_ledger_request_check" CHECK (("kind" IN ('TAKEN', 'RESTORED')) = ("request_id" IS NOT NULL)),
  CONSTRAINT "leave_ledger_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "leave_ledger_adjustment_reason_check" CHECK ("kind" <> 'ADJUSTMENT' OR "reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "leave_ledger_one_grant_key" ON "leave_ledger"("employee_id", "leave_type_id", "year") WHERE "kind" = 'GRANT';
CREATE UNIQUE INDEX "leave_ledger_one_accrual_key" ON "leave_ledger"("employee_id", "leave_type_id", "year", "month") WHERE "kind" = 'ACCRUAL';
CREATE UNIQUE INDEX "leave_ledger_one_carry_over_key" ON "leave_ledger"("employee_id", "leave_type_id", "year") WHERE "kind" = 'CARRY_OVER';
CREATE UNIQUE INDEX "leave_ledger_one_expiry_key" ON "leave_ledger"("employee_id", "leave_type_id", "year") WHERE "kind" = 'EXPIRED';
CREATE UNIQUE INDEX "leave_ledger_one_taken_key" ON "leave_ledger"("request_id") WHERE "kind" = 'TAKEN';
CREATE INDEX "leave_ledger_balance_idx" ON "leave_ledger"("organization_id", "employee_id", "leave_type_id", "year");
CREATE INDEX "leave_ledger_request_id_idx" ON "leave_ledger"("request_id");
ALTER TABLE "leave_ledger"
  ADD CONSTRAINT "leave_ledger_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_ledger_type_fkey" FOREIGN KEY ("organization_id", "leave_type_id") REFERENCES "leave_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_ledger_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "block_leave_ledger_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'created_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'created_by_id')
     OR (NEW."created_by_id" IS NOT NULL AND NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id") THEN
    RAISE EXCEPTION 'leave_ledger is append-only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
CREATE TRIGGER "leave_ledger_append_only" BEFORE UPDATE ON "leave_ledger" FOR EACH ROW EXECUTE FUNCTION "block_leave_ledger_updates"();
CREATE TRIGGER "leave_ledger_no_truncate" BEFORE TRUNCATE ON "leave_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "block_attendance_truncate"();

-- ---------------------------------------------------------------------------
-- 5. Leave requests
-- ---------------------------------------------------------------------------
CREATE TABLE "leave_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "leave_type_id" UUID NOT NULL,
  "start_day" DATE NOT NULL,
  "end_day" DATE NOT NULL,
  -- Leave starts at midday on the first day / ends at midday on the last day. On a one-day request either one means 0.5.
  "start_half" BOOLEAN NOT NULL DEFAULT false,
  "end_half" BOOLEAN NOT NULL DEFAULT false,
  -- Working days counted (set at request; recounted and final at approval).
  "days" NUMERIC(5,1) NOT NULL,
  "note" TEXT,
  "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" UUID,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "self_decided" BOOLEAN NOT NULL DEFAULT false,
  "cancelled_by_id" UUID,
  "cancelled_at" TIMESTAMPTZ(6),
  "cancel_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leave_requests_period_check" CHECK ("end_day" >= "start_day" AND extract(year FROM "start_day") = extract(year FROM "end_day")),
  CONSTRAINT "leave_requests_days_check" CHECK ("days" > 0 AND "days" * 2 = trunc("days" * 2)),
  CONSTRAINT "leave_requests_text_check" CHECK (("note" IS NULL OR char_length("note") BETWEEN 1 AND 500)
    AND ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 500)
    AND ("cancel_reason" IS NULL OR char_length("cancel_reason") BETWEEN 1 AND 500)),
  CONSTRAINT "leave_requests_decision_check" CHECK (("status" IN ('APPROVED', 'REJECTED', 'CANCELLED')) = ("decided_at" IS NOT NULL)
    AND ("status" <> 'REJECTED' OR "decision_note" IS NOT NULL)
    AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL))),
  CONSTRAINT "leave_requests_no_overlap" EXCLUDE USING gist ("employee_id" WITH =, daterange("start_day", "end_day", '[]') WITH &&)
    WHERE ("status" IN ('PENDING', 'APPROVED'))
);
CREATE UNIQUE INDEX "leave_requests_organization_id_id_key" ON "leave_requests"("organization_id", "id");
CREATE INDEX "leave_requests_organization_id_status_idx" ON "leave_requests"("organization_id", "status", "start_day");
CREATE INDEX "leave_requests_organization_id_employee_id_idx" ON "leave_requests"("organization_id", "employee_id", "start_day");
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_employee_fkey" FOREIGN KEY ("organization_id", "employee_id") REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_type_fkey" FOREIGN KEY ("organization_id", "leave_type_id") REFERENCES "leave_types"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "leave_requests_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_request_fkey" FOREIGN KEY ("organization_id", "request_id") REFERENCES "leave_requests"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Row-level security and rights
-- ---------------------------------------------------------------------------
ALTER TABLE "leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leave_requests" ENABLE ROW LEVEL SECURITY;

-- Types and holidays: every signed-in member of the organisation reads them; HR with leave:manage changes them.
CREATE POLICY "staff_reads" ON "leave_types" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_staff_role"()) IS NOT NULL);
CREATE POLICY "hr_adds" ON "leave_types" FOR INSERT WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:manage')));
CREATE POLICY "hr_changes" ON "leave_types" FOR UPDATE
  USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:manage')))
  WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:manage')));
CREATE POLICY "staff_reads" ON "holidays" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_staff_role"()) IS NOT NULL);
CREATE POLICY "hr_adds" ON "holidays" FOR INSERT WITH CHECK ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:manage')));
CREATE POLICY "hr_removes" ON "holidays" FOR DELETE USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:manage')));

-- Ledger and requests: HR of the organisation (leave:read) and the employee themselves read them; nobody writes them.
CREATE POLICY "hr_reads" ON "leave_ledger" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:read')));
CREATE POLICY "own_rows" ON "leave_ledger" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND "employee_id" = (SELECT "app_my_employee_id"()));
CREATE POLICY "hr_reads" ON "leave_requests" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND (SELECT "app_has_permission"('leave:read')));
CREATE POLICY "own_rows" ON "leave_requests" FOR SELECT USING ("organization_id" = (SELECT "app_org_id"()) AND "employee_id" = (SELECT "app_my_employee_id"()));

REVOKE ALL ON "leave_types", "holidays", "leave_ledger", "leave_requests" FROM hr_runtime;
GRANT SELECT ON "leave_types", "holidays", "leave_ledger", "leave_requests" TO hr_runtime;
GRANT INSERT ("id", "organization_id", "code", "name", "paid", "accrual", "days_per_year", "carry_over_max", "note_required", "configured", "is_active", "created_at", "updated_at") ON "leave_types" TO hr_runtime;
GRANT UPDATE ("name", "accrual", "days_per_year", "carry_over_max", "note_required", "configured", "is_active", "updated_at") ON "leave_types" TO hr_runtime;
GRANT INSERT ("id", "organization_id", "outlet_id", "day", "name", "created_at") ON "holidays" TO hr_runtime;
GRANT DELETE ON "holidays" TO hr_runtime;

REVOKE ALL ON FUNCTION "leave_seed_types"(UUID), "seed_leave_types_for_new_org"(), "guard_leave_type"(), "block_leave_ledger_updates"() FROM PUBLIC;

COMMIT;
