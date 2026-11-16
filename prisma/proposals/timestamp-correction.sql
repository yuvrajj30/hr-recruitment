-- TIMESTAMP CORRECTION, FINAL VERSION FOR REVIEW. NOT A MIGRATION (it lives outside prisma/migrations so nothing can
-- apply it by accident). It is run ONLY by scripts/tz-ops/tz-ops.cjs "apply", which also verifies every value inside
-- the same transaction and commits only if all checks pass. Running it on the real database needs explicit approval.
--
-- Why: while database sessions used Asia/Calcutta, the Prisma pg adapter sent instants without their offset, so
-- PostgreSQL stored every application-written timestamp 5 h 30 min EARLY. This moves them forward by 5 h 30 min.
--
-- Written for the real database as it is now: migrations applied up to 20261115090000_m3_applications_pipeline, so
-- every stored timestamp was written by the application EXCEPT permissions.created_at of "document:read" (stamped by
-- that migration's own clock, already correct, left unchanged). It refuses to run in any other state.
--
-- Approved approach (in principle):
--   * Audit log (Option A): NOT modified. Each existing row gets a correction note; audit_logs_display shows the
--     corrected time. The original records stay exactly as written.
--   * application_status_history and application_assignments: ONE-TIME DOCUMENTED EXCEPTION. Only their created_at
--     is shifted; every other field is preserved; their append-only triggers are disabled for this transaction only
--     and re-enabled before it ends.
--   * Everything else: application-written timestamps moved forward by 5 h 30 min.
-- The caller (tz-ops.cjs) wraps this in BEGIN ... verification ... COMMIT/ROLLBACK.

-- ---------------------------------------------------------------------------
-- 0. Refuse to run in any state other than the one this was written and rehearsed for
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  already_applied BOOLEAN := FALSE;
BEGIN
  IF current_setting('TimeZone') <> 'UTC' THEN
    RAISE EXCEPTION 'run this with a UTC session (the operations tool does)';
  END IF;
  IF to_regclass('public.staff_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'later migrations are already applied; this correction is only valid before them';
  END IF;
  -- Dynamic SQL: the table may not exist yet, and a static reference would fail before the check runs.
  IF to_regclass('public.timestamp_corrections') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "timestamp_corrections")' INTO already_applied;
  END IF;
  IF already_applied THEN
    RAISE EXCEPTION 'the timestamp correction has already been applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '20261115090000_m3_applications_pipeline' AND "finished_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'expected migration 20261115090000_m3_applications_pipeline to be applied';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Correction records (same definitions as migration 20261116000000_timestamp_correction_objects)
-- ---------------------------------------------------------------------------
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
-- security_invoker: the audit log's own access rules apply through the view (without it, a view runs with its
-- owner's rights and would bypass row-level security on audit_logs).
CREATE OR REPLACE VIEW "audit_logs_display" WITH (security_invoker = true) AS
SELECT a.*, a."created_at" + COALESCE(c."shift", interval '0') AS "display_created_at"
FROM "audit_logs" a LEFT JOIN "audit_log_time_corrections" c ON c."audit_log_id" = a."id";
CREATE OR REPLACE TRIGGER "audit_log_time_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log_time_corrections"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();
CREATE OR REPLACE TRIGGER "timestamp_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "timestamp_corrections"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();
-- The app's restricted account gets NO rights on these here (new tables would otherwise inherit its default
-- read/write rights). The app is stopped at this point; the migrations that follow set the final rights:
-- migration 20261116010000_security_hardening lets it read the notes and the view only, each note only
-- together with the audit row it belongs to, and nothing of timestamp_corrections.
REVOKE ALL ON "timestamp_corrections", "audit_log_time_corrections", "audit_logs_display" FROM hr_runtime;

INSERT INTO "timestamp_corrections" ("shift", "description") VALUES
  (interval '5 hours 30 minutes', 'Application-written timestamps were stored 5h30 early while database sessions used Asia/Calcutta. Shifted forward. Audit log rows corrected through audit_log_time_corrections (Option A). One-time documented exception: application_status_history.created_at and application_assignments.created_at.');

-- ---------------------------------------------------------------------------
-- 2. Application-written timestamps: forward by 5 h 30 min (NULLs stay NULL)
-- ---------------------------------------------------------------------------
UPDATE "users" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                   "updated_at" = "updated_at" + interval '5 hours 30 minutes',
                   "last_login_at" = "last_login_at" + interval '5 hours 30 minutes';
UPDATE "organizations" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                           "updated_at" = "updated_at" + interval '5 hours 30 minutes';
UPDATE "organization_members" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                                  "joined_at" = "joined_at" + interval '5 hours 30 minutes',
                                  "updated_at" = "updated_at" + interval '5 hours 30 minutes';
UPDATE "organization_member_roles" SET "assigned_at" = "assigned_at" + interval '5 hours 30 minutes';
UPDATE "roles" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "permissions" SET "created_at" = "created_at" + interval '5 hours 30 minutes' WHERE "key" <> 'document:read';
UPDATE "sessions" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                      "last_seen_at" = "last_seen_at" + interval '5 hours 30 minutes',
                      "expires_at" = "expires_at" + interval '5 hours 30 minutes',
                      "absolute_expires_at" = "absolute_expires_at" + interval '5 hours 30 minutes',
                      "revoked_at" = "revoked_at" + interval '5 hours 30 minutes';
UPDATE "auth_login_attempts" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "job_openings" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                          "updated_at" = "updated_at" + interval '5 hours 30 minutes',
                          "published_at" = "published_at" + interval '5 hours 30 minutes',
                          "closed_at" = "closed_at" + interval '5 hours 30 minutes',
                          "application_deadline" = "application_deadline" + interval '5 hours 30 minutes';
UPDATE "applications" SET "applied_at" = "applied_at" + interval '5 hours 30 minutes',
                          "consent_accepted_at" = "consent_accepted_at" + interval '5 hours 30 minutes',
                          "created_at" = "created_at" + interval '5 hours 30 minutes',
                          "stage_changed_at" = "stage_changed_at" + interval '5 hours 30 minutes',
                          "updated_at" = "updated_at" + interval '5 hours 30 minutes';
UPDATE "application_notes" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "organization_candidates" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                                     "first_seen_at" = "first_seen_at" + interval '5 hours 30 minutes',
                                     "updated_at" = "updated_at" + interval '5 hours 30 minutes',
                                     "internal_verified_at" = "internal_verified_at" + interval '5 hours 30 minutes';
UPDATE "candidate_profiles" SET "created_at" = "created_at" + interval '5 hours 30 minutes',
                                "updated_at" = "updated_at" + interval '5 hours 30 minutes',
                                "email_verified_at" = "email_verified_at" + interval '5 hours 30 minutes',
                                "anonymized_at" = "anonymized_at" + interval '5 hours 30 minutes';
UPDATE "candidate_educations" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "candidate_experiences" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "candidate_skills" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
UPDATE "candidate_documents" SET "uploaded_at" = "uploaded_at" + interval '5 hours 30 minutes',
                                 "deleted_at" = "deleted_at" + interval '5 hours 30 minutes';

-- ---------------------------------------------------------------------------
-- 3. ONE-TIME DOCUMENTED EXCEPTION: append-only history shown in the application timeline
-- ---------------------------------------------------------------------------
-- Only created_at changes; every other field is preserved. The protective triggers are disabled for this
-- transaction only and re-enabled immediately (the operations tool verifies they are enabled before committing).
ALTER TABLE "application_status_history" DISABLE TRIGGER "application_status_history_no_update";
UPDATE "application_status_history" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
ALTER TABLE "application_status_history" ENABLE TRIGGER "application_status_history_no_update";

ALTER TABLE "application_assignments" DISABLE TRIGGER "application_assignments_no_update";
UPDATE "application_assignments" SET "created_at" = "created_at" + interval '5 hours 30 minutes';
ALTER TABLE "application_assignments" ENABLE TRIGGER "application_assignments_no_update";

-- ---------------------------------------------------------------------------
-- 4. Audit log (Option A): NOT modified; a correction note for every existing row
-- ---------------------------------------------------------------------------
INSERT INTO "audit_log_time_corrections" ("audit_log_id", "shift")
SELECT "id", interval '5 hours 30 minutes' FROM "audit_logs";

-- A permanent record of the correction and of the exception (stamped by PostgreSQL's clock: correct time).
INSERT INTO "audit_logs" ("id", "organization_id", "actor_user_id", "actor_label", "action", "entity_type", "entity_id", "metadata")
SELECT gen_random_uuid(), o."id", NULL, 'timestamp correction', 'maintenance.timestamps_corrected', 'organization', o."id"::TEXT,
       jsonb_build_object('shift', '5 hours 30 minutes',
                          'appendOnlyException', jsonb_build_array('application_status_history.created_at', 'application_assignments.created_at'),
                          'auditRowsCorrectedByView', (SELECT count(*) FROM "audit_log_time_corrections"))
FROM "organizations" o;
