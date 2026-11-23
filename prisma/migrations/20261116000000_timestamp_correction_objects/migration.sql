-- The structure used by the one-time timestamp correction (prisma/proposals/timestamp-correction.sql), so every
-- database has it: on the real database the correction creates these first and this migration changes nothing; on
-- the test database and any new database it creates them EMPTY (no correction applies there).
-- Everything is idempotent ("if not exists" / "or replace"). No data is changed by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS "timestamp_corrections" (
  "id" SERIAL PRIMARY KEY,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shift" INTERVAL NOT NULL,
  "description" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "audit_log_time_corrections" (
  "audit_log_id" UUID NOT NULL,
  "shift" INTERVAL NOT NULL,
  CONSTRAINT "audit_log_time_corrections_pkey" PRIMARY KEY ("audit_log_id"),
  CONSTRAINT "audit_log_time_corrections_audit_log_id_fkey" FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- security_invoker: the audit log's own row-level security applies through the view.
CREATE OR REPLACE VIEW "audit_logs_display" WITH (security_invoker = true) AS
SELECT a.*, a."created_at" + COALESCE(c."shift", interval '0') AS "display_created_at"
FROM "audit_logs" a LEFT JOIN "audit_log_time_corrections" c ON c."audit_log_id" = a."id";

-- Both are permanent records, like the audit log itself.
CREATE OR REPLACE TRIGGER "audit_log_time_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log_time_corrections"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();
CREATE OR REPLACE TRIGGER "timestamp_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "timestamp_corrections"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();

GRANT SELECT ON "timestamp_corrections", "audit_log_time_corrections", "audit_logs_display" TO hr_runtime;

COMMIT;
