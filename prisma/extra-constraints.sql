-- ============================================================================
-- Extra database rules that Prisma's schema language cannot express (v2).
-- These are appended to the first migration (see setup instructions).
-- ============================================================================

-- 1. Prevent duplicate scheduling: only one non-cancelled interview per round
CREATE UNIQUE INDEX "interviews_one_active_per_round"
  ON "interviews" ("application_id", "round_number")
  WHERE "status" <> 'CANCELLED';

-- 2. At most one active offer per application (Draft, Issued or Accepted)
CREATE UNIQUE INDEX "offers_one_active_per_application"
  ON "offers" ("application_id")
  WHERE "status" IN ('DRAFT', 'ISSUED', 'ACCEPTED');

-- 3. Value checks so bad data cannot get in even if app code has a bug
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "job_openings"
  ADD CONSTRAINT "job_openings_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "job_openings_openings_positive" CHECK ("openings_count" >= 1),
  ADD CONSTRAINT "job_openings_compensation_range" CHECK
    ("compensation_min" IS NULL OR "compensation_max" IS NULL OR "compensation_max" >= "compensation_min"),
  ADD CONSTRAINT "job_openings_internship_months_positive" CHECK
    ("internship_months" IS NULL OR "internship_months" > 0);

ALTER TABLE "candidate_educations"
  ADD CONSTRAINT "candidate_educations_year_range" CHECK
    ("graduation_year" IS NULL OR "graduation_year" BETWEEN 1950 AND 2100);

ALTER TABLE "interviews"
  ADD CONSTRAINT "interviews_end_after_start" CHECK ("scheduled_end" > "scheduled_start"),
  ADD CONSTRAINT "interviews_round_positive" CHECK ("round_number" >= 1);

ALTER TABLE "interview_feedback"
  ADD CONSTRAINT "interview_feedback_ratings_1_to_5" CHECK (
    ("technical_knowledge" IS NULL OR "technical_knowledge" BETWEEN 1 AND 5) AND
    ("communication"       IS NULL OR "communication"       BETWEEN 1 AND 5) AND
    ("problem_solving"     IS NULL OR "problem_solving"     BETWEEN 1 AND 5) AND
    ("confidence"          IS NULL OR "confidence"          BETWEEN 1 AND 5) AND
    ("relevant_experience" IS NULL OR "relevant_experience" BETWEEN 1 AND 5) AND
    ("role_suitability"    IS NULL OR "role_suitability"    BETWEEN 1 AND 5) AND
    ("overall_rating"      IS NULL OR "overall_rating"      BETWEEN 1 AND 5)
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_amount_not_negative" CHECK ("compensation_amount" >= 0);

ALTER TABLE "candidate_documents"
  ADD CONSTRAINT "candidate_documents_size_positive" CHECK ("size_bytes" > 0),
  -- a file attached to an application must say which organization it belongs to
  ADD CONSTRAINT "candidate_documents_application_needs_org" CHECK
    ("application_id" IS NULL OR "organization_id" IS NOT NULL);

ALTER TABLE "form_fields"
  ADD CONSTRAINT "form_fields_position_not_negative" CHECK ("position" >= 0);

-- An INTERNAL candidate must have an employee link or a stated employee code
ALTER TABLE "organization_candidates"
  ADD CONSTRAINT "organization_candidates_internal_needs_reference" CHECK
    ("candidate_type" = 'EXTERNAL' OR "employee_link_id" IS NOT NULL OR "claimed_employee_code" IS NOT NULL);

ALTER TABLE "integration_sync_jobs"
  ADD CONSTRAINT "integration_sync_jobs_attempts_valid" CHECK
    ("attempt_count" >= 0 AND "max_attempts" >= 1 AND "attempt_count" <= "max_attempts");

-- 4. History and audit records cannot be silently rewritten.
--    The only allowed change is clearing the actor (when a user is removed).
CREATE FUNCTION "block_record_changes"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only: rows cannot be deleted', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - 'actor_user_id' - 'changed_by_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'actor_user_id' - 'changed_by_id') THEN
    RAISE EXCEPTION '% is append-only: rows cannot be modified', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();

-- Failed sync attempts are a permanent record too
CREATE TRIGGER "integration_sync_errors_append_only"
  BEFORE UPDATE OR DELETE ON "integration_sync_errors"
  FOR EACH ROW EXECUTE FUNCTION "block_record_changes"();

-- Status history: edits are blocked; deletes are allowed only through cascades
-- (so test data can be cleaned up), never by normal application code.
CREATE FUNCTION "block_history_updates"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'changed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'changed_by_id') THEN
    RAISE EXCEPTION 'application_status_history is append-only: rows cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "application_status_history_no_update"
  BEFORE UPDATE ON "application_status_history"
  FOR EACH ROW EXECUTE FUNCTION "block_history_updates"();

-- 5. A candidate can only share THEIR OWN files with an application
CREATE FUNCTION "check_application_document_owner"() RETURNS trigger AS $$
DECLARE
  doc_candidate uuid;
  app_candidate uuid;
BEGIN
  SELECT "candidate_id" INTO doc_candidate FROM "candidate_documents" WHERE "id" = NEW."document_id";
  SELECT oc."candidate_id" INTO app_candidate
    FROM "applications" a
    JOIN "organization_candidates" oc ON oc."id" = a."organization_candidate_id"
   WHERE a."id" = NEW."application_id";
  IF doc_candidate IS DISTINCT FROM app_candidate THEN
    RAISE EXCEPTION 'document does not belong to the candidate who made this application';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "application_documents_owner_check"
  BEFORE INSERT OR UPDATE ON "application_documents"
  FOR EACH ROW EXECUTE FUNCTION "check_application_document_owner"();
